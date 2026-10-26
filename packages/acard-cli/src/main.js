import { readFileSync } from "node:fs";
import { ApiError, makeConfig, request } from "./api.js";
import { pull, push } from "./sync.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const USAGE = `acard ${VERSION}

Usage:
  acard pull [dir]     download pages to <dir>/<slug>.md (default ./acard)
  acard push [dir]     upload local changes (conflicts are skipped)
  acard mcp            serve {server}/mcp as a stdio MCP server
  acard whoami         show who the server sees

Options:
  --server <url>       server address (default: $ACARD_URL or http://127.0.0.1:47811 (the local server))

Env:
  ACARD_URL            server address
  ACARD_TOKEN          agent token, only for a team server (Authorization: Bearer)
`;

function parseArgs(argv) {
  const positional = [];
  let server;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") server = argv[++i];
    else if (a.startsWith("--server=")) server = a.slice("--server=".length);
    else if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") positional.unshift("version");
    else if (a === "--local") flags.local = true;
    else positional.push(a);
  }
  return { command: positional[0], rest: positional.slice(1), server, help };
}

const out = (line) => process.stdout.write(line + "\n");
const err = (line) => process.stderr.write(line + "\n");

export async function main(argv) {
  const { command, rest, server, help } = parseArgs(argv);
  if (help || !command) {
    (command || help ? out : err)(USAGE);
    return command || help ? 0 : 1;
  }
  const cfg = makeConfig({ server });
  try {
    switch (command) {
      case "version":
        out(VERSION);
        return 0;
      case "pull":
        return await pull(cfg, rest[0] || "./acard", out);
      case "push":
        return await push(cfg, rest[0] || "./acard", out);
      case "whoami": {
        const me = await request(cfg, "GET", "/api/v1/me");
        out(JSON.stringify({ agent: me.agent, via: me.via, scopes: me.scopes }, null, 2));
        return 0;
      }
      case "mcp": {
        const { runMcpProxy } = await import("./mcp.js");
        return await runMcpProxy(cfg, VERSION);
      }
      default:
        err(`unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      err(`error: HTTP ${e.status}: ${e.error}`);
      if (e.status === 401) {
        err("Authentication failed: on a team server set ACARD_TOKEN to the server's agent token.");
      }
      return 1;
    }
    if (e?.cause?.code === "ECONNREFUSED" || e?.name === "TypeError") {
      err(`error: cannot reach ${cfg.server} (${e.cause?.code || e.message})`);
      return 1;
    }
    throw e;
  }
}
