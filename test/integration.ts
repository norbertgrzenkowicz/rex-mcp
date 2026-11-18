import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLS = [
  "rex_status", "rex_list", "rex_session_view", "rex_capture", "rex_block_info", "rex_send_text",
  "rex_send_keys", "rex_run", "rex_session_create", "rex_session_kill", "rex_block_close",
  "rex_events_poll", "rex_wait", "rex_api_list", "rex_api_describe", "rex_api_call",
  "rex_actions_list", "rex_action_do",
] as const;
type ToolName = (typeof TOOLS)[number];

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !["REX_SESSION", "REX_BLOCK", "REX_WINDOW", "REX_CLIENT"].includes(k)) env[k] = v;
}
const rexJson = <T>(...args: string[]): T => JSON.parse(execFileSync("rex", args, { env, encoding: "utf8" })) as T;

interface Snapshot {
  session_id: string;
  label: string;
  windows: { window_id: string; label: string }[];
  blocks: { block_id: string; label: string; window_id?: string }[];
}

function snapshot(ids?: readonly string[]): Snapshot[] {
  const { sessions } = rexJson<{ sessions: { session_id: string; label: string }[] }>("ls", "--json");
  return sessions
    .filter((s) => !ids || ids.includes(s.session_id))
    .map((s) => ({
      session_id: s.session_id,
      label: s.label,
      windows: rexJson<{ windows: { window_id: string; label: string }[] }>("window", "ls", "-s", s.session_id, "--json")
        .windows.map(({ window_id, label }) => ({ window_id, label })),
      blocks: rexJson<{ blocks: { block_id: string; label: string; window_id?: string }[] }>("block", "ls", "-s", s.session_id, "--json")
        .blocks.map(({ block_id, label, window_id }) => ({ block_id, label, window_id })),
    }));
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const failures = new Map<string, string>();
const passed = new Set<string>();
const policyLines: string[] = [];

const before = snapshot();
const preexisting = before.map((s) => s.session_id);
const foreign = before[0];

const stateDir = mkdtempSync(join(tmpdir(), "rex-mcp-test-"));
const configPath = join(stateDir, "config.json");
writeFileSync(configPath, JSON.stringify({ stateFile: join(stateDir, "owned.json") }));

const client = new Client({ name: "rex-mcp-integration", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist/stdio.js")],
  env: { ...env, REX_MCP_CONFIG: configPath },
  stderr: "inherit",
});

interface Reply {
  isError: boolean;
  text: string;
}

async function raw(name: ToolName, args: Record<string, unknown> = {}): Promise<Reply> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
  return { isError: r.isError === true, text: r.content.map((c) => c.text ?? "").join("") };
}

async function call<T = any>(name: ToolName, args: Record<string, unknown> = {}): Promise<T> {
  const r = await raw(name, args);
  if (r.isError) throw new Error(`${name} returned error: ${r.text}`);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    return r.text as T;
  }
}

async function check(tool: ToolName, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed.add(tool);
  } catch (err) {
    failures.set(tool, failures.get(tool) ?? (err as Error).message);
  }
}

async function refused(name: string, tool: ToolName, args: Record<string, unknown>, rule: string): Promise<void> {
  const r = await raw(tool, args);
  if (r.isError && r.text.startsWith("policy:") && r.text.includes(rule)) {
    policyLines.push(`PASS policy:${name}`);
  } else {
    policyLines.push(`FAIL policy:${name}: expected a ${rule} refusal, got isError=${r.isError} ${r.text.slice(0, 200)}`);
  }
}

const label = `rex-mcp-test-${Math.random().toString(36).slice(2, 8)}`;
let sessionId: string | undefined;

