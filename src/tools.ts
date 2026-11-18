import { z, type ZodRawShape } from "zod";
import type { Config } from "./config.js";
import type { EventLog } from "./events.js";
import { effectiveProtectedLabels } from "./close.js";
import { parseBlockId, parseSessionId, type BlockId, type SessionId } from "./ids.js";
import { classifyBlockMethod, classifyMethod } from "./methods.js";
import type { Ownership } from "./ownership.js";
import type { Access, Caller, Rule, SessionRef } from "./policy.js";
import { RexError, type RexCli } from "./rex.js";

export interface Core {
  rex: RexCli;
  config: Config;
  owned: Ownership;
  events: EventLog;
}

export interface Target {
  session?: SessionRef;
  block?: BlockId;
}

export interface Ctx extends Core {
  caller: Caller;
  target: Target;
  authorize(rule: Rule, sessions: readonly SessionRef[], method?: string): void;
}

export interface Tool<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  access: Access | "dynamic";
  input: S;
  handler(args: z.infer<z.ZodObject<S>>, ctx: Ctx): Promise<unknown>;
}

const tool = <S extends ZodRawShape>(t: Tool<S>) => t as unknown as Tool;

interface ResolvedTarget {
  kind: string;
  session_id?: string;
  block_id?: string;
  label: string;
}

async function resolveOne(rex: RexCli, kind: string, query: string, scopeSession?: string): Promise<ResolvedTarget> {
  const request = { kinds: [kind], queries: [query], ...(scopeSession ? { scope: { session: scopeSession } } : {}) };
  const res = await rex.json<{ results: { status: string; reason?: string; target?: ResolvedTarget }[] }>(
    ["api", "call", "target.resolve", "-"],
    { stdin: JSON.stringify(request) },
  );
  const r = res.results[0];
  if (r?.status !== "resolved" || !r.target) {
    throw new Error(`target: ${kind} ${JSON.stringify(query)} is ${r?.status ?? "unresolved"}${r?.reason ? `: ${r.reason}` : ""}`);
  }
  return r.target;
}

export async function resolveSession(rex: RexCli, query: string): Promise<SessionRef> {
  const t = await resolveOne(rex, "session", query);
  return { id: parseSessionId(t.session_id), label: t.label };
}

export async function resolveTarget(rex: RexCli, args: Record<string, unknown>): Promise<Target> {
  const session = typeof args.session === "string" ? args.session : undefined;
  const block = typeof args.block === "string" ? args.block : typeof args.anchor_block === "string" ? args.anchor_block : undefined;
  if (block) {
    const b = await resolveOne(rex, "block", block, session);
    return { session: await resolveSession(rex, String(b.session_id)), block: parseBlockId(b.block_id) };
  }
  return session ? { session: await resolveSession(rex, session) } : {};
}

function requireSession(ctx: Ctx): SessionId {
  if (!ctx.target.session) throw new Error("input: this tool needs `session` (or a `block` that names one)");
  return ctx.target.session.id;
}

function requireBlock(ctx: Ctx): BlockId {
  if (!ctx.target.block) throw new Error("input: this tool needs `block`");
  return ctx.target.block;
}

function scope(ctx: Ctx): string[] {
  return [
    ...(ctx.target.session ? ["-s", ctx.target.session.id] : []),
    ...(ctx.target.block ? ["-b", ctx.target.block] : []),
  ];
}

async function pruneOwned(ctx: Ctx): Promise<void> {
  const { sessions } = await ctx.rex.json<{ sessions: { session_id: string }[] }>(["ls", "--json"]);
  ctx.owned.prune(new Set(sessions.map((s) => parseSessionId(s.session_id))));
}

async function liveSessions(ctx: Ctx) {
  const { sessions } = await ctx.rex.json<{ sessions: { session_id: string; label: string }[] }>(["ls", "--json"]);
  ctx.owned.prune(new Set(sessions.map((s) => parseSessionId(s.session_id))));
  return sessions.map((s) => ({ ...s, owned: ctx.owned.has(s.session_id as SessionId) }));
}

