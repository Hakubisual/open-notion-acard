import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { TOKEN } from "./fake-server.js";
import { BIN } from "./run.js";

let remote;
const seenAuth = [];
const uploads = [];

function buildRemoteServer() {
  const server = new McpServer({ name: "acard-remote-fake", version: "9.9.9" });
  server.registerTool(
    "create_page",
    { description: "create", inputSchema: { title: z.string(), markdown: z.string() } },
    async ({ markdown }) => ({ content: [{ type: "text", text: markdown }] }),
  );
  server.registerTool(
    "append_to_page",
    { description: "append", inputSchema: { slug: z.string(), markdown: z.string() } },
    async ({ markdown }) => ({ content: [{ type: "text", text: markdown }] }),
  );
  for (const name of ["attach_images", "attach_video"]) {
    server.registerTool(
      name,
      { description: name, inputSchema: { page: z.string(), images: z.array(z.any()).optional(), frames: z.array(z.any()).optional(), video: z.any().optional(), note: z.string().optional(), path: z.string().optional(), count: z.number().optional(), upload_video: z.boolean().optional() } },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
    );
  }
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  return server;
}

beforeAll(() => {
  remote = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/media") {
        uploads.push({ search: new URL(req.url).search, type: req.headers.get("content-type"), size: (await req.arrayBuffer()).byteLength });
        return Response.json({ url: "/media/00000000000000a" + uploads.length }, { status: 201 });
      }
      if (path !== "/mcp") return new Response("not found", { status: 404 });
      seenAuth.push(req.headers.get("authorization"));
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "invalid token" }, { status: 401 });
      // Stateless: one server + transport per request.
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await buildRemoteServer().connect(transport);
      return transport.handleRequest(req);
    },
  });
});

afterAll(() => remote.stop(true));

test("acard mcp proxies tools/list and tools/call over stdio", async () => {
  const env = { ...process.env, ACARD_TOKEN: TOKEN, ACARD_URL: `http://localhost:${remote.port}` };
  const transport = new StdioClientTransport({ command: "node", args: [BIN, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    expect(client.getServerVersion()?.name).toBe("acard-remote-fake");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["create_page", "append_to_page", "attach_images", "attach_video", "echo"]);
    expect(tools[4].inputSchema.properties.text.type).toBe("string");
    const result = await client.callTool({ name: "echo", arguments: { text: "안녕" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: 안녕" }]);
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((h) => h === `Bearer ${TOKEN}`)).toBe(true);
  } finally {
    await client.close();
  }
// Spawns the CLI several times (node start-up each); a cold Windows CI runner needs more than bun's 5 s default.
}, 20000);

test("acard mcp uploads local image paths before forwarding a write and rewrites them to /media/", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "acard-img-"));
  writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const env = { ...process.env, ACARD_TOKEN: TOKEN, ACARD_URL: `http://localhost:${remote.port}` };
  const transport = new StdioClientTransport({ command: "node", args: [BIN, "mcp"], env, cwd: dir, stderr: "pipe" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "append_to_page", arguments: { slug: "notes", markdown: "![화면](./shot.png)\n\n![웹](https://x.test/a.png)\n\n![없음](./missing.png)" } });
    expect(result.content[0].text).toBe("![화면](/media/00000000000000a1)\n\n![웹](https://x.test/a.png)\n\n![없음](./missing.png)");
    expect(uploads).toEqual([{ search: "?page=notes&name=shot.png", type: "image/png", size: 8 }]);
    const made = await client.callTool({ name: "create_page", arguments: { title: "새", markdown: "![s](./shot.png)" } });
    expect(made.content[0].text).toBe("![s](/media/00000000000000a2)");
    expect(uploads[1].search).toBe("?name=shot.png");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
// One CLI start + connect: 0.5-1.2 s alone on the Windows build host (was 2.4-3.5 s while every close waited out the
// SDK's 2 s kill grace, #146), so 10 s leaves room for a loaded machine without hiding a hang.
}, 10000);

