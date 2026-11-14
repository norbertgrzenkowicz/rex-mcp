import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseSessionId, type SessionId } from "./ids.js";

export class Ownership {
  private readonly ids: Set<SessionId>;

  constructor(private readonly file: string) {
    let raw: unknown = [];
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!Array.isArray(raw)) throw new Error(`rex-mcp: ${file} must hold a JSON array of session IDs`);
    this.ids = new Set(raw.map(parseSessionId));
  }

  has(id: SessionId): boolean {
    return this.ids.has(id);
  }

  list(): SessionId[] {
    return [...this.ids];
  }

  add(id: SessionId): void {
    this.ids.add(id);
    this.save();
  }

  remove(id: SessionId): void {
    if (this.ids.delete(id)) this.save();
  }

  prune(live: ReadonlySet<SessionId>): void {
    const gone = this.list().filter((id) => !live.has(id));
    for (const id of gone) this.ids.delete(id);
    if (gone.length) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list(), null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}
