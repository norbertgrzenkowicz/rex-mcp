import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { parseBlockId, parseSessionId, type BlockId, type SessionId } from "./ids.js";
import { Ownership } from "./ownership.js";
import { RexCli } from "./rex.js";

/** Always refused, even if the label is removed from config or the session is owned. */
export const HARD_PROTECTED_LABELS = ["wispy-fjord"] as const;
export const PROTECTED_TMUX_SESSION = "claude-rc";

export const CLOSE_HELP = `rex-mcp close

Close the Rex block this process is running in, and the window when that block
was the last one in it. If the session was created by rex-mcp and this was its
last block, the session is destroyed too.

The command only acts on REX_SESSION and REX_BLOCK from the environment Rex
sets inside a terminal. It takes no session or block argument.

It refuses, and does not change anything, when:
  - it is not inside a Rex block
  - a parent process is \`claude --remote-control\` (or \`claude remote-control\`)
  - it is running under tmux session ${PROTECTED_TMUX_SESSION}
  - the session label is ${HARD_PROTECTED_LABELS.join(", ")} (always), or one of protectedSessionLabels
  - the session was not created by rex-mcp and this block was not created by it

Idle blocks are never closed. Run this when the program itself is finished
(a Claude Code SessionEnd hook is the usual place). Exit 0 on success, 2 when
refused.
`;

export function effectiveProtectedLabels(extra: readonly string[]): string[] {
  const labels = new Set<string>(HARD_PROTECTED_LABELS.map((l) => l.toLowerCase()));
  for (const label of extra) labels.add(label.toLowerCase());
  return [...labels];
}

export function splitCmd(cmdline: string): string[] {
  if (cmdline.includes("\0")) return cmdline.split("\0").filter(Boolean);
  return cmdline.split(/\s+/).filter(Boolean);
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** True when this command line is Claude Code started for remote control. */
export function isClaudeRemoteControl(cmdline: string): boolean {
  const parts = splitCmd(cmdline);
  if (parts.length === 0) return false;
  const hasFlag = parts.some(
    (arg) => arg === "--remote-control" || arg === "remote-control" || arg.startsWith("--remote-control="),
  );
  if (!hasFlag) return false;
  return parts.some((part) => {
    const base = basename(part);
    return base === "claude" || base === "claude-code";
  });
}

/** True when a tmux invocation in the tree named its session claude-rc. */
export function isClaudeRcTmux(cmdline: string): boolean {
  const parts = splitCmd(cmdline);
  if (basename(parts[0] ?? "") !== "tmux") return false;
  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i];
    if ((arg === "-s" || arg === "--session-name") && parts[i + 1] === PROTECTED_TMUX_SESSION) return true;
  }
  return false;
}

export function ancestryHasRemoteControl(cmdlines: readonly string[]): boolean {
  return cmdlines.some(isClaudeRemoteControl);
}

export function ancestryHasClaudeRc(cmdlines: readonly string[]): boolean {
  return cmdlines.some(isClaudeRcTmux);
}

export function readAncestry(pid = process.pid): string[] {
  if (process.platform !== "linux") return [];
  const out: string[] = [];
  const seen = new Set<number>();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    try {
      out.push(readFileSync(`/proc/${current}/cmdline`).toString());
      const status = readFileSync(`/proc/${current}/status`, "utf8");
      const ppid = /^PPid:\s+(\d+)/m.exec(status);
      current = ppid ? Number(ppid[1]) : 1;
    } catch {
      break;
    }
  }
  return out;
}

/** Refusals that can be decided with no Rex call and no ownership lookup. */
export function preflightClose(input: {
  sessionId?: string;
  blockId?: string;
  tmuxSession?: string;
  ancestry: readonly string[];
}): Extract<CloseDecision, { allow: false }> | undefined {
  if (ancestryHasRemoteControl(input.ancestry)) {
    return {
      allow: false,
      rule: "protected-remote-control",
      reason: "a parent process is claude --remote-control; rex-mcp will not close anything under it",
    };
  }
  if (input.tmuxSession === PROTECTED_TMUX_SESSION || ancestryHasClaudeRc(input.ancestry)) {
    return {
      allow: false,
      rule: "protected-tmux",
      reason: `tmux session ${PROTECTED_TMUX_SESSION} is protected; rex-mcp will not close anything under it`,
    };
  }
  if (!input.sessionId?.startsWith("session:") || !input.blockId?.startsWith("block:")) {
    return {
      allow: false,
      rule: "not-inside-rex",
      reason: "REX_SESSION and REX_BLOCK are not set; this command only closes the block it is running in",
    };
  }
  return undefined;
}

