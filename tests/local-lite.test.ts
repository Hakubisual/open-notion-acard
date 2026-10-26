// Desktop light local mode (ACARD_LITE=1, local/lite.ts): agents need the app's token and no foreign Origin/Host, agent
// markdown is stored and shown as written (raw HTML as text, component fences as code), a data folder made without the
// light mode opens with its pages, and the 스킬 링크 check writes a real page through the token.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdown } from "../local/lite";

const APP = join(import.meta.dir, "..", "dist");
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function freePort() { const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const port = probe.port; probe.stop(true); return port; }

async function boot(dataDir: string, lite: boolean) {
  const port = freePort();
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "local", "main.ts")], {
    env: { ...process.env, ACARD_DATA_DIR: dataDir, ACARD_APP_DIR: APP, ACARD_PORT: String(port), ACARD_CLOUD_URL: "", ACARD_LITE: lite ? "1" : "0", ACARD_LOCAL_API: "0", ACARD_AGENT_TOKEN: "" },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  for (let seen = ""; !seen.includes("READY");) {
    const { value, done } = await reader.read();
    if (done) throw new Error("local server exited before READY: " + seen);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const base = "http://127.0.0.1:" + port;
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { origin: base, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
  return { base, port, call, stop: async () => { child.stdin.end(); await child.exited; } };
}
const mcp = (base: string, headers: Record<string, string>, body: unknown) =>
  fetch(base + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

test("agent paths need the app's token, refuse other sites and other Host names, and a rotated token stops working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lite-")); dirs.push(dir);
  const app = await boot(dir, true);
  try {
    const token = readFileSync(join(dir, "agent-token"), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect((await mcp(app.base, {}, list)).status).toBe(401);
    expect((await mcp(app.base, { authorization: "Bearer " + "x".repeat(44) }, list)).status).toBe(401);
    expect((await mcp(app.base, { authorization: "Bearer " + token, origin: "https://evil.example" }, list)).status).toBe(403);
    expect((await fetch(app.base + "/api/v1/pages")).status).toBe(401);
    expect((await fetch(app.base + "/AGENTS.md")).status).toBe(401);
    const rebind = await new Promise<string>((resolve) => {
      Bun.connect({ hostname: "127.0.0.1", port: app.port, socket: {
        open(s) { s.write("GET /api/v1/pages HTTP/1.1\r\nHost: evil.example:" + app.port + "\r\nAuthorization: Bearer " + token + "\r\nConnection: close\r\n\r\n"); },
        data(_s, d) { resolve(new TextDecoder().decode(d).split("\r\n")[0]); },
      } });
    });
    expect(rebind).toContain(" 403 ");
    const tools = await (await mcp(app.base, { authorization: "Bearer " + token }, list)).json() as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual(["append_to_page", "create_page", "list_pages", "read_page", "update_page"]);
    expect((await fetch(app.base + "/__local/lite/new", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.call("/__local/lite/new", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } })).status).toBe(403);
    const rotated = await (await app.call("/__local/skill/rotate", { method: "POST" })).json() as { token: string };
    expect(rotated.token).not.toBe(token);
    expect((await mcp(app.base, { authorization: "Bearer " + token }, list)).status).toBe(401);
    expect((await mcp(app.base, { authorization: "Bearer " + rotated.token }, list)).status).toBe(200);
  } finally { await app.stop(); }
}, 30000);

