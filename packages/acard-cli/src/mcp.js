import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { authHeaders } from "./api.js";
import { rewriteLocalImages } from "./local-images.js";

const log = (msg) => process.stderr.write(`acard mcp: ${msg}\n`);

/** Local stdio MCP server that forwards tools/* to the remote Streamable HTTP endpoint. */
export async function runMcpProxy(cfg, version) {
  const client = new Client({ name: "acard-cli-proxy", version });
  const remote = new StreamableHTTPClientTransport(new URL(cfg.server + "/mcp"), {
    requestInit: { headers: authHeaders(cfg) },
  });
  try {
    await client.connect(remote);
  } catch (err) {
    log(`failed to connect to ${cfg.server}/mcp: ${err.message}`);
    if (err.code === 401 || /\b401\b|unauthori[sz]ed/i.test(err.message)) {
      log("Authentication failed: on a team server set ACARD_TOKEN to the server's agent token.");
    }
    return 1;
  }
  const info = client.getServerVersion();
  log(`connected to ${cfg.server}/mcp (${info?.name ?? "unknown"} ${info?.version ?? ""})`);

  const server = new Server(
    { name: info?.name ?? "acard", version: info?.version ?? version },
    { capabilities: { tools: client.getServerCapabilities()?.tools ?? {} }, instructions: client.getInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const local = await rewriteLocalImages(cfg, req.params.name, req.params.arguments);
    if (local.uploaded) log(`uploaded ${local.uploaded} local image/video file(s) and replaced their paths`);
    const out = await client.callTool({ ...req.params, arguments: local.args });
    if (local.errors.length) out.content = [...(out.content || []), { type: "text", text: "Could not upload local images: " + local.errors.join("; ") }];
    return out;
  });

  const local = new StdioServerTransport();
  const closed = new Promise((resolve) => {
    server.onclose = resolve;
  });
  await server.connect(local);
  // MCP stdio shutdown: the client closes our stdin and waits for us to exit. StdioServerTransport does not watch for
  // the end of stdin, so without this the client waits out its 2 s grace period and then kills the proxy (#146).
  process.stdin.once("end", () => server.close());
  await closed;
  await client.close().catch((err) => log(`close failed: ${err.message}`));
  return 0;
}