export function readTmuxSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.TMUX && !env.TMUX_PANE) return undefined;
  try {
    return execFileSync("tmux", ["display-message", "-p", "#S"], {
      env,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

export interface CloseDecisionInput {
  sessionId?: string;
  blockId?: string;
  sessionLabel?: string;
  sessionFound: boolean;
  owned: boolean;
  blockRecorded: boolean;
  protectedLabels: readonly string[];
  tmuxSession?: string;
  ancestry: readonly string[];
}

export type CloseDecision =
  | { allow: true }
  | { allow: false; rule: string; reason: string };

export function decideClose(input: CloseDecisionInput): CloseDecision {
  const early = preflightClose(input);
  if (early) return early;
  if (!input.sessionFound) {
    return {
      allow: false,
      rule: "session-not-found",
      reason: `session ${input.sessionId} is not on this Rex server`,
    };
  }
  const label = input.sessionLabel ?? "";
  if (input.protectedLabels.includes(label.toLowerCase())) {
    return {
      allow: false,
      rule: "protected-session",
      reason: `session ${label || input.sessionId} is protected and is never closed by rex-mcp`,
    };
  }
  if (!input.owned && !input.blockRecorded) {
    return {
      allow: false,
      rule: "not-owned",
      reason: `session ${label} (${input.sessionId}) is not owned by rex-mcp and block ${input.blockId} was not created by it`,
    };
  }
  return { allow: true };
}

interface ListedSession {
  session_id: string;
  label: string;
}

interface ListedBlock {
  block_id: string;
}

export interface RexReadWrite {
  json<T = unknown>(args: readonly string[]): Promise<T>;
  run(args: readonly string[]): Promise<string>;
}

export interface CloseResult {
  closed: boolean;
  rule?: string;
  reason?: string;
  session?: string;
  block?: string;
  session_killed?: boolean;
  already_gone?: boolean;
}

export interface ExecuteCloseInput {
  env: NodeJS.ProcessEnv;
  rex: RexReadWrite;
  owned: Ownership;
  protectedLabels: readonly string[];
  ancestry: readonly string[];
  tmuxSession?: string;
}

export async function executeClose(input: ExecuteCloseInput): Promise<CloseResult> {
  const sessionId = input.env.REX_SESSION;
  const blockId = input.env.REX_BLOCK;
  const early = preflightClose({
    sessionId,
    blockId,
    tmuxSession: input.tmuxSession,
    ancestry: input.ancestry,
  });
  if (early) return { closed: false, rule: early.rule, reason: early.reason };

  const { sessions } = await input.rex.json<{ sessions: ListedSession[] }>(["ls", "--json"]);
  const session = sessions.find((s) => s.session_id === sessionId);
  const owned = session ? input.owned.has(parseSessionId(session.session_id)) : false;
  let blockRecorded = false;
  if (blockId?.startsWith("block:")) {
    try {
      blockRecorded = input.owned.hasBlock(parseBlockId(blockId));
    } catch {
      blockRecorded = false;
    }
  }
  const decision = decideClose({
    sessionId,
    blockId,
    sessionLabel: session?.label,
    sessionFound: Boolean(session),
    owned,
    blockRecorded,
    protectedLabels: input.protectedLabels,
    tmuxSession: input.tmuxSession,
    ancestry: input.ancestry,
  });
  if (!decision.allow) return { closed: false, rule: decision.rule, reason: decision.reason };

  const sid = sessionId as SessionId;
  const bid = blockId as BlockId;
  const { blocks } = await input.rex.json<{ blocks: ListedBlock[] }>(["block", "ls", "-s", sid, "--json"]);
  const present = blocks.some((b) => b.block_id === bid);
  if (!present) {
    input.owned.removeBlock(parseBlockId(bid));
    return { closed: true, session: sid, block: bid, session_killed: false, already_gone: true };
  }
  const onlyThisBlock = blocks.length === 1 && blocks[0]?.block_id === bid;
  const parsedSession = parseSessionId(sid);
  const parsedBlock = parseBlockId(bid);
  // Update ownership before the Rex call. Closing the block this process is
  // running in can SIGHUP it before the call returns.
  if (owned && onlyThisBlock) {
    const recorded = input.owned.listBlocks().filter((b) => b.session === parsedSession);
    input.owned.remove(parsedSession);
    try {
      await input.rex.run(["kill", sid]);
    } catch (err) {
      input.owned.add(parsedSession);
      for (const block of recorded) input.owned.addBlock(block.id, block.session);
      throw err;
    }
    return { closed: true, session: sid, block: bid, session_killed: true };
  }
  input.owned.removeBlock(parsedBlock);
  try {
    await input.rex.run(["block", "close", "-s", sid, bid]);
  } catch (err) {
    input.owned.addBlock(parsedBlock, parsedSession);
    throw err;
  }
  return { closed: true, session: sid, block: bid, session_killed: false };
}

export async function mainClose(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const result = await executeClose({
    env,
    rex: new RexCli(config.rexPath, config.server),
    owned: new Ownership(config.stateFile),
    protectedLabels: effectiveProtectedLabels(config.protectedSessionLabels),
    ancestry: readAncestry(),
    tmuxSession: readTmuxSession(env),
  });
  if (!result.closed) {
    console.error(`rex-mcp close: refused by rule ${result.rule}: ${result.reason}`);
    return 2;
  }
  console.log(JSON.stringify(result));
  return 0;
}
