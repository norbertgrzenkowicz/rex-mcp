import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLOSE_HELP,
  decideClose,
  effectiveProtectedLabels,
  executeClose,
  isClaudeRcTmux,
  isClaudeRemoteControl,
  mainClose,
  type RexReadWrite,
} from "../src/close.ts";
import { loadConfig } from "../src/config.ts";
import type { BlockId, SessionId } from "../src/ids.ts";
import { Ownership } from "../src/ownership.ts";
import { RexCli, type ExecResult } from "../src/rex.ts";
import { parseRunCreated, rexRunArgs, tools, type Ctx, type RunCreated } from "../src/tools.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const asSession = (id: string) => id as SessionId;
const asBlock = (id: string) => id as BlockId;

const baseDecision = {
  sessionId: "session:owned",
  blockId: "block:mine",
  sessionLabel: "work",
  sessionFound: true,
  owned: true,
  blockRecorded: false,
  protectedLabels: effectiveProtectedLabels([]),
  ancestry: [] as string[],
};

test("protected labels always include wispy-fjord", () => {
  assert.deepEqual(effectiveProtectedLabels([]), ["wispy-fjord"]);
  assert.ok(effectiveProtectedLabels(["other"]).includes("wispy-fjord"));
  assert.ok(effectiveProtectedLabels(["other"]).includes("other"));
});

test("claude remote-control and claude-rc detection", () => {
  assert.equal(isClaudeRemoteControl("claude\0--remote-control\0"), true);
  assert.equal(isClaudeRemoteControl("/usr/bin/claude\0remote-control"), true);
  assert.equal(isClaudeRemoteControl("node\0/opt/claude-code\0--remote-control"), true);
  assert.equal(isClaudeRemoteControl("claude\0--print\0hello"), false);
  assert.equal(isClaudeRemoteControl("vim\0--remote-control"), false);
  assert.equal(isClaudeRcTmux("tmux\0new-session\0-s\0claude-rc"), true);
  assert.equal(isClaudeRcTmux("/usr/bin/tmux\0new\0--session-name\0claude-rc"), true);
  assert.equal(isClaudeRcTmux("tmux\0new-session\0-s\0work"), false);
});

test("decideClose refuses protected contexts before ownership would allow them", () => {
  const remote = decideClose({
    ...baseDecision,
    ancestry: ["node\0dist/stdio.js\0close", "claude\0--remote-control"],
  });
  assert.equal(remote.allow, false);
  if (!remote.allow) assert.equal(remote.rule, "protected-remote-control");

  const tmux = decideClose({ ...baseDecision, tmuxSession: "claude-rc" });
  assert.equal(tmux.allow, false);
  if (!tmux.allow) assert.equal(tmux.rule, "protected-tmux");

  const named = decideClose({
    ...baseDecision,
    sessionLabel: "wispy-fjord",
    owned: true,
    blockRecorded: true,
  });
  assert.equal(named.allow, false);
  if (!named.allow) assert.equal(named.rule, "protected-session");

  const outside = decideClose({ ...baseDecision, sessionId: undefined, blockId: undefined, sessionFound: false });
  assert.equal(outside.allow, false);
  if (!outside.allow) assert.equal(outside.rule, "not-inside-rex");

  const foreign = decideClose({ ...baseDecision, owned: false, blockRecorded: false });
  assert.equal(foreign.allow, false);
  if (!foreign.allow) assert.equal(foreign.rule, "not-owned");

  assert.equal(decideClose(baseDecision).allow, true);
  assert.equal(decideClose({ ...baseDecision, owned: false, blockRecorded: true }).allow, true);
});

function tempOwnership(): { owned: Ownership; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rex-mcp-own-"));
  return { owned: new Ownership(join(dir, "owned.json")), dir };
}

