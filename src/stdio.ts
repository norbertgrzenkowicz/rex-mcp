#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLOSE_HELP, mainClose } from "./close.js";
import { loadConfig } from "./config.js";
import { EventLog } from "./events.js";
import { Ownership } from "./ownership.js";
import { RexCli } from "./rex.js";
import { buildServer } from "./server.js";

const command = process.argv[2];
if (command === "close") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(CLOSE_HELP);
    process.exit(0);
  }
  try {
    process.exit(await mainClose());
  } catch (err) {
    console.error(`rex-mcp close: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
if (command !== undefined) {
  console.error(
    `rex-mcp: unknown command ${JSON.stringify(command)}. Run with no arguments to start the MCP server, or "close" to close this Rex block.`,
  );
  process.exit(2);
}

const config = loadConfig();
const rex = new RexCli(config.rexPath, config.server);
const events = new EventLog(rex);
const core = { rex, config, owned: new Ownership(config.stateFile), events };

events.start();
const transport = new StdioServerTransport();
const shutdown = () => {
  events.stop();
  process.exit(0);
};
transport.onclose = shutdown;
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await buildServer(core, { kind: "stdio" }).connect(transport);
