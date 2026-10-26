import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAcardMcpServer, OperationFailure } from "../agents/mcp-tools";
import { createAgentToken } from "../agent-api.js";
import { assembleWorkerSource } from "./assemble-worker";
import { setup } from "./db-harness";
import { renderBlocks } from "../block-html.js";
import { markdownToBlocks, blocksToMarkdown } from "../markdown-blocks";

const source = assembleWorkerSource();
const writer = { name: "Image agent", via: "token" as const, scopes: ["read", "write"] };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
let sqlite: Database, env: any, worker: any, writeToken: string, readToken: string, kv: Map<string, any>;
let client: Client, server: ReturnType<typeof createAcardMcpServer>;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  kv = new Map();
  const statement = (sql: string, params: any[] = []) => ({
    bind: (...next: any[]) => statement(sql, next),
    run: async () => ({ success: true, meta: { changes: sqlite.query(sql).run(...params).changes } }),
    all: async () => ({ results: sqlite.query(sql).all(...params) }),
    first: async () => sqlite.query(sql).get(...params) ?? null,
  });
  env = { GATE_PASSWORD: "test-pw", GATE_SECRET: "test-secret", ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    MEDIA: { put: async (key: string, value: ArrayBuffer, options: any) => { kv.set(key, { value, ...options }); } },
    DB: { prepare: statement, batch: async (statements: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try { const out = []; for (const item of statements) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    } } };
  worker = new Function(source)();
  await worker.acardHost.run(env, writer, "whoami", {});
  writeToken = (await createAgentToken(env.DB, { name: writer.name, scopes: writer.scopes })).token;
  readToken = (await createAgentToken(env.DB, { name: "Reader", scopes: ["read"] })).token;
  await worker.acardHost.run(env, writer, "createPage", { slug: "pics", title: "Pics", markdown: "first" });
  server = createAcardMcpServer(async (operation, input) => {
    try { return await worker.acardHost.run(env, writer, operation, input); }
    catch (error: any) { throw new OperationFailure(error.message, error.status); }
  }, "test", worker.acardHost.mcpTools);
  client = new Client({ name: "media-test", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
});

afterEach(async () => { await client.close(); await server.close(); sqlite.close(); });

function upload(bytes: Uint8Array, type: string, page = "pics", token = writeToken) {
  const form = new FormData();
  form.set("page", page);
  form.set("mime", type);
  form.set("file", new File([bytes], "pic", { type }));
  return worker.fetch(new Request("https://notes.test/api/v1/media", { method: "POST", headers: { authorization: "Bearer " + token }, body: form }), env) as Promise<Response>;
}

test("REST upload stores a png for a writable page and returns a markdown line", async () => {
  const response = await upload(PNG, "image/png");
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.mime).toBe("image/png");
  expect(body.markdown).toBe("![pic](/media/" + body.id + ")");
  expect(kv.get("media/" + body.id).metadata.mime).toBe("image/png");
  expect(sqlite.query("SELECT page FROM media WHERE id = ?").get(body.id)).toEqual({ page: "pics" });
});

test("REST upload stores SVG without its script, refuses mismatched bytes, read-only tokens and unknown pages", async () => {
  const svg = await upload(SVG, "image/svg+xml");
  expect(svg.status).toBe(201);
  const stored = new TextDecoder().decode(kv.get("media/" + (await svg.json()).id).value);
  expect(stored).toContain("<svg");
  expect(stored).not.toContain("script");
  kv.clear();
  expect((await upload(SVG, "image/png")).status).toBe(415);
  expect((await upload(PNG, "image/jpeg")).status).toBe(415);
  expect((await upload(PNG, "image/png", "pics", readToken)).status).toBe(403);
  expect((await upload(PNG, "image/png", "nope")).status).toBe(404);
  expect((await upload(PNG, "image/png", "", readToken)).status).toBe(403);
  expect(kv.size).toBe(0);
});

