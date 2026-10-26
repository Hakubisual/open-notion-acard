import { afterEach, beforeEach, expect, test } from "bun:test";
import { cookie, setup } from "./db-harness";

let h: ReturnType<typeof setup>;
let auth: string;
const mediaId = "0123456789abcdef";
const otherId = "fedcba9876543210";
const blocks = [
  { id: "p", type: "paragraph", text: "Only the shared page body. [[private-page]] [private](/private-page/) [absolute](https://notes.test/private-page/)" },
  { id: "r", type: "paragraph", text: "mention", meta: { richText: [{ text: "mention", mention: { type: "page", slug: "private-page" } }] } },
  { id: "i", type: "image", text: "Shared image", meta: { src: "/media/" + mediaId } },
  { id: "remote", type: "image", text: "remote", meta: { src: "https://tracker.test/pixel" } },
  { id: "crumb", type: "breadcrumb", text: "" },
  { id: "db", type: "db_ref", text: "", meta: { slug: "private-page", html: "<script>private</script>" } },
  { id: "button", type: "button", text: "unsafe", meta: { url: "javascript:alert(1)" } },
];

async function request(path: string, method = "GET", owner = false) {
  return h.worker.fetch(new Request("https://notes.test" + path, { method, headers: owner ? { cookie: auth } : {} }), h.env);
}
async function create() {
  const response = await request("/api/page/shared/share", "POST", true);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; url: string; created: number; last4: string }>;
}

