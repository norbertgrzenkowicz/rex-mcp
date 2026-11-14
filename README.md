# rex-mcp

rex-mcp is an MCP server that lets an AI assistant see and manage a
[Rex](https://www.superlogical.com/rex/docs) server. It speaks MCP over stdio
and runs every Rex operation through the `rex` CLI. An assistant on another
machine reaches it over SSH.

It can read any session. It writes only to sessions it created, plus any you
allowlist. See [DESIGN.md](DESIGN.md) for the full design.

## Install

Requires Node 26 and `rex` on `PATH`.

```sh
npm ci && npm run build
```

## Run

```sh
npm start            # same as: node dist/stdio.js
```

The server reads MCP messages on stdin and writes them on stdout.

Register it with Claude Code:

```sh
claude mcp add rex -- node <path-to>/rex-mcp/dist/stdio.js
```

For an assistant on another machine, start it over SSH:

```sh
ssh host node <path-to>/rex-mcp/dist/stdio.js
```

For example, from the remote machine's Claude Code:
`claude mcp add rex -- ssh host node <path-to>/rex-mcp/dist/stdio.js`.

## Config

The config file is `$REX_MCP_CONFIG` if set, otherwise `rex-mcp.config.json`
in this directory. A missing default file means every default applies. Copy
`rex-mcp.config.example.json` to start. Unknown fields are rejected.

| Field | Default | Meaning |
| --- | --- | --- |
| `writeAllowlist` | `[]` | Session IDs or labels rex-mcp may write to besides the ones it created. |
| `unblockMethods` | `[]` | Blocked API methods to allow, such as `server.stop`. Patterns ending in `.*` match a prefix. |
| `allowLua` | `false` | Allow `rex_action_do` with `script`, and init.lua actions. |
| `allowClientActions` | `false` | Allow actions performed by a connected Rex app, and `client.perform`. |
| `stateFile` | `.state/owned.json` | Where the set of created sessions is kept. Relative paths resolve against this directory. |
| `rexPath` | `rex` | The `rex` executable. |
| `server` | unset | Passed as `rex -S SERVER`. Unset means the local server. |

## Safety model

- Reads are always allowed, on any session.
- Writes (`rex_send_text`, `rex_send_keys`, `rex_run`, `rex_session_kill`,
  `rex_block_close`, write API calls, block actions) need a target session that
  rex-mcp created or that `writeAllowlist` names. A write without a session is
  refused.
- Sessions created with `rex_session_create` or `session.create` are owned.
  Ownership survives restarts through `stateFile`.
- Server, host, Tailscale and client-control API methods are blocked unless
  `unblockMethods` lists them.
- Lua and app client actions are off by default.
- rex-mcp never passes `--focus=true`, so the Rex app keeps its focus.
- Every `rex` child runs without `REX_SESSION`, `REX_BLOCK`, `REX_WINDOW` and
  `REX_CLIENT`, so starting rex-mcp inside a Rex pane does not make that pane
  the default target.

A refused call returns an MCP tool error whose text starts with `policy:` and
names the rule.

## Tools

`rex_status`, `rex_list`, `rex_session_view`, `rex_capture`, `rex_block_info`,
`rex_send_text`, `rex_send_keys`, `rex_run`, `rex_session_create`,
`rex_session_kill`, `rex_block_close`, `rex_events_poll`, `rex_wait`,
`rex_api_list`, `rex_api_describe`, `rex_api_call`, `rex_actions_list` and
`rex_action_do`. DESIGN.md describes each one.

## Test

```sh
npm run build && npm test
```

The test starts `dist/stdio.js` through the MCP SDK client, runs every tool
against a session named `rex-mcp-test-<random>` and kills it at the end. It
checks that sessions that existed before the test are unchanged. It needs a
running Rex server.
