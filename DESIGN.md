# rex-mcp design

rex-mcp is an MCP server that lets a remote AI assistant see and manage a Rex
server. The assistant reaches the machine over SSH and starts the server over
stdio. Every Rex operation goes through the `rex` CLI. The CLI is Rex's
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
  boolean`, `stateFile: string`, `rexPath: string` and `server?: string`. The
  `server` field is the hook for `-S HOST`. It is unset by default, which means
  the local server. The file is `$REX_MCP_CONFIG` if set, otherwise
  `rex-mcp.config.json` in this directory. A missing default file means all
  defaults. A relative `stateFile` resolves against this directory.
- `Ownership` is a set of `SessionId`. It is written to `stateFile` (default
  `.state/owned.json` in this directory) after each change, so ownership
  survives a restart. Destroyed sessions are pruned when they are seen gone.
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
| `rex_run` | write-session | `rex run --json --focus=false`. `command` is an argv array. Options are `cwd`, `split`, `anchor_block`, `ratio`, `label`, `keep_open` and `wait_seconds`. With `wait_seconds`, it runs `rex run --wait` and stops that CLI at the deadline. A separate `rex wait` would race a pane that closes when its program exits. |
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

## Errors

`RexCli` parses JSON at the boundary. A non-zero exit becomes `RexError` with
the exit code and stderr. A tool handler returns that error as tool error text,
and the server keeps running. Nothing inside the core checks the same thing
twice.

## Test

`npm test` runs `test/integration.ts`. It starts `dist/stdio.js` with the SDK
`Client` and `StdioClientTransport`, creates `rex-mcp-test-<rand>`, runs every
tool against it, and kills it in `finally`. It snapshots every session that
exists before the test (session IDs, labels, window and block IDs, labels)
before and after, and asserts the two match. It asserts that writes to a
pre-existing session, blocked methods, Lua and client actions are refused. It
prints one `PASS` or `FAIL` line per tool and exits non-zero on any failure.