interface CaptureOptions {
  format?: "text" | "html" | "vt";
  tail_lines?: number;
  unwrap?: boolean;
  max_bytes?: number;
}

async function captureAt(rex: RexCli, session: SessionId, block: BlockId | undefined, o: CaptureOptions): Promise<string> {
  const args = [
    "capture", "-s", session, ...(block ? ["-b", block] : []),
    "--trim", `--format=${o.format ?? "text"}`, ...(o.unwrap ? ["--unwrap"] : []),
  ];
  let text = await rex.run(args);
  if (o.tail_lines !== undefined) text = text.replace(/\n$/, "").split("\n").slice(-o.tail_lines).join("\n");
  const bytes = Buffer.from(text);
  const max = o.max_bytes ?? 200_000;
  if (bytes.length <= max) return text;
  return `[rex-mcp: truncated ${bytes.length - max} bytes from the front]\n${bytes.subarray(bytes.length - max).toString()}`;
}

async function capture(ctx: Ctx, o: CaptureOptions): Promise<string> {
  return captureAt(ctx.rex, requireSession(ctx), ctx.target.block, o);
}

export interface RunCreated {
  block_ids?: string[];
  window_id?: string;
}

/** Rex writes the creation JSON, then waits. A second line, if any, is not the creation result. */
export function parseRunCreated(stdout: string): RunCreated | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  for (const candidate of [trimmed, trimmed.split("\n")[0] ?? ""]) {
    try {
      const value = JSON.parse(candidate) as RunCreated;
      if (value && typeof value === "object") return value;
    } catch {
      // try the other shape
    }
  }
  return undefined;
}

export function rexRunArgs(input: {
  session: string;
  block?: string;
  cwd?: string;
  split?: string;
  ratio?: number;
  label?: string;
  keepOpen?: boolean;
  wait?: boolean;
  command: readonly string[];
}): string[] {
  return [
    "run", "--json", "--focus=false", "-s", input.session,
    ...(input.block ? ["-b", input.block] : []),
    ...(input.cwd ? ["-c", input.cwd] : []),
    ...(input.split ? [`--split=${input.split}`] : []),
    ...(input.ratio !== undefined ? ["--ratio", String(input.ratio)] : []),
    ...(input.label ? ["--label", input.label] : []),
    // A waited run holds the block open so its output can be captured, then closes it.
    ...(input.keepOpen || input.wait ? ["--keep-open"] : []),
    ...(input.wait ? ["--wait"] : []),
    "--",
    ...input.command,
  ];
}

