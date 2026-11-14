#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { EventLog } from "./events.js";
import { Ownership } from "./ownership.js";
import { RexCli } from "./rex.js";
import { buildServer } from "./server.js";

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
