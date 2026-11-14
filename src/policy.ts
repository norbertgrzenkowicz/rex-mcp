import type { Config } from "./config.js";
import type { SessionId } from "./ids.js";

export type Access = "read" | "write-session" | "create" | "client" | "lua";
export type Rule = Access | "blocked" | "unblocked";

export type Caller = { kind: "stdio" } | { kind: "http"; principal: string };

export interface SessionRef {
  id: SessionId;
  label: string;
}

export type Decision = { allowed: true } | { allowed: false; rule: string; reason: string };

export interface PolicyInput {
  caller: Caller;
  rule: Rule;
  sessions: readonly SessionRef[];
  owned: ReadonlySet<SessionId>;
  config: Pick<Config, "writeAllowlist" | "allowLua" | "allowClientActions">;
  method?: string;
}

const ALLOW: Decision = { allowed: true };

export function decide(input: PolicyInput): Decision {
  const { rule, sessions, owned, config } = input;
  switch (rule) {
    case "read":
    case "create":
    case "unblocked":
      return ALLOW;
    case "blocked":
      return {
        allowed: false,
        rule: "blocked-method",
        reason: `method ${input.method} is blocked unless listed in unblockMethods`,
      };
    case "client":
      return config.allowClientActions
        ? ALLOW
        : { allowed: false, rule: "client", reason: "client actions need allowClientActions" };
    case "lua":
      return config.allowLua ? ALLOW : { allowed: false, rule: "lua", reason: "Lua needs allowLua" };
    case "write-session": {
      if (sessions.length === 0) {
        return { allowed: false, rule: "write-session", reason: "a write must name a target session" };
      }
      const denied = sessions.find(
        (s) => !owned.has(s.id) && !config.writeAllowlist.includes(s.id) && !config.writeAllowlist.includes(s.label),
      );
      return denied
        ? {
            allowed: false,
            rule: "write-session",
            reason: `session ${denied.label} (${denied.id}) is neither owned by rex-mcp nor in writeAllowlist`,
          }
        : ALLOW;
    }
  }
}
