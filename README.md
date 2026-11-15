# rex-mcp

MCP server that lets an AI assistant see and manage a
[Rex](https://www.superlogical.com/rex/docs) server through the `rex` CLI.
It can read any session and writes only to sessions it created or that you
allowlist.

## Install

Copy this prompt into your AI assistant (Claude Code, OpenCode, Codex, Cursor
or any other assistant that can run shell commands and register MCP servers)
on the machine that runs Rex:

```text
Install the rex-mcp MCP server from https://github.com/norbertgrzenkowicz/rex-mcp and add it to your own MCP configuration. Steps:

1. Check prerequisites and fix or stop with a clear message if one is missing:
   - `node --version` is 26 or newer. If it is older, install Node 26 first (for example `nvm install 26 && nvm use 26`) and ask me which version manager I use if unsure.
   - `rex` is on PATH (`command -v rex`) and a Rex server is running (`rex ls --json` succeeds).
   - `git` and `npm` are available.
2. Clone the repo to ~/rex-mcp (or ask me for another path) and build it:
   git clone https://github.com/norbertgrzenkowicz/rex-mcp.git ~/rex-mcp
   cd ~/rex-mcp && npm ci
   `npm ci` builds `dist/` through the `prepare` script.
3. In the clone directory, copy the example config if no config exists yet:
   cp -n rex-mcp.config.example.json rex-mcp.config.json
   Leave the defaults (writeAllowlist empty, allowLua false, allowClientActions false) unless I ask otherwise.
4. Register an MCP server named "rex" in your own MCP config as a stdio server with command `node` and argument `~/rex-mcp/dist/stdio.js`, written as an absolute path. Use your CLI if you have one (for Claude Code: `claude mcp add rex -- node "$HOME/rex-mcp/dist/stdio.js"`), otherwise edit your MCP config file. Show me the change you made.
5. Optional, only if I say I want remote assistants to reach it over HTTP: this needs `uv` (`brew install uv` or `pipx install uv`). Run
   uvx mcp-proxy --host <listen-ip> --port 8787 -- node ~/rex-mcp/dist/stdio.js
   and tell me the URLs (http://<listen-ip>:8787/mcp for streamable HTTP, /sse for SSE). Plain HTTP has no authentication, so it belongs on localhost or a private network. Ask me which IP to bind to; never bind to a public interface without asking.
6. Verify: restart your MCP client, then call the `rex_status` tool and the `rex_list` tool with kind "sessions". Report the Rex server version and the session count. Do not send text, run commands or kill anything in existing sessions.
```

### Manual install

Requires Node 26 or newer and `rex` on `PATH`.

```sh
git clone https://github.com/norbertgrzenkowicz/rex-mcp.git /path/to/rex-mcp
cd /path/to/rex-mcp
npm ci
cp -n rex-mcp.config.example.json rex-mcp.config.json
claude mcp add rex -- node "$PWD/dist/stdio.js"
```

Any other MCP client: add this entry to your MCP configuration and point
`args` at your clone.

```json
{
  "mcpServers": {
    "rex": {
      "command": "node",
      "args": ["/path/to/rex-mcp/dist/stdio.js"]
    }
  }
}
```

From another machine over SSH:

```sh
claude mcp add rex -- ssh <host> node /path/to/rex-mcp/dist/stdio.js
```

Over HTTP for remote assistants, on the Rex machine:

```sh
uvx mcp-proxy --host <listen-ip> --port 8787 -- node /path/to/rex-mcp/dist/stdio.js
```

Plain HTTP has no authentication. Bind it to localhost or a private network.

### Update

```sh
cd /path/to/rex-mcp
git pull
npm ci
```

`npm ci` runs the `prepare` script, which rebuilds `dist/`.

### Remove

Remove the server from your MCP client (`claude mcp remove rex`, or delete the
`rex` entry from your MCP configuration), then delete the clone if you no
longer need it.

## What it does

rex-mcp speaks MCP over stdio and runs every Rex operation through the `rex`
CLI, the supported Rex surface. An assistant on another machine can start it
over SSH, or reach it over HTTP through a proxy such as `mcp-proxy`.
[DESIGN.md](DESIGN.md) has the full design.

Then ask your assistant to capture the last lines of a block, start a session
and run the test suite in it, or wait for a long job to exit.

## Tools

| Tool | Access |
| --- | --- |
| `rex_status`, `rex_list`, `rex_session_view`, `rex_capture`, `rex_block_info` | read |
| `rex_events_poll`, `rex_wait`, `rex_api_list`, `rex_api_describe`, `rex_actions_list` | read |
| `rex_session_create` | create |
| `rex_send_text`, `rex_send_keys`, `rex_run`, `rex_session_kill`, `rex_block_close` | write |
| `rex_api_call`, `rex_action_do` | depends on the method or action |

DESIGN.md describes each tool's arguments.

## Safety model

- Reads are always allowed, on any session. `rex_capture` returns terminal
  scrollback, so a connected assistant can read anything a session has
  printed, including secrets. Connect it only to an assistant you trust with
  that machine.
- Writes need a target session that rex-mcp created or that `writeAllowlist`
  names. A write without a session is refused.
- Sessions created through rex-mcp are owned. Ownership survives restarts
  through `stateFile`.
- Server, host, Tailscale and client-control API methods are blocked unless
  `unblockMethods` lists them.
- Lua (`allowLua`) and actions performed by a connected Rex app
  (`allowClientActions`) are off by default.
- rex-mcp never passes `--focus=true`, so the Rex app keeps its focus.
- Every `rex` child runs without `REX_SESSION`, `REX_BLOCK`, `REX_WINDOW` and
  `REX_CLIENT`, so starting rex-mcp inside a Rex pane does not make that pane
  the default target.

A refused call returns an MCP tool error whose text starts with `policy:` and
names the rule.

## Config

The config file is `$REX_MCP_CONFIG` if set, otherwise `rex-mcp.config.json`
in the repo directory. A missing default file means every default applies.
Unknown fields are rejected.

| Field | Default | Meaning |
| --- | --- | --- |
| `writeAllowlist` | `[]` | Session IDs or labels rex-mcp may write to besides the ones it created. |
| `unblockMethods` | `[]` | Blocked API methods to allow, such as `server.stop`. Patterns ending in `.*` match a prefix. |
| `allowLua` | `false` | Allow `rex_action_do` with `script`, and init.lua actions. |
| `allowClientActions` | `false` | Allow actions performed by a connected Rex app, and `client.perform`. |
| `stateFile` | `.state/owned.json` | Where the set of created sessions is kept. Relative paths resolve against the repo directory. |
| `rexPath` | `rex` | The `rex` executable. |
| `server` | unset | Passed as `rex -S SERVER`. Unset means the local server. |

## Test

```sh
npm run build && npm test
```

The test needs a running Rex server. It creates a session named
`rex-mcp-test-<random>`, runs every tool against it and kills it at the end.
It checks that sessions that existed before are unchanged and that writes to
them are refused.

## License

MIT. See [LICENSE](LICENSE).