test("MCP upload_media takes base64 and sanitizes SVG", async () => {
  const ok = await client.callTool({ name: "upload_media", arguments: { page: "pics", data: Buffer.from(PNG).toString("base64"), name: "그림.png" } });
  expect(ok.isError).not.toBe(true);
  expect(JSON.parse((ok.content as any)[0].text).url).toMatch(/^\/media\/[0-9a-f]{16}$/);
  const bad = await client.callTool({ name: "upload_media", arguments: { page: "pics", data: Buffer.from(SVG).toString("base64") } });
  expect(bad.isError).not.toBe(true);
  expect(kv.size).toBe(2);
});

test("attach_images refuses missing captions, local paths the server cannot read, and pages without write scope", async () => {
  const h: any = setup();
  await h.call("GET", "/api/tree");
  h.env.MEDIA = { put: async () => {} };
  const writer = { name: "W", via: "token" as const, scopes: ["read", "write"] };
  const reader = { name: "R", via: "token" as const, scopes: ["read"] };
  const run = (op: string, input: unknown, who: any = writer) => h.worker.acardHost.run(h.env, who, op, input);
  await run("createPage", { slug: "p", title: "p", markdown: "x" });
  await expect(run("attachImages", { page: "p", images: [{ src: "/media/0123456789abcdef" }] })).rejects.toThrow(/caption/);
  await expect(run("attachImages", { page: "p", images: [{ src: "C:/Users/me/shot.png", caption: "a" }] })).rejects.toThrow(/CLI/);
  await expect(run("attachImages", { page: "p", images: [{ src: "pasted:1", caption: "a" }] })).rejects.toThrow(/붙여 넣은/);
  await expect(run("attachImages", { page: "p", images: [{ data: Buffer.from(PNG).toString("base64"), caption: "a" }] }, reader)).rejects.toThrow();
  await expect(run("attachVideo", { page: "p", note: "이 PC 에 ffmpeg 가 없어요" })).rejects.toThrow(/ffmpeg/);
  expect((await run("readBlocks", { page: "p" })).blocks.length).toBe(1);
});

test("#176: an image the server could not fetch (a local path) draws a placeholder figure, never the raw path, and keeps its row", () => {
  const path = "C:/Users/PC/AppData/Local/Temp/codex-clipboard-c09acbf7-fc22-42c6-a969-68160f67d858.png";
  const md = "문단\n\n![](" + path + ' "g=v1 agent")\n![기판 부품이 고르게 보임](/media/0123456789abcdef "g=v1 agent")\n![둘째](/media/0123456789abcdee "g=v1 agent")';
  const html = renderBlocks(markdownToBlocks(md), {});
  expect(html).not.toContain("<p>" + path);
  expect(html).not.toContain("C:/Users/PC");
  expect(html).toContain("이미지를 불러올 수 없어요");
  expect(html).toContain("codex-clipboard-c09acbf7-fc22-42c6-a969-68160f67d858.png");
  const row = html.slice(html.indexOf('<div class="imgrow">'));
  expect(row.match(/<figure class="img/g)?.length).toBe(3);
  expect(row).not.toContain('<div class="imgrow"><p>');
  const single = renderBlocks(markdownToBlocks("![캡션](./shot.png)"), {});
  expect(single).toContain("이미지를 불러올 수 없어요");
  expect(single).toContain("shot.png");
  expect(single).toContain("<figcaption>캡션</figcaption>");
  expect(single).not.toContain("<p>./shot.png");
});

test("agent image tokens round-trip through markdown and old width-only images stay unchanged", () => {
  const md = '![a](/media/abc "60 t=1:05 g=v1 agent")\n![b](/media/def "40")\n![c](/media/ghi)';
  const blocks = markdownToBlocks(md);
  expect(blocks.map((b: any) => b.meta)).toEqual([{ src: "/media/abc", width: 60, time: "1:05", group: "v1", agent: true }, { src: "/media/def", width: 40 }, { src: "/media/ghi", width: 100 }]);
  expect(blocksToMarkdown(blocks)).toBe(md.split("\n").join("\n\n"));
  expect(renderBlocks(markdownToBlocks("![c](/media/ghi)"), {})).not.toContain("<style>");
});
