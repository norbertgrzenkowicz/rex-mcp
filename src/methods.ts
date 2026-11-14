import type { Rule } from "./policy.js";

const READ = new Set([
  "session.list",
  "session.view",
  "session.list_blocks",
  "session.list_clients",
  "session.describe_block",
  "session.help",
  "help.all",
  "target.resolve",
  "target.complete",
  "block_creator.list",
  "client.list",
  "client.inspect",
  "client.keymap",
  "hosts.list",
  "server.status",
  "server.version",
  "server.whoami",
]);

export const READ_BLOCK_METHODS = new Set([
  "format",
  "modes",
  "process",
  "size",
  "title",
  "pwd",
  "program_status",
  "input_mode",
  "list_dir",
  "blob_read",
  "clipboard_read",
]);

const BLOCKED = [
  "server.stop",
  "server.tailscale.*",
  "server.apple.*",
  "server.config_reload",
  "hosts.put",
  "hosts.remove",
  "client.set_script",
  "client.set_label",
  "client.reply",
  "client.action",
  "client.key",
];

const matches = (method: string, pattern: string) =>
  pattern.endsWith(".*") ? method.startsWith(pattern.slice(0, -1)) : method === pattern;

export function classifyMethod(method: string, args: unknown, unblock: readonly string[]): Rule {
  if (BLOCKED.some((p) => matches(method, p))) {
    return unblock.some((p) => matches(method, p)) ? "unblocked" : "blocked";
  }
  if (READ.has(method)) return "read";
  if (method === "session.create") return "create";
  if (method === "client.perform") return "client";
  if (method === "block.method") {
    const name = (args as { method?: unknown } | undefined)?.method;
    if (typeof name === "string" && READ_BLOCK_METHODS.has(name)) return "read";
  }
  return "write-session";
}

export const classifyBlockMethod = (name: string): Rule => (READ_BLOCK_METHODS.has(name) ? "read" : "write-session");
