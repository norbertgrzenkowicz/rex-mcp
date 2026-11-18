import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ConfigSchema = z
  .object({
    writeAllowlist: z.array(z.string()).default([]),
    unblockMethods: z.array(z.string()).default([]),
    allowLua: z.boolean().default(false),
    allowClientActions: z.boolean().default(false),
    stateFile: z.string().default(".state/owned.json"),
    rexPath: z.string().default("rex"),
    server: z.string().optional(),
    protectedSessionLabels: z.array(z.string()).default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const explicit = env.REX_MCP_CONFIG;
  const path = explicit ?? join(ROOT, "rex-mcp.config.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (explicit || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`rex-mcp: cannot read config ${path}: ${(err as Error).message}`);
    }
  }
  const config = ConfigSchema.parse(raw);
  return { ...config, stateFile: resolve(ROOT, config.stateFile) };
}