beforeEach(async () => {
  h = setup();
  auth = await cookie();
  expect((await h.call("POST", "/api/pages", { title: "Shared", slug: "shared" })).status).toBe(200);
  expect((await h.call("POST", "/api/pages", { title: "Other page secret title", slug: "private-page" })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/shared", { title: "Shared title", blocks })).status).toBe(200);
  h.sqlite.query("INSERT INTO editor_comments (id, page, text, created, updated) VALUES ('c', 'shared', 'Secret comment text', 1, 1)").run();
  h.env.MEDIA = { getWithMetadata: async (key: string) => ({ value: new TextEncoder().encode(key).buffer, metadata: { mime: "image/png", name: "image.png" } }) };
});
afterEach(() => h.sqlite.close());

test("anonymous private routes stay cookie gated and malformed public routes have identical 404s", async () => {
  for (const path of ["/", "/api/tree", "/api/page/x", "/edit/x", "/p", "/style.css", "/media/" + mediaId]) {
    expect((await request(path)).status).toBe(401);
  }
  const bodies = [];
  for (const path of ["/p/", "/p/bad", "/p/" + "A".repeat(43), "/p/%00", "/p/" + "A".repeat(44)]) {
    const response = await request(path);
    expect(response.status).toBe(404);
    bodies.push(await response.text());
  }
  expect(new Set(bodies).size).toBe(1);
  for (const method of ["GET", "POST", "DELETE"]) expect((await request("/api/page/shared/share", method)).status).toBe(401);
  // The visual kit's static pictures under /kit/ reach signed-out readers of a shared page (served by ASSETS, like /fonts/).
  const served: string[] = [];
  h.env.ASSETS = { fetch: async (req: Request) => { served.push(new URL(req.url).pathname); return new Response("img", { status: 200 }); } };
  expect((await request("/kit/headers/desk.webp")).status).toBe(200);
  expect(served).toEqual(["/kit/headers/desk.webp"]);
});

test("valid public link renders exactly one page without private navigation or active remote content", async () => {
  const link = await create();
  const response = await request(link.url);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Shared title");
  expect(html).toContain("Only the shared page body.");
  expect(html).toContain("private-page");
  expect(html).toMatch(new RegExp('src="' + link.url + "/media/" + mediaId + '\\?k=\\d+\\.[A-Za-z0-9_-]{43}"'));
  for (const hidden of ["Other page secret title", "Secret comment text", "sidebar", "backlinks", "/edit/", "javascript:", "tracker.test", "<iframe", "<script", 'href="/private-page/', 'href="https://notes.test/private-page/', 'data-page=']) expect(html).not.toContain(hidden);
});

test("public responses forbid storage and indexing, never issue cookies, and support HEAD", async () => {
  const link = await create();
  for (const path of [link.url, link.url + "/media/" + mediaId, "/p/bad"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(path, method);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
  }
  expect(await (await request(link.url)).text()).toContain('<meta name="robots" content="noindex">');
});

test("non-read methods fail identically before token lookup", async () => {
  const link = await create();
  for (const path of [link.url, "/p/bad", link.url + "/media/" + mediaId]) {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await request(path, method);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  }
});

test("only embedded media is accessible and removing a reference removes access", async () => {
  const link = await create();
  const signed = new RegExp(link.url + "/media/" + mediaId + "\\?k=[0-9]+\\.[A-Za-z0-9_-]{43}").exec(await (await request(link.url)).text())![0];
  expect((await request(signed)).status).toBe(200);
  expect((await request(link.url + "/media/" + mediaId)).status).toBe(302);
  expect((await request(link.url + "/media/" + otherId)).status).toBe(404);
  h.sqlite.query("DELETE FROM blocks WHERE page = 'shared' AND id = 'i'").run();
  expect((await request(signed)).status).toBe(404);
  expect((await request(link.url + "/media/" + mediaId)).status).toBe(404);
});

test("a valid owner cookie grants no additional content on public routes", async () => {
  const link = await create();
  expect(await (await request(link.url, "GET", true)).text()).toBe(await (await request(link.url)).text());
  expect((await request(link.url + "/media/" + otherId, "GET", true)).status).toBe(404);
  expect((await request("/p/bad", "GET", true)).status).toBe(404);
});

test("database stores only SHA-256 hashes and listing never recovers token URLs", async () => {
  const link = await create();
  const token = link.url.slice(3);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(token, "base64url").byteLength).toBe(32);
  const expected = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  const rows = h.sqlite.query("SELECT * FROM share_links").all() as any[];
  expect(rows).toEqual([{ token_hash: expected, page: "shared", created: link.created, revoked: null, noindex: 1 }]);
  expect(link.id).toBe(expected);
  expect(JSON.stringify(rows)).not.toContain(token);
  const list = await request("/api/page/shared/share", "GET", true);
  const body = await list.json();
  expect(body).toEqual({ links: [{ id: expected, created: link.created, last4: expected.slice(-4) }] });
  expect(JSON.stringify(body)).not.toContain(token);
  expect(JSON.stringify(body)).not.toContain("/p/");
});

test("revocation is page scoped and revoked tokens use the same missing response", async () => {
  const link = await create();
  expect((await request("/api/page/private-page/share/" + link.id, "DELETE", true)).status).toBe(404);
  expect((await request(link.url)).status).toBe(200);
  expect((await request("/api/page/shared/share/" + link.id, "DELETE", true)).status).toBe(200);
  const response = await request(link.url);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe(await (await request("/p/bad")).text());
  expect((await request(link.url + "/media/" + mediaId)).status).toBe(404);
  expect(await (await request("/api/page/shared/share", "GET", true)).json()).toEqual({ links: [] });
});

test("trash and missing gate configuration fail closed", async () => {
  const link = await create();
  h.sqlite.query("INSERT INTO editor_trash (page, deleted) VALUES ('shared', 1)").run();
  expect((await request(link.url)).status).toBe(404);
  expect((await request(link.url + "/media/" + mediaId)).status).toBe(404);
  expect((await request("/api/page/shared/share", "POST", true)).status).toBe(404);
  delete h.env.GATE_SECRET;
  expect((await request(link.url)).status).toBe(503);
});

test("a public link keeps block colors, callout icons, heading 4 and toggle headings, and still drops widget embeds (notion-parity-1)", async () => {
  const styled = [
    { id: "c", type: "paragraph", text: "red text", meta: { color: "red" } },
    { id: "k", type: "callout", text: "careful", meta: { tone: "note", icon: "🔥", color: "yellow_background" } },
    { id: "h", type: "heading4", text: "small heading" },
    { id: "t", type: "heading2", text: "folding", meta: { toggle: true } },
    { id: "u", type: "paragraph", text: "inside", indent: 1 },
    { id: "e", type: "embed", text: "", meta: { url: "https://x.github.io/widget", height: 480 } },
  ];
  expect((await h.call("PUT", "/api/page/shared", { title: "Shared title", blocks: styled })).status).toBe(200);
  const link = await create();
  const html = await (await request(link.url)).text();
  expect(html).toContain('<p class="bc-red">red text</p>');
  expect(html).toContain('<span class="callout-ico" aria-hidden="true">🔥</span>');
  expect(html).toContain(".bc-red{color:var(--tag-red-fg)}");
  expect(html).toContain(".blocks .callout.bc-yellow_background{background:var(--tag-yellow-bg)}");
  expect(html).toContain('<h5 id="small-heading">small heading</h5>');
  expect(html).toContain('<details class="toggle heading"><summary><h3 id="folding">folding</h3></summary>');
  expect(html).toContain("details.toggle.heading>summary");
  expect(html).not.toContain("x.github.io");
  expect(html).not.toContain("<script>(function(){function o()");
});