test("ownership reads a legacy session array and records blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-mcp-own-"));
  const file = join(dir, "owned.json");
  writeFileSync(file, JSON.stringify(["session:legacy"]) + "\n");
  const owned = new Ownership(file);
  assert.deepEqual(owned.list(), [asSession("session:legacy")]);
  assert.deepEqual(owned.listBlocks(), []);
  owned.addBlock(asBlock("block:b1"), asSession("session:allow"));
  const again = new Ownership(file);
  assert.equal(again.hasBlock(asBlock("block:b1")), true);
  assert.equal(again.has(asSession("session:legacy")), true);
  const disk = JSON.parse(readFileSync(file, "utf8")) as { sessions: string[]; blocks: { id: string; session: string }[] };
  assert.ok(Array.isArray(disk.sessions) && Array.isArray(disk.blocks));
  again.prune(new Set([asSession("session:legacy"), asSession("session:allow")]));
  assert.equal(again.hasBlock(asBlock("block:b1")), true, "a block in a live allowlisted session stays recorded");
  again.prune(new Set([asSession("session:legacy")]));
  assert.equal(again.hasBlock(asBlock("block:b1")), false, "a block whose session is gone is dropped");
  assert.equal(again.has(asSession("session:legacy")), true);
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  method: string;
  args: string[];
}

function fakeRex(script: { sessions: { session_id: string; label: string }[]; blocks: { block_id: string }[] }): RexReadWrite & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async json<T>(args: readonly string[]): Promise<T> {
      calls.push({ method: "json", args: [...args] });
      if (args[0] === "ls") return { sessions: script.sessions } as T;
      if (args[0] === "block") return { blocks: script.blocks } as T;
      throw new Error(`unexpected json ${args.join(" ")}`);
    },
    async run(args: readonly string[]): Promise<string> {
      calls.push({ method: "run", args: [...args] });
      return "";
    },
  };
}

test("executeClose never calls rex for a protected process or outside a block", async () => {
  const { owned, dir } = tempOwnership();
  const rex = fakeRex({ sessions: [{ session_id: "session:owned", label: "work" }], blocks: [] });
  const remote = await executeClose({
    env: { REX_SESSION: "session:owned", REX_BLOCK: "block:mine" },
    rex,
    owned,
    protectedLabels: effectiveProtectedLabels([]),
    ancestry: ["claude\0--remote-control"],
    tmuxSession: undefined,
  });
  assert.equal(remote.closed, false);
  assert.equal(remote.rule, "protected-remote-control");
  assert.deepEqual(rex.calls, []);

  const outside = await executeClose({
    env: {},
    rex,
    owned,
    protectedLabels: effectiveProtectedLabels([]),
    ancestry: [],
  });
  assert.equal(outside.rule, "not-inside-rex");
  assert.deepEqual(rex.calls, []);
  rmSync(dir, { recursive: true, force: true });
});