test("agent markdown is stored and shown as written, the skill check makes a page, and an edit saves with a conflict check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lite-")); dirs.push(dir);
  const app = await boot(dir, true);
  try {
    const token = readFileSync(join(dir, "agent-token"), "utf8").trim();
    const markdown = "# 회의 메모\n\n- [ ] 할 일 하나\n\n```acard-ui {\"ui\":\"stat\"}\n{\"label\":\"x\"}\n```\n\n<b>raw</b> 텍스트";
    const res = await mcp(app.base, { authorization: "Bearer " + token }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_page", arguments: { title: "AI 글", markdown } } });
    const created = JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text) as { slug: string };
    const view = await (await app.call("/__local/lite/page/" + encodeURIComponent(created.slug))).json() as { markdown: string; html: string; updated: number };
    expect(view.markdown.trim()).toBe(markdown);
    expect(view.html).toContain('<code class="language-acard-ui">');
    expect(view.html).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(view.html).not.toContain("<b>");
    const check = await (await app.call("/__local/skill/check", { method: "POST" })).json() as { ok: boolean; slug: string };
    expect(check.ok).toBe(true);
    expect((await app.call("/__local/lite/page/" + encodeURIComponent(check.slug))).status).toBe(200);
    const saved = await app.call("/__local/lite/page/" + encodeURIComponent(created.slug), { method: "PUT", body: JSON.stringify({ title: "AI 글", markdown: view.markdown + "\n\n추가 줄", base: view.updated }) });
    expect(((await saved.json()) as { markdown: string }).markdown).toContain("추가 줄");
    expect((await app.call("/__local/lite/page/" + encodeURIComponent(created.slug), { method: "PUT", body: JSON.stringify({ markdown: "x", base: view.updated }) })).status).toBe(409);
    const shell = await (await app.call("/" + encodeURIComponent(created.slug) + "/", { headers: { accept: "text/html" } })).text();
    expect(shell).toContain('id="tree"');
    expect(shell).not.toContain("editor.js");
  } finally { await app.stop(); }
}, 30000);

test("a data folder made by the full local app (0.1.1) opens in light mode with its pages and component blocks as text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lite-")); dirs.push(dir);
  const full = await boot(dir, false);
  let slug = "";
  try {
    const page = await (await full.call("/api/pages", { method: "POST", body: JSON.stringify({ title: "예전 문서" }) })).json() as { slug: string; updated: number };
    slug = page.slug;
    const blocks = [
      { id: "a", type: "heading1", text: "예전 제목", indent: 0, meta: { color: "red" } },
      { id: "b", type: "part", text: "{\"a\":1}", indent: 0, meta: { part: "chart", v: 1 } },
      { id: "c", type: "paragraph", text: "본문", indent: 0 },
    ];
    expect((await full.call("/api/page/" + encodeURIComponent(slug), { method: "PUT", body: JSON.stringify({ blocks, base_updated: page.updated }) })).status).toBe(200);
  } finally { await full.stop(); }
  const lite = await boot(dir, true);
  try {
    const tree = await (await lite.call("/api/tree")).json() as { pages: { slug: string }[] };
    expect(tree.pages.some((p) => p.slug === slug)).toBe(true);
    const view = await (await lite.call("/__local/lite/page/" + encodeURIComponent(slug))).json() as { markdown: string; html: string; updated: number };
    expect(view.html).toContain("<h1>예전 제목</h1>");
    expect(view.html).toContain('<code class="language-acard-part">');
    const resaved = await lite.call("/__local/lite/page/" + encodeURIComponent(slug), { method: "PUT", body: JSON.stringify({ title: "예전 문서", markdown: view.markdown, base: view.updated }) });
    expect(resaved.status).toBe(200);
    const raw = await (await lite.call("/api/page/" + encodeURIComponent(slug))).json() as { blocks: { type: string; meta?: Record<string, unknown> | null }[] };
    expect(raw.blocks.map((b) => b.type)).toEqual(["heading1", "part", "paragraph"]);
    expect(raw.blocks[0].meta).toMatchObject({ color: "red" });
  } finally { await lite.stop(); }
}, 30000);

test("renderMarkdown drops unsafe link and image schemes", () => {
  const html = renderMarkdown("[a](javascript:alert(1)) [b](https://notes.example.com/) ![x](file:///c/x.png) ![y](/media/abc)");
  expect(html).toContain('href="#"');
  expect(html).toContain('href="https://notes.example.com/"');
  expect(html).not.toContain("file:");
  expect(html).toContain('src="/media/abc"');
});
