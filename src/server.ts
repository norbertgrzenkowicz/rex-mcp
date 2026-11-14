import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decide, type Caller, type Rule, type SessionRef } from "./policy.js";
import { RexError } from "./rex.js";
import { resolveTarget, tools, type Core, type Ctx } from "./tools.js";

class PolicyError extends Error {}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], isError });

export function buildServer(core: Core, caller: Caller): McpServer {
  const server = new McpServer({ name: "rex-mcp", version: "0.1.0" });

  const authorize = (rule: Rule, sessions: readonly SessionRef[], method?: string) => {
    const d = decide({
      caller,
      rule,
      sessions,
      method,
      owned: new Set(core.owned.list()),
      config: core.config,
    });
    if (!d.allowed) throw new PolicyError(`policy: refused by rule ${d.rule}: ${d.reason}`);
  };

  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      try {
        const target = await resolveTarget(core.rex, args);
        if (tool.access !== "dynamic") authorize(tool.access, target.session ? [target.session] : []);
        const ctx: Ctx = { ...core, caller, target, authorize };
        const result = await tool.handler(args, ctx);
        return text(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof PolicyError) return text(err.message, true);
        if (err instanceof RexError) return text(`rex: ${err.message}`, true);
        return text(err instanceof Error ? err.message : String(err), true);
      }
    });
  }
  return server;
}
