import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { SessionId } from "./ids.js";
import type { RexCli } from "./rex.js";

export interface LoggedEvent {
  seq: number;
  at: string;
  event: unknown;
}

export interface EventFilter {
  session?: SessionId;
  types?: readonly string[];
}

export interface PollResult {
  events: LoggedEvent[];
  cursor: number;
  dropped?: true;
}

interface RawEvent {
  type?: string;
  payload?: { session_id?: string; session?: { session_id?: string }; event?: { type?: string } };
}

function matches(event: unknown, filter: EventFilter): boolean {
  const e = event as RawEvent;
  if (filter.session) {
    const session = e.payload?.session_id ?? e.payload?.session?.session_id;
    if (session !== filter.session) return false;
  }
  if (filter.types?.length) {
    return filter.types.some((t) => t === e.type || t === e.payload?.event?.type);
  }
  return true;
}

const MAX_BACKOFF_MS = 30_000;

export class EventLog {
  private readonly buffer: LoggedEvent[] = [];
  private nextSeq = 1;
  private readonly waiters = new Set<() => void>();
  private child?: ChildProcess;
  private stopped = false;
  private backoffMs = 500;

  constructor(
    private readonly rex: RexCli,
    private readonly capacity = 5000,
  ) {}

  start(): void {
    const child = this.rex.stream(["events", "--all", "--json"]);
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      this.backoffMs = 500;
      try {
        this.push(JSON.parse(line));
      } catch {
        this.push({ type: "rex_mcp_unparsed", line });
      }
    });
    child.on("error", () => {});
    child.on("close", () => {
      if (this.stopped) return;
      setTimeout(() => this.start(), this.backoffMs).unref();
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }

  private push(event: unknown): void {
    this.buffer.push({ seq: this.nextSeq++, at: new Date().toISOString(), event });
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const wake of this.waiters) wake();
  }

  async poll(cursor: number, waitMs: number, filter: EventFilter, limit: number): Promise<PollResult> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const oldest = this.buffer[0]?.seq ?? this.nextSeq;
      const dropped = cursor < oldest - 1;
      const after = this.buffer.filter((e) => e.seq > cursor);
      const found = after.filter((e) => matches(e.event, filter));
      const events = found.slice(0, limit);
      const remaining = deadline - Date.now();
      if (events.length || dropped || remaining <= 0) {
        const next = found.length > limit ? events[events.length - 1]!.seq : (after[after.length - 1]?.seq ?? cursor);
        return dropped ? { events, cursor: next, dropped: true } : { events, cursor: next };
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }
}
