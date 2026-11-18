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

`npm ci` runs the `prepare` script, which rebuilds `dist/`. Restart the
process that is serving the old build. On the machine that publishes rex-mcp
over HTTP, that process is the systemd user service `rex-mcp-http`
(`uvx mcp-proxy` in front of `node …/dist/stdio.js`):

```sh
systemctl --user cat rex-mcp-http
```

`ExecStart` names the install. In that directory, after the pull above:

```sh
systemctl --user restart rex-mcp-http
systemctl --user status rex-mcp-http --no-pager
journalctl --user -u rex-mcp-http -n 40 --no-pager
```

`git pull` does not restart the service. If the unit sets `REX_MCP_CONFIG`,
a `rex-mcp close` hook has to set it too, or the hook will not see the same
ownership file. `systemctl --user show rex-mcp-http -p Environment -p EnvironmentFiles`
prints what the service sets.

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

## Closing blocks when the work finishes

A one-off command goes through `rex_run` with `wait_seconds`. The call waits for the command, returns its screen output, and closes the block. Rex closes the window as well when that block was the last one in it. Set `keep_open` to `true` to leave the block up after it exits. That is the opt-out for a dev server or an interactive agent.

Without `wait_seconds`, `rex_run` returns as soon as the block exists. The block stays while the program runs. Rex closes it when the program exits, unless `keep_open` is true. A wait that times out leaves the block running; close it with `rex_block_close` if you are done with it.

Nothing is closed for being idle. A long-lived program (Claude Code, OpenCode, a server) stays until it exits or its creator closes it.

When that program is finished it can close the block it is running in:

```sh
node /path/to/rex-mcp/dist/stdio.js close
```

`rex-mcp close` does the same thing when the install is on `PATH`. It only closes the block named by `REX_BLOCK` in the session named by `REX_SESSION` (the variables Rex sets inside a terminal). It takes no target argument. It refuses, and does not change anything, when:

- those variables are missing
- a parent process is `claude --remote-control` or `claude remote-control`
- it is running under tmux session `claude-rc`
- the session label is `wispy-fjord`, or a label in `protectedSessionLabels`
- the session was not created by rex-mcp and this block was not created by it

If the session was created by rex-mcp and this was its last block, the session is destroyed too. An allowlisted session is never destroyed; only a block rex-mcp created there is closed.

Claude Code can run it when a session ends. This belongs in the user or project settings on the Rex machine. `Stop` fires after every turn, so it closes the block while the agent is still in use. `SessionEnd` fires when the Claude session exits:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/rex-mcp/dist/stdio.js close"
          }
        ]
      }
    ]
  }
}
```

If the systemd unit sets `REX_MCP_CONFIG`, put the same variable in the hook command so the hook reads the same ownership file. The hook is safe to install globally: outside a block rex-mcp created, and under the protected setups above, the command exits 2 and closes nothing. OpenCode and other agents run the same command from their own session-end hook, or as the last step of a one-shot task.

## Safety model

- Reads are always allowed, on any session. `rex_capture` returns terminal
  scrollback, so a connected assistant can read anything a session has
  printed, including secrets. Connect it only to an assistant you trust with
  that machine.
- Writes need a target session that rex-mcp created or that `writeAllowlist`
  names. A write without a session is refused.
- Sessions created through rex-mcp are owned. Blocks it creates are recorded
  too, including blocks in an allowlisted session. Ownership survives restarts
  through `stateFile`.
- `rex-mcp close` only closes the block it is running in, and only when that
  block or its session was created by rex-mcp. It never touches `wispy-fjord`,
  a `claude-rc` tmux session, or anything under `claude --remote-control`.
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
| `stateFile` | `.state/owned.json` | Where created sessions and blocks are kept. Relative paths resolve against the repo directory. |
| `protectedSessionLabels` | `[]` | Extra session labels `rex-mcp close` refuses. `wispy-fjord` is always refused, on top of this list. |
| `rexPath` | `rex` | The `rex` executable. |
| `server` | unset | Passed as `rex -S SERVER`. Unset means the local server. |

## Test

```sh
npm test
```

`npm test` builds, runs the unit tests, then the integration test. The unit
tests need no Rex server. The integration test does: it creates a session
named `rex-mcp-test-<random>`, runs every tool against it and kills it at the
end. It checks that a waited `rex_run` returns output and closes its block,
that `keep_open` leaves the block, that `rex-mcp close` removes a block this
server created, and that the same command refuses a session that already
existed. It checks that those pre-existing sessions are unchanged and that
writes to them are refused.

## License

MIT. See [LICENSE](LICENSE).