try {
  await client.connect(transport);
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  assert(JSON.stringify(listed) === JSON.stringify([...TOOLS].sort()), `server lists exactly the 18 tools, got ${listed.join(",")}`);

  let blockId = "";
  await check("rex_session_create", async () => {
    const created = await call("rex_session_create", { label, window: "main", cwd: "/tmp" });
    sessionId = created.session_id;
    blockId = created.block_id;
    assert(sessionId?.startsWith("session:") && blockId?.startsWith("block:"), "create returns session and block IDs");
  });
  assert(sessionId, "test session exists, cannot continue without it");

  await check("rex_status", async () => {
    const s = await call("rex_status");
    assert(s.version.rex_version, "status reports rex_version");
    assert(s.owned.includes(sessionId), "status lists the test session as owned");
    assert(s.policy.allowLua === false && s.policy.allowClientActions === false, "status reports default policy flags");
  });

  await check("rex_list", async () => {
    const { sessions } = await call("rex_list", { kind: "sessions" });
    assert(sessions.some((s: any) => s.session_id === sessionId && s.owned), "sessions list marks the test session owned");
    const { windows } = await call("rex_list", { kind: "windows", session: label });
    assert(windows.some((w: any) => w.label === "main"), "windows list has the main window");
    const { blocks } = await call("rex_list", { kind: "blocks", session: sessionId });
    assert(blocks.some((b: any) => b.block_id === blockId), "blocks list has the first block");
    const clients = await call("rex_list", { kind: "clients" });
    assert(Array.isArray(clients.clients), "clients list returns clients");
  });

  await check("rex_session_view", async () => {
    const view = await call("rex_session_view", { session: sessionId });
    assert(view.session_id === sessionId && view.windows.length === 1, "view shows the test session with one window");
  });

  await check("rex_send_text", async () => {
    await call("rex_send_text", { session: sessionId, block: blockId, text: "echo MCP$((6*7))MARK", enter: true });
  });

  await check("rex_wait", async () => {
    const w = await call("rex_wait", { session: sessionId, block: blockId, until: "match", pattern: "^MCP42MARK$", timeout_seconds: 10 });
    assert(w.done === true && w.match === "MCP42MARK", `match wait sees the echoed marker, got ${JSON.stringify(w)}`);
  });

  await check("rex_capture", async () => {
    const text = await call<string>("rex_capture", { session: sessionId, block: blockId });
    assert(/^MCP42MARK$/m.test(text), "capture holds the echoed marker");
    const tail = await call<string>("rex_capture", { session: sessionId, block: blockId, tail_lines: 1, max_bytes: 5 });
    assert(tail.startsWith("[rex-mcp: truncated"), "capture truncates from the front past max_bytes");
  });

  await check("rex_send_keys", async () => {
    await call("rex_send_text", { session: sessionId, block: blockId, text: "echo KEY$((1+1))S" });
    await call("rex_send_keys", { session: sessionId, block: blockId, keys: ["enter"] });
    const w = await call("rex_wait", { session: sessionId, block: blockId, until: "match", pattern: "^KEY2S$", timeout_seconds: 10 });
    assert(w.done, "send-key enter ran the typed command");
  });

  await check("rex_block_info", async () => {
    const info = await call("rex_block_info", { session: sessionId, block: blockId });
    assert(info.block.block_id === blockId, "block info names the block");
    assert(info.process && "last_exit" in info.process, "block info includes the terminal process state");
  });

  let exitBlock = "";
  let keptBlock = "";
  await check("rex_run", async () => {
    const run = await call("rex_run", {
      session: sessionId, command: ["sh", "-c", "sleep 1; exit 3"], keep_open: true, label: "exit3",
    });
    exitBlock = run.block_ids[0];
    assert(exitBlock?.startsWith("block:"), "run returns the new block ID");
    assert(run.closed === false, "a run without wait_seconds does not close the block");
    const waited = await call("rex_run", {
      session: sessionId, command: ["sh", "-c", "echo KEPT_MARKER; exit 5"], keep_open: true, wait_seconds: 15,
    });
    keptBlock = waited.block_ids[0];
    assert(waited.wait.exit_code === 5, `run with wait_seconds reports exit 5, got ${JSON.stringify(waited.wait)}`);
    assert(waited.closed === false && String(waited.output).includes("KEPT_MARKER"), "keep_open returns output and leaves the block");
    const windowsBefore = (await call("rex_list", { kind: "windows", session: sessionId })).windows.length;
    const auto = await call("rex_run", {
      session: sessionId, command: ["sh", "-c", "echo AUTOCLOSE_MARKER"], wait_seconds: 15, label: "auto-close",
    });
    assert(auto.closed === true && auto.wait.exit_code === 0, `waited run closes by default, got ${JSON.stringify(auto)}`);
    assert(String(auto.output).includes("AUTOCLOSE_MARKER"), "waited run returns the command output");
    const afterAuto = await call("rex_list", { kind: "blocks", session: sessionId });
    assert(!afterAuto.blocks.some((b: any) => b.block_id === auto.block_ids[0]), "auto-closed block is gone");
    const windowsAfter = (await call("rex_list", { kind: "windows", session: sessionId })).windows.length;
    assert(windowsAfter === windowsBefore, `auto-close left a window behind (${windowsBefore} -> ${windowsAfter})`);
    const split = await call("rex_run", {
      session: sessionId, command: ["sh", "-c", "echo SPLIT_MARKER"], split: "right", anchor_block: blockId, ratio: 30, wait_seconds: 15,
    });
    assert(split.closed === true && split.wait.exit_code === 0 && String(split.output).includes("SPLIT_MARKER"), "split run closes only its block");
    const splitBlocks = await call("rex_list", { kind: "blocks", session: sessionId });
    assert(splitBlocks.blocks.some((b: any) => b.block_id === blockId), "split auto-close leaves the anchor block");
    assert(!splitBlocks.blocks.some((b: any) => b.block_id === split.block_ids[0]), "split block is gone");
    const hung = await call("rex_run", { session: sessionId, command: ["sleep", "30"], wait_seconds: 2, label: "still-running" });
    assert(hung.wait.timed_out === true && hung.closed === false, `a timed-out run stays open, got ${JSON.stringify(hung)}`);
    await call("rex_block_close", { session: sessionId, block: hung.block_ids[0] });
    const close = spawnSync(process.execPath, [join(ROOT, "dist/stdio.js"), "close"], {
      encoding: "utf8",
      env: { ...env, REX_MCP_CONFIG: configPath, REX_SESSION: sessionId!, REX_BLOCK: keptBlock, TMUX: "", TMUX_PANE: "" },
    });
    if (close.status === 0) {
      const body = JSON.parse(close.stdout);
      assert(body.closed === true && body.session_killed === false, `close CLI killed more than its block: ${close.stdout}`);
      const left = await call("rex_list", { kind: "blocks", session: sessionId });
      assert(!left.blocks.some((b: any) => b.block_id === keptBlock), "close CLI removed the kept block");
    } else if (/protected-remote-control|protected-tmux/.test(close.stderr ?? "")) {
      await call("rex_block_close", { session: sessionId, block: keptBlock });
    } else {
      throw new Error(`rex-mcp close failed: status ${close.status} ${close.stderr} ${close.stdout}`);
    }
  });

  await check("rex_wait", async () => {
    const w = await call("rex_wait", { session: sessionId, block: exitBlock, until: "exit", timeout_seconds: 15 });
    assert(w.done === true && w.exit_code === 3, `exit wait reports exit code 3, got ${JSON.stringify(w)}`);
  });

  await check("rex_events_poll", async () => {
    const r = await call("rex_events_poll", { session: sessionId, wait_ms: 5000 });
    assert(r.events.length > 0, "event log has events from the test session");
    assert(
      r.events.every((e: any) => (e.event.payload?.session_id ?? e.event.payload?.session?.session_id) === sessionId),
      "session filter keeps only test-session events",
    );
    const next = await call("rex_events_poll", { cursor: r.cursor, session: sessionId, types: ["block_closed"], wait_ms: 0 });
    assert(Array.isArray(next.events) && next.cursor >= r.cursor, "polling from the returned cursor advances");
  });

  await check("rex_api_list", async () => {
    const r = await call("rex_api_list");
    const cls = (m: string) => r.methods.find((x: any) => x.method === m)?.class;
    assert(cls("server.stop") === "blocked" && cls("session.view") === "read" && cls("client.perform") === "client", "methods carry policy classes");
    assert(r.block_methods.some((m: any) => m.method === "com.superlogical.terminal.format" && m.class === "read"), "block methods carry policy classes");
  });

  await check("rex_api_describe", async () => {
    const d = await call("rex_api_describe", { method: "session.view" });
    assert(d.name === "session.view" && d.input_schema, "describe returns the method schema");
  });

  await check("rex_api_call", async () => {
    const view = await call("rex_api_call", { method: "session.view", session: sessionId });
    assert(view.session_id === sessionId, "read call returns the test session view");
    await call("rex_api_call", { method: "session.set_block_label", args: { session_id: sessionId, block_id: blockId, label: "relabeled" } });
    const { blocks } = await call("rex_list", { kind: "blocks", session: sessionId });
    assert(blocks.find((b: any) => b.block_id === blockId)?.label === "relabeled", "write call relabeled the test block");
  });

  await check("rex_actions_list", async () => {
    const { actions } = await call("rex_actions_list");
    assert(actions.some((a: any) => a.name === "com.superlogical.terminal.clear"), "server actions include terminal.clear");
  });

  await check("rex_action_do", async () => {
    await call("rex_action_do", { name: "com.superlogical.terminal.clear", session: sessionId, block: blockId });
    const text = await call<string>("rex_capture", { session: sessionId, block: blockId });
    assert(!text.includes("MCP42MARK"), "terminal.clear removed the earlier output");
  });

  await check("rex_block_close", async () => {
    await call("rex_block_close", { session: sessionId, block: exitBlock });
    const { blocks } = await call("rex_list", { kind: "blocks", session: sessionId });
    assert(!blocks.some((b: any) => b.block_id === exitBlock), "closed block is gone");
  });

  if (foreign) {
    // Empty text: if the gate ever broke, rex would still type nothing into the user's session.
    await refused("send_text-preexisting", "rex_send_text", { session: foreign.session_id, text: "" }, "write-session");
    const foreignBlock = foreign.blocks[0]?.block_id;
    if (foreignBlock) {
      const attack = spawnSync(process.execPath, [join(ROOT, "dist/stdio.js"), "close"], {
        encoding: "utf8",
        env: {
          ...env,
          REX_MCP_CONFIG: configPath,
          REX_SESSION: foreign.session_id,
          REX_BLOCK: foreignBlock,
          TMUX: "",
          TMUX_PANE: "",
        },
      });
      const refusedClose = attack.status === 2 && (attack.stderr ?? "").includes("refused");
      if (refusedClose) policyLines.push("PASS policy:close-preexisting");
      else policyLines.push(`FAIL policy:close-preexisting: expected a refusal, got status=${attack.status} ${attack.stderr?.slice(0, 200)}`);
    }
  }
  // if_idle: a broken gate still could not stop a server that has sessions.
  await refused("api_call-server.stop", "rex_api_call", { method: "server.stop", args: { if_idle: true } }, "blocked-method");
  await refused("action_do-script", "rex_action_do", { script: "return 1", session: sessionId }, "lua");
  await refused("action_do-client", "rex_action_do", {
    name: "client.font.increase", client: "rex-mcp-test-no-such-client",
  }, "client");
  await refused("write-without-session", "rex_api_call", { method: "session.set_label", args: { label: "x" } }, "write-session");

  await check("rex_session_kill", async () => {
    await call("rex_session_kill", { session: sessionId });
    const { sessions } = await call("rex_list", { kind: "sessions" });
    assert(!sessions.some((s: any) => s.session_id === sessionId), "killed session is gone");
    const status = await call("rex_status");
    assert(!status.owned.includes(sessionId), "killed session left the owned set");
    sessionId = undefined;
  });
} catch (err) {
  failures.set("setup", (err as Error).message);
} finally {
  await client.close().catch(() => {});
  if (sessionId) {
    try {
      execFileSync("rex", ["kill", sessionId], { env });
    } catch {}
  }
  rmSync(stateDir, { recursive: true, force: true });
}

const after = snapshot(preexisting);
const snapshotOk = JSON.stringify(after) === JSON.stringify(before);
const leftovers = rexJson<{ sessions: { label: string }[] }>("ls", "--json").sessions.filter((s) => s.label === label);

for (const tool of TOOLS) {
  const failure = failures.get(tool);
  console.log(failure ? `FAIL ${tool}: ${failure}` : passed.has(tool) ? `PASS ${tool}` : `FAIL ${tool}: not exercised`);
}
for (const line of policyLines) console.log(line);
if (failures.has("setup")) console.log(`FAIL setup: ${failures.get("setup")}`);
console.log(snapshotOk ? `PASS snapshot: ${before.length} pre-existing session(s) unchanged` : `FAIL snapshot: pre-existing sessions changed`);
console.log(leftovers.length === 0 ? "PASS cleanup: test session gone" : "FAIL cleanup: test session still exists");

const ok =
  failures.size === 0 &&
  TOOLS.every((t) => passed.has(t)) &&
  policyLines.every((l) => l.startsWith("PASS")) &&
  policyLines.length === (foreign ? 5 : 4) + (foreign?.blocks[0] ? 1 : 0) &&
  snapshotOk &&
  leftovers.length === 0;
process.exit(ok ? 0 : 1);