test("acard mcp exits on its own (code 0) when the client closes its stdin", async () => {
  const env = { ...process.env, ACARD_TOKEN: TOKEN, ACARD_URL: `http://localhost:${remote.port}` };
  const proc = Bun.spawn(["node", BIN, "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Wait for the proxy's own "connected" line, then end stdin the way the MCP stdio client does on close.
  const reader = proc.stderr.getReader();
  for (let seen = ""; !seen.includes("connected to");) {
    const { value, done } = await reader.read();
    if (done) throw new Error("acard mcp exited before connecting: " + seen);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  expect(proc.signalCode).toBeNull();
}, 10000);

test("attach_images uploads local paths and the image the user pasted (from the chat transcript); attach_video sends ffmpeg keyframes with times", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "acard-att-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  writeFileSync(join(dir, "shot.png"), png);
  const transcript = join(dir, "t.jsonl");
  const pasted = (b) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "봐" }, { type: "image", source: { type: "base64", media_type: "image/png", data: b.toString("base64") } }] } });
  writeFileSync(transcript, pasted(png) + "\n" + pasted(Buffer.concat([png, Buffer.from([9, 9, 9])])) + "\n");
  let ffmpeg = true;
  try { execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=160x120:rate=10", "-pix_fmt", "yuv420p", "-y", join(dir, "clip.mp4")], { stdio: "ignore" }); } catch { ffmpeg = false; }
  // Without ffmpeg the clip still has to exist, so attach_video reaches the "install ffmpeg" note instead of "file not found".
  if (!ffmpeg) writeFileSync(join(dir, "clip.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  const start = uploads.length;
  const env = { ...process.env, ACARD_TOKEN: TOKEN, ACARD_URL: `http://localhost:${remote.port}`, ACARD_TRANSCRIPT: transcript };
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [BIN, "mcp"], env, cwd: dir, stderr: "pipe" }));
  try {
    const raw = await client.callTool({ name: "attach_images", arguments: { page: "bug", images: [{ src: "./shot.png", caption: "화면" }, { src: "pasted:1", caption: "붙인 것" }] } });
    if (raw.isError) throw new Error(raw.content.map((c) => c.text).join(" | "));
    const att = JSON.parse(raw.content[0].text);
    expect(att.images.map((i) => i.src)).toEqual([expect.stringMatching(/^\/media\//), expect.stringMatching(/^\/media\//)]);
    expect(uploads.slice(start).map((u) => [u.search, u.size])).toEqual([["?page=bug&name=shot.png", 10], ["?page=bug&name=pasted-1.png", 13]]);
    const vid = JSON.parse((await client.callTool({ name: "attach_video", arguments: { page: "bug", path: "./clip.mp4", count: 3 } })).content[0].text);
    expect(vid.path).toBeUndefined();
    if (ffmpeg) {
      expect(vid.frames.map((f) => f.time)).toEqual(["0:00", "0:02", "0:03"]);
      expect(uploads.slice(start + 2).every((u) => u.type === "image/jpeg")).toBe(true);
    } else expect(vid.note).toContain("ffmpeg");
    const none = JSON.parse((await client.callTool({ name: "attach_video", arguments: { page: "bug", path: "./missing.mp4" } })).content[0].text);
    expect(none.note).toContain("missing.mp4");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
// Spawns the CLI and runs ffmpeg for keyframes: 3.4-5.0 s on the Windows build host, so bun's 5 s default flakes.
}, 20000);

test("without ffmpeg attach_video sends a clear note instead of frames", async () => {
  const { extractFrames } = await import("../src/local-images.js");
  const prev = process.env.ACARD_FFPROBE;
  process.env.ACARD_FFPROBE = "acard-no-such-ffprobe";
  try { expect(extractFrames(import.meta.path, 4)).toEqual({ frames: [], note: expect.stringContaining("ffmpeg") }); }
  finally { if (prev === undefined) delete process.env.ACARD_FFPROBE; else process.env.ACARD_FFPROBE = prev; }
});