test("executeClose closes only the current block, and kills an owned session only when it is the last block", async () => {
  const { owned, dir } = tempOwnership();
  owned.add(asSession("session:owned"));
  owned.addBlock(asBlock("block:mine"), asSession("session:owned"));
  const rex = fakeRex({
    sessions: [
      { session_id: "session:owned", label: "work" },
      { session_id: "session:fjord", label: "wispy-fjord" },
    ],
    blocks: [
      { block_id: "block:mine" },
      { block_id: "block:other" },
    ],
  });
  const closed = await executeClose({
    env: { REX_SESSION: "session:owned", REX_BLOCK: "block:mine" },
    rex,
    owned,
    protectedLabels: effectiveProtectedLabels([]),
    ancestry: [],
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.session_killed, false);
  assert.deepEqual(
    rex.calls.filter((c) => c.method === "run").map((c) => c.args),
    [["block", "close", "-s", "session:owned", "block:mine"]],
  );
  assert.equal(owned.hasBlock(asBlock("block:mine")), false);
  assert.equal(owned.has(asSession("session:owned")), true);

  const alone = fakeRex({
    sessions: [{ session_id: "session:owned", label: "work" }],
    blocks: [{ block_id: "block:only" }],
  });
  owned.addBlock(asBlock("block:only"), asSession("session:owned"));
  const killed = await executeClose({
    env: { REX_SESSION: "session:owned", REX_BLOCK: "block:only" },
    rex: alone,
    owned,
    protectedLabels: effectiveProtectedLabels([]),
    ancestry: [],
  });
  assert.equal(killed.session_killed, true);
  assert.deepEqual(
    alone.calls.filter((c) => c.method === "run").map((c) => c.args),
    [["kill", "session:owned"]],
  );
  assert.equal(owned.has(asSession("session:owned")), false);

  const fjordRex = fakeRex({
    sessions: [{ session_id: "session:fjord", label: "Wispy-Fjord" }],
    blocks: [{ block_id: "block:nope" }],
  });
  owned.add(asSession("session:fjord"));
  const fjord = await executeClose({
    env: { REX_SESSION: "session:fjord", REX_BLOCK: "block:nope" },
    rex: fjordRex,
    owned,
    protectedLabels: effectiveProtectedLabels([]),
    ancestry: [],
  });
  assert.equal(fjord.rule, "protected-session");
  assert.deepEqual(fjordRex.calls.filter((c) => c.method === "run"), []);
  rmSync(dir, { recursive: true, force: true });
});

test("executeClose closes a recorded block in an allowlisted session without killing it", async () => {
  const { owned, dir } = tempOwnership();
  owned.addBlock(asBlock("block:ran"), asSession("session:user"));
  const rex = fakeRex({
    sessions: [{ session_id: "session:user", label: "daily" }],
    blocks: [{ block_id: "block:ran" }],
  });
  const result = await executeClose({
    env: { REX_SESSION: "session:user", REX_BLOCK: "block:ran" },
    rex,
    owned,
    protectedLabels: effectiveProtectedLabels([]),
    ancestry: [],
  });
  assert.equal(result.session_killed, false);
  assert.deepEqual(
    rex.calls.filter((c) => c.method === "run").map((c) => c.args),
    [["block", "close", "-s", "session:user", "block:ran"]],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig keeps extra protected labels and the state file override", () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-mcp-cfg-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ stateFile: join(dir, "state.json"), protectedSessionLabels: ["scratch"] }));
  const config = loadConfig({ ...process.env, REX_MCP_CONFIG: configPath });
  assert.equal(config.stateFile, join(dir, "state.json"));
  assert.ok(effectiveProtectedLabels(config.protectedSessionLabels).includes("scratch"));
  assert.ok(effectiveProtectedLabels(config.protectedSessionLabels).includes("wispy-fjord"));
  rmSync(dir, { recursive: true, force: true });
});

test("rexRunArgs holds a waited block open and leaves a fire-and-forget block to Rex", () => {
  const waited = rexRunArgs({ session: "session:s", command: ["make", "test"], wait: true });
  assert.ok(waited.includes("--wait") && waited.includes("--keep-open") && waited.includes("--focus=false"));
  assert.deepEqual(waited.slice(-3), ["--", "make", "test"]);
  const once = rexRunArgs({ session: "session:s", command: ["true"] });
  assert.equal(once.includes("--keep-open"), false);
  assert.equal(once.includes("--wait"), false);
  const held = rexRunArgs({ session: "session:s", command: ["npm", "start"], keepOpen: true });
  assert.ok(held.includes("--keep-open") && !held.includes("--wait"));
  assert.deepEqual(parseRunCreated('{"block_ids":["block:a"],"window_id":"window:w"}\n{"exit":0}\n'), {
    block_ids: ["block:a"],
    window_id: "window:w",
  });
});

function runTool() {
  const tool = tools.find((t) => t.name === "rex_run");
  assert.ok(tool);
  return tool;
}

function handlerCtx(rex: unknown, owned: Ownership, block?: string): Ctx {
  return {
    rex: rex as Ctx["rex"],
    config: {
      writeAllowlist: [],
      unblockMethods: [],
      allowLua: false,
      allowClientActions: false,
      stateFile: join(tmpdir(), "unused-owned.json"),
      rexPath: "rex",
      protectedSessionLabels: [],
    },
    owned,
    events: {} as Ctx["events"],
    caller: { kind: "stdio" },
    target: { session: { id: asSession("session:s"), label: "work" }, ...(block ? { block: asBlock(block) } : {}) },
    authorize() {},
  };
}

test("a waited rex_run returns output and closes only the block it created", async () => {
  const { owned, dir } = tempOwnership();
  const calls: Call[] = [];
  const created: RunCreated = { block_ids: ["block:new"], window_id: "window:new" };
  const rex = {
    async exec(args: string[], opts: { timeoutMs?: number }): Promise<ExecResult> {
      calls.push({ method: "exec", args });
      assert.equal(opts.timeoutMs, 5_000);
      return { code: 4, stdout: JSON.stringify(created) + "\n", stderr: "", timedOut: false };
    },
    async run(args: string[]): Promise<string> {
      calls.push({ method: "run", args });
      if (args[0] === "capture") return "AUTOCLOSE_MARKER\n";
      if (args[0] === "window") throw new Error("window already closed");
      return "";
    },
    async json(args: string[]) {
      calls.push({ method: "json", args });
      return { blocks: [] };
    },
  };
  const result = (await runTool().handler(
    { command: ["sh", "-c", "echo AUTOCLOSE_MARKER; exit 4"], wait_seconds: 5, split: undefined },
    handlerCtx(rex, owned),
  )) as { output: string; closed: boolean; wait: { exit_code: number } };
  assert.equal(result.closed, true);
  assert.equal(result.output, "AUTOCLOSE_MARKER\n");
  assert.equal(result.wait.exit_code, 4);
  assert.deepEqual(
    calls.map((c) => `${c.method}:${c.args[0]}`),
    ["exec:run", "run:capture", "run:block", "json:block", "run:window"],
  );
  assert.deepEqual(calls[2]?.args, ["block", "close", "-s", "session:s", "block:new"]);
  assert.equal(owned.hasBlock(asBlock("block:new")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("keep_open and a timeout do not close the block", async () => {
  const { owned, dir } = tempOwnership();
  const calls: Call[] = [];
  const rex = {
    async exec(args: string[]): Promise<ExecResult> {
      calls.push({ method: "exec", args });
      const command = args.slice(args.indexOf("--") + 1);
      const timedOut = command[0] === "sleep";
      const id = timedOut ? "block:hung" : "block:stay";
      return {
        code: timedOut ? null : 0,
        stdout: JSON.stringify({ block_ids: [id], window_id: "window:stay" }),
        stderr: "",
        timedOut,
      };
    },
    async run(args: string[]): Promise<string> {
      calls.push({ method: "run", args });
      return "partial\n";
    },
    async json(args: string[]) {
      calls.push({ method: "json", args });
      return { block_ids: ["block:bg"] };
    },
  };
  const kept = (await runTool().handler(
    { command: ["make"], wait_seconds: 10, keep_open: true },
    handlerCtx(rex, owned),
  )) as { closed: boolean; output: string };
  assert.equal(kept.closed, false);
  assert.equal(kept.output, "partial\n");
  assert.equal(calls.some((c) => c.args[0] === "block"), false);

  calls.length = 0;
  const hung = (await runTool().handler(
    { command: ["sleep", "30"], wait_seconds: 1 },
    handlerCtx(rex, owned),
  )) as { closed: boolean; wait: { timed_out: boolean } };
  assert.equal(hung.wait.timed_out, true);
  assert.equal(hung.closed, false);
  assert.equal(calls.some((c) => c.args[0] === "block"), false);
  assert.equal(owned.hasBlock(asBlock("block:hung")), true);

  calls.length = 0;
  const background = (await runTool().handler({ command: ["npm", "start"] }, handlerCtx(rex, owned))) as { closed: boolean };
  assert.equal(background.closed, false);
  assert.equal(calls[0]?.method, "json");
  assert.equal(calls[0]?.args.includes("--wait"), false);
  assert.equal(calls[0]?.args.includes("--keep-open"), false);
  assert.equal(owned.hasBlock(asBlock("block:bg")), true);
  rmSync(dir, { recursive: true, force: true });
});

test("a split close does not close the window", async () => {
  const { owned, dir } = tempOwnership();
  const calls: Call[] = [];
  const rex = {
    async exec(): Promise<ExecResult> {
      return { code: 0, stdout: JSON.stringify({ block_ids: ["block:split"], window_id: "window:anchor" }), stderr: "", timedOut: false };
    },
    async run(args: string[]): Promise<string> {
      calls.push({ method: "run", args });
      return "";
    },
    async json() {
      return null;
    },
  };
  await runTool().handler(
    { command: ["true"], wait_seconds: 5, split: "right" },
    handlerCtx(rex, owned, "block:anchor"),
  );
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["capture", "block"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a new window is not closed while another block is still in it", async () => {
  const { owned, dir } = tempOwnership();
  const calls: Call[] = [];
  const rex = {
    async exec(): Promise<ExecResult> {
      return { code: 0, stdout: JSON.stringify({ block_ids: ["block:new"], window_id: "window:shared" }), stderr: "", timedOut: false };
    },
    async run(args: string[]): Promise<string> {
      calls.push({ method: "run", args });
      return "";
    },
    async json(args: string[]) {
      calls.push({ method: "json", args });
      return { blocks: [{ block_id: "block:agent", window_id: "window:shared" }] };
    },
  };
  const result = (await runTool().handler({ command: ["true"], wait_seconds: 5 }, handlerCtx(rex, owned))) as { closed: boolean };
  assert.equal(result.closed, true);
  assert.equal(calls.some((c) => c.args[0] === "window"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("mainClose refuses when it is not inside a block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-mcp-cli-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ stateFile: join(dir, "owned.json") }));
  const env = { ...process.env, REX_MCP_CONFIG: configPath };
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  delete env.REX_WINDOW;
  delete env.TMUX;
  delete env.TMUX_PANE;
  const code = await mainClose(env);
  assert.equal(code, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("the close subcommand is wired and help does not touch Rex", () => {
  const help = spawnSync(process.execPath, [join(ROOT, "dist/stdio.js"), "close", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /wispy-fjord/);
  assert.match(CLOSE_HELP, /claude-rc/);
  const unknown = spawnSync(process.execPath, [join(ROOT, "dist/stdio.js"), "sweep"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/);
  const refused = spawnSync(process.execPath, [join(ROOT, "dist/stdio.js"), "close"], {
    encoding: "utf8",
    env: { ...process.env, REX_SESSION: "", REX_BLOCK: "", TMUX: "", TMUX_PANE: "" },
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refused by rule (not-inside-rex|protected-)/);
});

test("a timed-out child is reaped with its process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-mcp-kill-"));
  const marker = join(dir, "pids");
  const script = join(dir, "trap.sh");
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s\\n' $$ > '${marker}'
trap '' TERM
sleep 120 &
printf '%s\\n' $! >> '${marker}'
wait
`,
  );
  chmodSync(script, 0o755);
  const cli = new RexCli(script);
  const started = Date.now();
  const result = await cli.exec([], { timeoutMs: 200, sigkillAfterMs: 400 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000, "timeout did not escalate to SIGKILL");
  const pids = readFileSync(marker, "utf8").trim().split("\n");
  const deadline = Date.now() + 1_000;
  for (const pid of pids) {
    for (;;) {
      if (!existsSync(`/proc/${pid}`)) break;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = /\) (.+)/.exec(stat)?.[1]?.[0];
      if (state && state !== "Z") throw new Error(`pid ${pid} still running (${state})`);
      if (Date.now() > deadline) throw new Error(`pid ${pid} was not reaped (state ${state ?? "gone"})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test("source never launches wl-copy", () => {
  for (const file of readdirSync(join(ROOT, "src"))) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(ROOT, "src", file), "utf8");
    assert.equal(text.includes("wl-copy"), false, file);
    assert.equal(text.includes("wl-paste"), false, file);
  }
});
