import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseBlockId, parseSessionId, type BlockId, type SessionId } from "./ids.js";

export interface OwnedBlock {
  id: BlockId;
  session: SessionId;
}

interface DiskState {
  sessions?: unknown;
  blocks?: unknown;
}

function load(file: string): { sessions: SessionId[]; blocks: OwnedBlock[] } {
  let raw: unknown = [];
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (Array.isArray(raw)) return { sessions: raw.map(parseSessionId), blocks: [] };
  if (!raw || typeof raw !== "object") {
    throw new Error(`rex-mcp: ${file} must hold a JSON array of session IDs or {sessions, blocks}`);
  }
  const disk = raw as DiskState;
  if (!Array.isArray(disk.sessions)) {
    throw new Error(`rex-mcp: ${file} must hold a JSON array of session IDs or {sessions, blocks}`);
  }
  const blocks: OwnedBlock[] = [];
  if (disk.blocks !== undefined) {
    if (!Array.isArray(disk.blocks)) throw new Error(`rex-mcp: ${file} blocks must be an array`);
    for (const entry of disk.blocks) {
      if (!entry || typeof entry !== "object") throw new Error(`rex-mcp: ${file} has a malformed block entry`);
      const e = entry as { id?: unknown; session?: unknown };
      blocks.push({ id: parseBlockId(e.id), session: parseSessionId(e.session) });
    }
  }
  return { sessions: disk.sessions.map(parseSessionId), blocks };
}

/**
 * Sessions this server created, plus blocks it created (including blocks in an
 * allowlisted session). Persisted so a later `rex-mcp close` can see them.
 */
export class Ownership {
  private readonly ids: Set<SessionId>;
  private readonly blocks: Map<BlockId, SessionId>;

  constructor(private readonly file: string) {
    const state = load(file);
    this.ids = new Set(state.sessions);
    this.blocks = new Map(state.blocks.map((b) => [b.id, b.session]));
  }

  has(id: SessionId): boolean {
    return this.ids.has(id);
  }

  list(): SessionId[] {
    return [...this.ids];
  }

  add(id: SessionId): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.save();
  }

  remove(id: SessionId): void {
    const had = this.ids.delete(id);
    let dropped = false;
    for (const [block, session] of this.blocks) {
      if (session === id) {
        this.blocks.delete(block);
        dropped = true;
      }
    }
    if (had || dropped) this.save();
  }

  hasBlock(id: BlockId): boolean {
    return this.blocks.has(id);
  }

  listBlocks(): OwnedBlock[] {
    return [...this.blocks].map(([id, session]) => ({ id, session }));
  }

  addBlock(id: BlockId, session: SessionId): void {
    if (this.blocks.get(id) === session) return;
    this.blocks.set(id, session);
    this.save();
  }

  removeBlock(id: BlockId): void {
    if (this.blocks.delete(id)) this.save();
  }

  prune(live: ReadonlySet<SessionId>): void {
    const gone = this.list().filter((id) => !live.has(id));
    for (const id of gone) this.ids.delete(id);
    let dropped = false;
    for (const [block, session] of this.blocks) {
      // Drop blocks whose session is gone. A block in a live allowlisted
      // session stays recorded even though that session is not owned.
      if (!live.has(session)) {
        this.blocks.delete(block);
        dropped = true;
      }
    }
    if (gone.length || dropped) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body = {
      sessions: this.list(),
      blocks: this.listBlocks(),
    };
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}