function rememberBlocks(ctx: Ctx, session: SessionId, ids: readonly string[] | undefined): void {
  for (const id of ids ?? []) {
    if (id.startsWith("block:")) ctx.owned.addBlock(parseBlockId(id), session);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function closeCreated(ctx: Ctx, session: SessionId, created: RunCreated, closeWindow: boolean): Promise<void> {
  const ids = (created.block_ids ?? []).filter((id) => id.startsWith("block:"));
  for (const id of ids) {
    await ctx.rex.run(["block", "close", "-s", session, id]);
    ctx.owned.removeBlock(parseBlockId(id));
  }
  // block.close already closes a window whose last block went away. If Rex left
  // the window behind, close it only when nothing else is still in it. A
  // failure here does not undo the block close.
  if (!closeWindow || !created.window_id?.startsWith("window:")) return;
  try {
    const { blocks } = await ctx.rex.json<{ blocks: { window_id?: string }[] }>(["block", "ls", "-s", session, "--json"]);
    if (blocks.some((b) => b.window_id === created.window_id)) return;
    await ctx.rex.run(["window", "close", "-s", session, created.window_id]);
  } catch {
    // The window already closed with its last block.
  }
}

async function waitExit(ctx: Ctx, block: BlockId, timeoutSeconds: number) {
  const args = ["wait", "-s", requireSession(ctx), block, "--for", `${timeoutSeconds}s`, "--json"];
  const r = await ctx.rex.exec(args, { timeoutMs: (timeoutSeconds + 15) * 1000 });
  const payload = r.stdout.trim() ? (JSON.parse(r.stdout) as { exit_code?: number }) : undefined;
  if (typeof payload?.exit_code === "number") return { done: true, timed_out: false, exit_code: payload.exit_code };
  if (/timed out/.test(r.stderr)) return { done: false, timed_out: true };
  if (r.code === 0) return { done: true, timed_out: false };
  throw new RexError(args, r.code, r.stderr, r.stdout);
}

const session = z.string().describe("Session label or ID");
const block = z.string().describe("Block label, ID, or ID suffix");
const command = z.array(z.string()).min(1).describe("Program and arguments, one word per element");

export const tools: Tool[] = [
  tool({
    name: "rex_status",
    description: "Rex server identity and version, the sessions rex-mcp owns, and the active policy flags.",
    access: "read",
    input: {},
    async handler(_, ctx) {
      const [whoami, version] = await Promise.all([
        ctx.rex.json(["whoami", "--json"]),
        ctx.rex.json(["api", "call", "server.version"]),
        pruneOwned(ctx),
      ]);
      const { writeAllowlist, unblockMethods, allowLua, allowClientActions, server } = ctx.config;
      return {
        whoami,
        version,
        owned: ctx.owned.list(),
        blocks: ctx.owned.listBlocks(),
        policy: {
          writeAllowlist,
          unblockMethods,
          allowLua,
          allowClientActions,
          server: server ?? "local",
          protectedSessionLabels: effectiveProtectedLabels(ctx.config.protectedSessionLabels),
        },
      };
    },
  }),
  tool({
    name: "rex_list",
    description: "List sessions, windows, blocks, or clients. `session` is required for windows and blocks.",
    access: "read",
    input: { kind: z.enum(["sessions", "windows", "blocks", "clients"]), session: session.optional() },
    async handler({ kind }, ctx) {
      switch (kind) {
        case "sessions":
          return { sessions: await liveSessions(ctx) };
        case "windows":
          return ctx.rex.json(["window", "ls", "-s", requireSession(ctx), "--json"]);
        case "blocks":
          return ctx.rex.json(["block", "ls", "-s", requireSession(ctx), "--json"]);
        case "clients":
          return ctx.rex.json(["client", "ls", ...scope(ctx), "--json"]);
      }
    },
  }),
  tool({
    name: "rex_session_view",
    description: "Snapshot of a session: windows, layouts, blocks, focus (session.view).",
    access: "read",
    input: { session },
    handler: (_, ctx) => ctx.rex.json(["api", "call", "-s", requireSession(ctx), "session.view"]),
  }),
  tool({
    name: "rex_capture",
    description:
      "Screen and scrollback of a terminal block. Without `block`, the focused block of the session's default window.",
    access: "read",
    input: {
      session: session.optional(),
      block: block.optional(),
      format: z.enum(["text", "html", "vt"]).optional(),
      tail_lines: z.number().int().positive().optional(),
      unwrap: z.boolean().optional(),
      max_bytes: z.number().int().positive().optional().describe("Default 200000; truncated from the front"),
    },
    async handler(args, ctx) {
      requireSession(ctx);
      return capture(ctx, args);
    },
  }),
  tool({
    name: "rex_block_info",
    description: "Block details and methods (rex block inspect), plus the terminal process state.",
    access: "read",
    input: { session: session.optional(), block: block.optional() },
    async handler(_, ctx) {
      const s = requireSession(ctx);
      const inspect = await ctx.rex.json<{ block: { block_id: string; creator_name?: string } }>([
        "block", "inspect", "-s", s, ...(ctx.target.block ? [ctx.target.block] : []), "--json",
      ]);
      const process =
        inspect.block.creator_name === "com.superlogical.terminal"
          ? await ctx.rex.json(["block", "call", "-s", s, "-b", inspect.block.block_id, "process"])
          : null;
      return { ...inspect, process };
    },
  }),
  tool({
    name: "rex_send_text",
    description: "Type text into a terminal (rex send, text on stdin). `enter: true` presses Return afterwards.",
    access: "write-session",
    input: { session: session.optional(), block: block.optional(), text: z.string(), enter: z.boolean().optional() },
    async handler({ text, enter }, ctx) {
      await ctx.rex.run(["send", ...scope(ctx)], { stdin: text });
      if (enter) await ctx.rex.run(["send-key", ...scope(ctx), "enter"]);
      return { sent: true };
    },
  }),
  tool({
    name: "rex_send_keys",
    description: "Press keys in a terminal (rex send-key), e.g. [\"ctrl+c\"] or [\"enter\"].",
    access: "write-session",
    input: { session: session.optional(), block: block.optional(), keys: z.array(z.string()).min(1) },
    async handler({ keys }, ctx) {
      await ctx.rex.run(["send-key", ...scope(ctx), ...keys]);
      return { sent: true };
    },
  }),
  tool({
    name: "rex_run",
    description:
      "Run a command in a new block (a new window, or a split beside `anchor_block`). Never takes focus. With `wait_seconds`, wait until the command exits, return its screen as `output`, and close the block (and its window, when this block was the only one). That is the default for a one-off command. Set `keep_open` true to leave the block up after it exits, for a dev server or an interactive agent. If the wait times out, the program is still running and the block stays open; close it with rex_block_close if you are done with it. Without `wait_seconds` the call returns once the block exists and does not close it. Rex closes that block when the program exits, unless `keep_open` is true. Nothing is closed for being idle. A long-lived program closes its own block when it finishes by running `rex-mcp close` (see the README). That command refuses wispy-fjord, tmux session claude-rc, and claude --remote-control.",
    access: "write-session",
    input: {
      session: session.optional(),
      command,
      cwd: z.string().optional(),
      split: z.enum(["right", "left", "above", "below"]).optional(),
      anchor_block: block.optional(),
      ratio: z.number().int().min(1).max(99).optional(),
      label: z.string().optional(),
      keep_open: z.boolean().optional(),
      wait_seconds: z.number().positive().max(3600).optional(),
    },
    async handler(a, ctx) {
      const session = requireSession(ctx);
      const argv = rexRunArgs({
        session,
        block: ctx.target.block,
        cwd: a.cwd,
        split: a.split,
        ratio: a.ratio,
        label: a.label,
        keepOpen: a.keep_open,
        wait: a.wait_seconds !== undefined,
        command: a.command,
      });
      if (a.wait_seconds === undefined) {
        const created = await ctx.rex.json<RunCreated>(argv);
        if (created?.block_ids) rememberBlocks(ctx, session, created.block_ids);
        return created ? { ...created, closed: false } : created;
      }
      const r = await ctx.rex.exec(argv, { timeoutMs: a.wait_seconds * 1000 });
      const created = parseRunCreated(r.stdout);
      if (!created) throw new RexError(argv, r.code, r.stderr, r.stdout);
      rememberBlocks(ctx, session, created.block_ids);
      const blockId = created.block_ids?.find((id) => id.startsWith("block:"));
      let output: string | undefined;
      let captureError: string | undefined;
      if (blockId) {
        try {
          output = await captureAt(ctx.rex, session, parseBlockId(blockId), { unwrap: true });
        } catch (err) {
          captureError = errorText(err);
        }
      }
      let closed = false;
      let closeError: string | undefined;
      // A timeout means the program is still running. Leave it. keep_open leaves it after exit too.
      if (!r.timedOut && a.keep_open !== true) {
        try {
          await closeCreated(ctx, session, created, !a.split);
          closed = true;
        } catch (err) {
          closeError = errorText(err);
        }
      }
      const wait = r.timedOut
        ? { done: false as const, timed_out: true as const }
        : { done: true as const, timed_out: false as const, exit_code: r.code };
      return {
        ...created,
        output,
        ...(captureError ? { capture_error: captureError } : {}),
        closed,
        ...(closeError ? { close_error: closeError } : {}),
        wait,
      };
    },
  }),
  tool({
    name: "rex_session_create",
    description:
      "Create a session (rex new). rex-mcp owns it, so it may write to it. Returns its ID and first block ID. The session stays up for as long as its programs do; it is not closed for being idle. Prefer rex_run with wait_seconds for a one-off command, which closes that block when the command exits. A program in this session can close its own block when it finishes by running `rex-mcp close`.",
    access: "create",
    input: {
      label: z.string().optional(),
      cwd: z.string().optional(),
      window: z.string().optional().describe("Label for the first window"),
      command: command.optional(),
    },
    async handler(a, ctx) {
      const created = await ctx.rex.json<{
        session_id: string;
        initial_windows: { window_id: string; block_ids: string[] }[];
      }>([
        "new", ...(a.label ? [a.label] : []), "--json",
        ...(a.cwd ? ["-c", a.cwd] : []),
        ...(a.window ? ["--window", a.window] : []),
        ...(a.command ? ["--", ...a.command] : []),
      ]);
      const id = parseSessionId(created.session_id);
      ctx.owned.add(id);
      for (const window of created.initial_windows) rememberBlocks(ctx, id, window.block_ids);
      const first = created.initial_windows[0];
      return { ...created, session_id: id, window_id: first?.window_id, block_id: first?.block_ids[0] };
    },
  }),
  tool({
    name: "rex_session_kill",
    description: "Kill a session (rex kill) and drop it from the owned set.",
    access: "write-session",
    input: { session },
    async handler(_, ctx) {
      const id = requireSession(ctx);
      await ctx.rex.run(["kill", id]);
      ctx.owned.remove(id);
      return { killed: id };
    },
  }),
  tool({
    name: "rex_block_close",
    description:
      "Close a block and end its program (rex block close). Rex closes the window too when that was its last block. Never closes a block for being idle, and never closes any other block.",
    access: "write-session",
    input: { session: session.optional(), block },
    async handler(_, ctx) {
      await ctx.rex.run(["block", "close", "-s", requireSession(ctx), requireBlock(ctx)]);
      return { closed: ctx.target.block };
    },
  }),
  tool({
    name: "rex_events_poll",
    description:
      "Long-poll buffered Rex server events after `cursor` (0 = oldest). Returns events and the next cursor; `dropped: true` means events after your cursor fell out of the buffer.",
    access: "read",
    input: {
      cursor: z.number().int().min(0).optional(),
      wait_ms: z.number().int().min(0).max(60_000).optional(),
      session: session.optional(),
      types: z.array(z.string()).optional().describe("Match the event type or a session_event's inner type"),
      limit: z.number().int().positive().max(5000).optional(),
    },
    handler: (a, ctx) =>
      ctx.events.poll(a.cursor ?? 0, a.wait_ms ?? 0, { session: ctx.target.session?.id, types: a.types }, a.limit ?? 500),
  }),
  tool({
    name: "rex_wait",
    description:
      "Wait on a block. `until: exit` waits for the terminal's program to exit; `until: match` polls the capture for `pattern` (a JS regex). Returns {done, timed_out, exit_code?, match?}.",
    access: "read",
    input: {
      session: session.optional(),
      block,
      until: z.enum(["exit", "match"]),
      pattern: z.string().optional(),
      timeout_seconds: z.number().positive().max(3600).optional(),
    },
    async handler(a, ctx) {
      const timeout = a.timeout_seconds ?? 30;
      const b = requireBlock(ctx);
      if (a.until === "exit") return waitExit(ctx, b, timeout);
      if (a.pattern === undefined) throw new Error("input: `until: match` needs `pattern`");
      const re = new RegExp(a.pattern, "m");
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        const m = re.exec(await capture(ctx, { unwrap: true }));
        if (m) return { done: true, timed_out: false, match: m[0] };
        if (Date.now() >= deadline) return { done: false, timed_out: true };
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  }),
  tool({
    name: "rex_api_list",
    description: "API methods the server offers, each tagged with its rex-mcp policy class.",
    access: "read",
    input: {},
    async handler(_, ctx) {
      const help = await ctx.rex.json<{
        methods: { name: string; description?: string }[];
        block_types: { creator: string; methods?: { name: string; description?: string }[] }[];
      }>(["api", "list", "--json"]);
      return {
        methods: help.methods.map((m) => ({
          method: m.name,
          class: classifyMethod(m.name, undefined, ctx.config.unblockMethods),
          description: m.description,
        })),
        block_methods: help.block_types.flatMap((t) =>
          (t.methods ?? []).map((m) => ({
            method: `${t.creator}.${m.name}`,
            class: classifyBlockMethod(m.name),
            via: "block.method",
            description: m.description,
          })),
        ),
      };
    },
  }),
  tool({
    name: "rex_api_describe",
    description: "Schemas and examples for one API method (rex api describe --json).",
    access: "read",
    input: { method: z.string() },
    handler: ({ method }, ctx) => ctx.rex.json(["api", "describe", method, "--json"]),
  }),
  tool({
    name: "rex_api_call",
    description:
      "Call any API method (rex api call). Policy class comes from the method table; writes need an owned or allowlisted session via `session` or args.session_id.",
    access: "dynamic",
    input: { method: z.string(), args: z.record(z.string(), z.unknown()).optional(), session: session.optional() },
    async handler({ method, args }, ctx) {
      const rule = classifyMethod(method, args, ctx.config.unblockMethods);
      const sessions = [...(ctx.target.session ? [ctx.target.session] : [])];
      if (typeof args?.session_id === "string") sessions.push(await resolveSession(ctx.rex, args.session_id));
      ctx.authorize(rule, sessions, method);
      const result = await ctx.rex.json<{ session_id?: string } | null>(
        ["api", "call", ...(ctx.target.session ? ["-s", ctx.target.session.id] : []), method, "-"],
        { stdin: JSON.stringify(args ?? {}) },
      );
      if (rule === "create" && result?.session_id) {
        const id = parseSessionId(result.session_id);
        ctx.owned.add(id);
        const windows = (result as { initial_windows?: { block_ids?: string[] }[] }).initial_windows;
        for (const window of windows ?? []) rememberBlocks(ctx, id, window.block_ids);
      }
      return result;
    },
  }),
  tool({
    name: "rex_actions_list",
    description: "Actions the server offers (init.lua and block types), or those a client reported with `client`.",
    access: "read",
    input: { client: z.string().optional() },
    handler: ({ client }, ctx) => ctx.rex.json([...(client ? ["-C", client] : []), "actions", "--json"]),
  }),
  tool({
    name: "rex_action_do",
    description:
      "Perform an action (rex do NAME --args JSON) or run Lua (`script`). Block actions need a writable session; init.lua actions and scripts need allowLua; client actions need allowClientActions.",
    access: "dynamic",
    input: {
      name: z.string().optional(),
      script: z.string().optional().describe("Lua source to run"),
      args: z.record(z.string(), z.unknown()).optional(),
      session: session.optional(),
      block: block.optional(),
      client: z.string().optional(),
    },
    async handler(a, ctx) {
      if (Boolean(a.name) === Boolean(a.script)) throw new Error("input: give exactly one of `name` or `script`");
      const sessions = ctx.target.session ? [ctx.target.session] : [];
      const tail = [...(a.args ? ["--args", JSON.stringify(a.args)] : []), ...scope(ctx), "--json"];
      if (a.script) {
        ctx.authorize("lua", sessions);
        return ctx.rex.json(["do", "-e", a.script, ...tail]);
      }
      const name = a.name!;
      if (a.client) {
        ctx.authorize("client", sessions);
        return ctx.rex.json(["-C", a.client, "do", name, ...tail]);
      }
      const { actions } = await ctx.rex.json<{ actions: { name: string; kind: string }[] }>(["actions", "--json"]);
      const kind = actions.find((x) => x.name === name)?.kind;
      // An unknown name is routed by rex to the sole connected app, and init.lua actions can queue client actions.
      if (kind === undefined) ctx.authorize("client", sessions);
      else if (kind === "lua") ctx.authorize("lua", sessions);
      if (kind !== undefined) ctx.authorize("write-session", sessions);
      return ctx.rex.json(["do", name, ...tail]);
    },
  }),
];
