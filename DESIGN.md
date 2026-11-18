# rex-mcp design

rex-mcp is an MCP server that lets an AI assistant see and manage a Rex
server. The assistant starts it over stdio, either locally or on the Rex
machine over SSH, or reaches it through an HTTP proxy such as mcp-proxy. Every Rex operation goes through the `rex` CLI. The CLI is Rex's
supported surface, and the socket protocol behind it is not documented.

## Layers

```
src/stdio.ts        Transport entry. Builds the core, connects StdioServerTransport.
src/server.ts       Builds an McpServer from the tool registry. Knows no transport.
src/tools.ts        The tool registry: one table of {name, description, input, handler}.
src/policy.ts       Pure decisions: may this caller read or write this target?
src/methods.ts      The API method classification table.
src/ownership.ts    The set of session IDs this server created, persisted to disk.
src/events.ts       EventLog: one long-running `rex events` child feeding a ring buffer.
src/rex.ts          RexCli: runs `rex`, parses JSON, maps failures to RexError.
src/config.ts       Loads and validates rex-mcp.config.json.
src/ids.ts          Branded ID types and their parsers.
```

Streamable HTTP later is one more entry file (`src/http.ts`) that builds the
same core and passes a different `Caller`. No other file changes.

## Data shapes

- `SessionId`, `WindowId`, `BlockId` and `ClientId` are branded strings. They
  are parsed once from Rex output by their prefixes (`session:`, `window:`,
  `block:`, `client:`). Tools accept labels or IDs. The handler turns a label
  into a full ID once (`target.resolve` through `rex api call`) before it calls
  policy.
- `Caller` is `{ kind: "stdio" }` today. An HTTP transport adds
  `{ kind: "http", principal: string }`. Policy receives it on every call, so
  per-caller rules can be added later without changing tool signatures.
- `Config` holds `writeAllowlist: string[]` (session IDs or labels),
  `unblockMethods: string[]`, `allowLua: boolean`, `allowClientActions:
  boolean`, `stateFile: string`, `rexPath: string`, `server?: string` and
  `protectedSessionLabels: string[]` (extra labels `rex-mcp close` refuses;
  `wispy-fjord` is always refused). The
  `server` field is the hook for `-S HOST`. It is unset by default, which means
  the local server. The file is `$REX_MCP_CONFIG` if set, otherwise
  `rex-mcp.config.json` in this directory. A missing default file means all
  defaults. A relative `stateFile` resolves against this directory.
- `Ownership` is the set of `SessionId`s this server created, plus the blocks
  it created (`{id, session}`, including a block in an allowlisted session).
  It is written to `stateFile` (default `.state/owned.json`) after each
  change, so ownership survives a restart. A file that is still a JSON array
  of session IDs is read as sessions with no recorded blocks. Destroyed
  sessions are pruned when they are seen gone, and blocks whose session is
  gone are dropped with them.
- `EventLog` is a ring buffer of `{ seq: number, at: string, event: unknown }`
  with capacity 5000. `seq` increases by one per event. `poll(cursor, waitMs,
  filter)` returns the events after `cursor` and the next cursor. If none are
  buffered yet, it waits up to `waitMs` for one (long polling). A cursor older
  than the oldest buffered event returns `{ dropped: true }` with the events it
  still has. The child process restarts with backoff if it exits.

## Policy

Every tool falls into one access kind, recorded in its registry row:

| Access | Rule |
| --- | --- |
| `read` | Always allowed. Covers any session. |
| `write-session` | Allowed only if the target session is owned or allowlisted. |
| `create` | Always allowed. The created session is added to Ownership. |
| `client` | Allowed only if `allowClientActions`. |
| `lua` | Allowed only if `allowLua`. |

`api_call` takes any method name, so its access comes from `methods.ts`:

- **Read.** `session.list`, `session.view`, `session.list_blocks`,
  `session.list_clients`, `session.describe_block`, `session.help`, `help.all`,
  `target.resolve`, `target.complete`, `block_creator.list`, `client.list`,
  `client.inspect`, `client.keymap`, `hosts.list`, `server.status`,
  `server.version`, `server.whoami`. For `block.method`, the read-only block
  methods (`format`, `modes`, `process`, `size`, `title`, `pwd`,
  `program_status`, `input_mode`, `list_dir`, `blob_read`, `clipboard_read`)
  count as read.
- **Create.** `session.create`.
- **Blocked unless listed in `unblockMethods`.** An unblocked method is
  allowed outright and is tagged `unblocked`. A refusal names rule
  `blocked-method`. `server.stop`,
  `server.tailscale.*`, `server.apple.*`, `server.config_reload`, `hosts.put`,
  `hosts.remove`, `client.set_script`, `client.set_label`, `client.reply`,
  `client.action`, `client.key`. These are blocked at the method level.
- **Client.** `client.perform`.
- **Everything else is write-session.** The session comes from
  `args.session_id` or the `session` tool argument. When both are given, both
  must be writable. A write with no session is refused.

A refused call returns an MCP tool error with `isError: true` and text that
starts with `policy:`. It also names the rule that refused it.

Every `rex` child is started with `REX_SESSION`, `REX_BLOCK`, `REX_WINDOW` and
`REX_CLIENT` removed from its environment. If the server is started inside a
Rex pane, the CLI cannot fall back to that pane's session.

## Tools

| Tool | Access | What it does |
| --- | --- | --- |
| `rex_status` | read | Server identity and version (`rex whoami --json`, `server.version`). Also returns the owned sessions and the active policy flags. |
| `rex_list` | read | `kind` is one of `sessions`, `windows`, `blocks` or `clients`. `session` is required for windows and blocks. |
| `rex_session_view` | read | `session.view` snapshot: windows, layouts, focus. |
| `rex_capture` | read | Screen and scrollback. Options are `format` (text, html, vt), `tail_lines`, `unwrap` and `max_bytes` (default 200000, truncated from the front). |
| `rex_block_info` | read | `rex block inspect` and the terminal `process` method. |
| `rex_send_text` | write-session | `rex send`, with the text passed on stdin. Optional `enter: true` presses Return afterwards. |
| `rex_send_keys` | write-session | `rex send-key KEY...`. |
| `rex_run` | write-session | `rex run --json --focus=false`. `command` is an argv array. Options are `cwd`, `split`, `anchor_block`, `ratio`, `label`, `keep_open` and `wait_seconds`. With `wait_seconds`, it runs `rex run --wait --keep-open` (so the block is still there to read), captures the screen, and closes the block unless `keep_open` is true. Rex closes a window whose last block closed. A non-split run then closes that window only if `block ls` shows nothing left in it. A split is `rex block close` only, so the anchor stays. A timeout stops the waiter and leaves the block running. Without `wait_seconds`, Rex closes the block when the command exits unless `keep_open` is set. The created block ids are recorded. |
| `rex_session_create` | create | `rex new LABEL --json`, with optional `cwd`, `window` and `command`. Returns the session ID and the first block ID. |
| `rex_session_kill` | write-session | `rex kill SESSION_ID`. Removes it from Ownership. |
| `rex_block_close` | write-session | `rex block close`. |
| `rex_events_poll` | read | Long-polls EventLog. Options are `cursor` (default 0, the oldest buffered event), `wait_ms` (at most 60000), `session` and `types` filters, and `limit`. `types` matches an event's `type` or a `session_event`'s inner type. |
| `rex_wait` | read | `until` is `exit` (`rex wait --for`) or `match` (polls the capture against `pattern`, a JS regex). Takes `timeout_seconds` and returns `{done, timed_out, exit_code?, match?}`. |
| `rex_api_list` | read | `rex api list` methods, each tagged with its policy class. |
| `rex_api_describe` | read | `rex api describe METHOD --json`. |
| `rex_api_call` | from `methods.ts` | `rex api call [-s SESSION] METHOD JSON`. |
| `rex_actions_list` | read | `rex actions --json`, or `rex -C CLIENT actions --json` for a client. |
| `rex_action_do` | see below | `rex do NAME --args JSON`. A client action (with `client`) needs `allowClientActions`. A block action needs a writable target session. Lua (`script`) needs `allowLua`. An init.lua action (`kind: "lua"` in `rex actions --json`) needs `allowLua` and a writable session, because its Lua can queue client actions. A name missing from the server's action list counts as a client action, because rex sends it to the only connected app. |

The server never passes `--focus=true`. It never uses client actions unless
config enables them.

## Closing what this server opened

Idle time never closes a block. A block closes when its program exits (Rex's
own rule, unless `keep_open`), when a waited `rex_run` finishes and
`keep_open` is not set, or when the creator closes it.

`rex-mcp close` (the same binary as the server, with the argument `close`) is
how a program running inside a block closes that block. It reads `REX_SESSION`
and `REX_BLOCK` and takes no target argument. Before it talks to Rex it
refuses if a parent is `claude --remote-control` / `claude remote-control`, or
if it is under tmux session `claude-rc`. After a read-only `rex ls` it also
refuses session label `wispy-fjord` (always, plus any
`protectedSessionLabels`), a session that is not on the server, and a block
that is neither in an owned session nor in the recorded block set. An owned
session's last block takes the session with it (`rex kill`). Any other
allowed block is `rex block close` only. An allowlisted session is never
killed.

A Claude Code `SessionEnd` hook is the documented way to run it. `Stop` fires
after every turn and would close a block the agent is still using.

## Processes

This server does not spawn `wl-copy` or `wl-paste`. Every `rex` child has a
`close` handler, which is what reaps it, so a child that exits does not stay a
zombie of rex-mcp. `exec` starts that child as its own process group. On
timeout the group gets SIGTERM and then SIGKILL, so a grandchild the CLI
forked cannot outlive the wait.

Orphaned `wl-copy --primary` processes are the Wayland primary-selection
helper. `wl-copy` forks itself into the background and serves the selection
until something replaces it; its parent is whatever asked to copy (the Rex
Linux client, a terminal clipboard hook, or a shell integration), not this
server. Closing a block goes through `rex block close`, which hangs the
terminal up. It does not scan the process table and it does not signal
processes in sessions this server does not own. A zombie whose parent is the
Rex server, rather than this Node process, is outside what rex-mcp can reap.

## Errors

`RexCli` parses JSON at the boundary. A non-zero exit becomes `RexError` with
the exit code and stderr. A tool handler returns that error as tool error text,
and the server keeps running. Nothing inside the core checks the same thing
twice.

## Test

`npm test` builds, runs `test/cleanup.test.ts` (no Rex server: close decisions,
ownership, `rex_run` cleanup, and process-group kill), then `test/integration.ts`.
The integration test starts `dist/stdio.js` with the SDK
`Client` and `StdioClientTransport`, creates `rex-mcp-test-<rand>`, runs every
tool against it, and kills it in `finally`. It snapshots every session that
exists before the test (session IDs, labels, window and block IDs, labels)
before and after, and asserts the two match. It asserts that writes to a
pre-existing session, blocked methods, Lua and client actions are refused. It
prints one `PASS` or `FAIL` line per tool and exits non-zero on any failure.
