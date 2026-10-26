import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleWorkerSource } from "./assemble-worker";
import { pgD1 } from "../gate/pg-d1";

mock.module("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const ROOT = join(import.meta.dir, "..");
const SUPABASE = "https://supa.test";
const OWNER_UID = "00000000-0000-4000-8000-000000000001";
const SECRET_TEXT = "zebra-other-confidential";
const ROOT_MEDIA = "1111111111111111";
const OTHER_MEDIA = "2222222222222222";

// D1 and workspace Durable Objects refuse more than 100 bound parameters in one statement; a test can turn that on.
let maxParams = Infinity;
// Member stores answer over the network, so overlapping requests interleave between statements; a test can turn on a
// read whose result arrives on a later turn to get the same interleaving here.
let slowReads = false;
const later = <T>(value: T) => (slowReads ? new Promise<T>((done) => setImmediate(() => done(value))) : value);
function d1(sqlite: Database) {
  const limit = (params: unknown[]) => { if (params.length > maxParams) throw new Error("too many SQL variables: " + params.length); };
  const statement = (sql: string, params: unknown[] = []): any => ({
    sql, params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { limit(params); return { success: true, meta: { changes: sqlite.query(sql).run(...(params as any[])).changes } }; },
    all: async () => { limit(params); return later({ results: sqlite.query(sql).all(...(params as any[])) }); },
    first: async () => { limit(params); return later(sqlite.query(sql).get(...(params as any[])) ?? null); },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: any[]) => {
      sqlite.exec("BEGIN");
      try { const out = []; for (const item of list) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}

let worker: any;
let env: any;
let owner: Database;
let keyPair: CryptoKeyPair;
let dir: string;
let ownerCookie: string;
const realFetch = globalThis.fetch;
const b64url = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

async function jwt(sub: string) {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ sub, email: "owner@test.dev", exp: Math.floor(Date.now() / 1000) + 600, iss: SUPABASE + "/auth/v1", aud: "authenticated", role: "authenticated" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(sig);
}

type Opts = { cookie?: string; bearer?: string; body?: unknown; form?: Record<string, string>; origin?: string };
async function call(method: string, path: string, opts: Opts = {}) {
  if (method === "PUT" && /^\/api\/page\/[^/]+$/.test(path) && opts.body && typeof opts.body === "object" && !("base_updated" in opts.body)) {
    const page = await call("GET", path, { cookie: opts.cookie });
    opts = { ...opts, body: { ...opts.body, base_updated: page.data?.page?.updated } };
  }
  const headers: Record<string, string> = { accept: "text/html,application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = "Bearer " + opts.bearer;
  if (opts.origin) headers.origin = opts.origin;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  if (opts.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(opts.form).toString(); }
  const res: Response = await worker.fetch(new Request("https://notes.example.com" + path, { method, headers, redirect: "manual", body }), env, {});
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers };
}
const asOwner = (method: string, path: string, opts: Opts = {}) => call(method, path, { ...opts, cookie: ownerCookie });

async function invite(slug: string, email: string, role = "read") {
  const made = await asOwner("POST", "/api/page/" + slug + "/access", { body: { email, role } });
  expect(made.status).toBe(201);
  return made.data.invites[0] as { url: string; code: string; rule: string };
}
async function verify(found: { url: string; code: string }, email: string) {
  const done = await call("POST", found.url, { form: { email, code: found.code } });
  expect(done.status).toBe(303);
  const cookie = /acard_guest=([^;]+)/.exec(done.headers.get("set-cookie") ?? "");
  expect(cookie).not.toBeNull();
  expect(done.headers.get("set-cookie")).toContain("HttpOnly");
  expect(done.headers.get("set-cookie")).toContain("Secure");
  expect(done.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(done.headers.get("set-cookie")).not.toContain("Domain=");
  return "acard_guest=" + cookie![1];
}

beforeAll(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "acard-share-"));
  const core = join(dir, "acard-core.js");
  await writeFile(core, "const __mod = (function () {\n" + assembleWorkerSource() + "\n})();\nexport default __mod;\nexport const acardHost = __mod.acardHost;\n");
  const built = await Bun.build({
    entrypoints: [join(ROOT, "gate", "agent-entry.ts")],
    format: "esm", target: "browser", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers"],
    plugins: [{ name: "core", setup(build) { build.onResolve({ filter: /[\\/]acard-core\.js$/ }, () => ({ path: core })); } }],
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const out = join(dir, "worker.mjs");
  await writeFile(out, await built.outputs[0].text());
  worker = (await import(out)).default;

  keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SUPABASE + "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
    if (url.startsWith(SUPABASE + "/rest/v1/profiles")) return Response.json([{ id: "x", display_name: "t", handle: "t", onboarded_at: "2026-10-16T00:00:00Z" }]);
    if (url.startsWith(SUPABASE)) return Response.json({}, { status: 401 });
    return realFetch(input, init);
  }) as typeof fetch;

  owner = new Database(":memory:");
  const media = new Map<string, Uint8Array>([["media/" + ROOT_MEDIA, new Uint8Array([1])], ["media/" + OTHER_MEDIA, new Uint8Array([2])]]);
  const assets: Record<string, string> = { "/style.css": "body{}", "/tokens.css": ":root{}", "/editor.html": "<html>EDITOR</html>", "/other/index.html": "<html>OWNER STATIC " + SECRET_TEXT + "</html>", "/search-index.json": "[\"" + SECRET_TEXT + "\"]" };
  env = {
    DB: d1(owner),
    MEDIA: {
      get: async (key: string) => media.get(key) ?? null,
      getWithMetadata: async (key: string) => (media.has(key) ? { value: media.get(key)!.buffer, metadata: { mime: "image/png", name: "x.png" } } : { value: null, metadata: null }),
      put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }),
    },
    GATE_PASSWORD: "pw", GATE_SECRET: "secret",
    OWNER_USER_ID: OWNER_UID,
    SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: "anon",
    ASSETS: { fetch: async (request: Request) => {
      const raw = new URL(request.url).pathname;
      const path = raw.endsWith("/") && raw !== "/" ? raw + "index.html" : raw;
      const body = assets[path];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "text/css" } });
    } },
  };
  ownerCookie = "acard_at=" + (await jwt(OWNER_UID));
  for (const [slug, title, parent] of [["root", "Shared root", null], ["child", "Shared child", "root"], ["grand", "Shared grand", "child"], ["other", "Other " + SECRET_TEXT, null]] as const) {
    expect((await asOwner("POST", "/api/pages", { body: { title, slug, parent } })).status).toBe(200);
  }
  const put = (slug: string, blocks: unknown[]) => asOwner("PUT", "/api/page/" + slug, { body: { blocks } });
  expect((await put("root", [{ id: "r1", type: "paragraph", text: "root body" }, { id: "img", type: "image", text: "", meta: { src: "/media/" + ROOT_MEDIA } }, { id: "lnk", type: "paragraph", text: "see [[other]]" }])).status).toBe(200);
  expect((await put("child", [{ id: "c1", type: "paragraph", text: "child body" }])).status).toBe(200);
  expect((await put("other", [{ id: "o1", type: "paragraph", text: SECRET_TEXT + " see [[root]]" }, { id: "img", type: "image", text: "", meta: { src: "/media/" + OTHER_MEDIA } }])).status).toBe(200);
  owner.query("INSERT INTO media (id, page, name, mime, bytes, created) VALUES (?, 'other', 'o.png', 'image/png', 1, 1)").run(OTHER_MEDIA);
  owner.query("INSERT INTO editor_comments (id, page, text, created, updated) VALUES ('oc', 'other', ?, 1, 1)").run(SECRET_TEXT);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("sharing", () => {
  test("an invited email proves the code, reads the page and its sub-pages, and nothing else", async () => {
    const found = await invite("root", "Guest@Example.com");
    expect(found.url).toMatch(/^\/s\/o\/i\/[A-Za-z0-9_-]{43}$/);
    expect(found.code).toMatch(/^\d{6}$/);
    expect((await call("GET", "/root/")).status).toBe(303);
    expect((await call("GET", found.url, { cookie: "acard_lang=ko" })).text).toContain("코드");
    expect((await call("GET", found.url)).text).toContain("Confirm and open");
    expect((await call("POST", found.url, { form: { email: "guest@example.com", code: found.code === "000000" ? "111111" : "000000" } })).status).toBe(401);
    expect((await call("POST", found.url, { form: { email: "someone@else.dev", code: found.code } })).status).toBe(401);
    const guest = await verify(found, "guest@example.com");
    expect((await call("POST", found.url, { form: { email: "guest@example.com", code: found.code } })).status).toBe(401);

    const tree = await call("GET", "/api/tree", { cookie: guest });
    expect(tree.data.pages.map((p: any) => p.slug).sort()).toEqual(["child", "grand", "root"]);
    expect(tree.data.pages.find((p: any) => p.slug === "root").parent).toBeNull();
    for (const path of ["/root/", "/child/", "/grand/"]) expect((await call("GET", path, { cookie: guest })).status).toBe(200);
    const page = await call("GET", "/root/", { cookie: guest });
    expect(page.text).toContain("root body");
    expect(page.text).not.toContain(SECRET_TEXT);
    expect((await call("GET", "/other/", { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/api/page/other", { cookie: guest })).status).toBe(401);
    expect(JSON.stringify((await call("GET", "/api/search?q=zebra", { cookie: guest })).data)).not.toContain("other");
    expect((await call("GET", "/media/" + ROOT_MEDIA, { cookie: guest })).status).toBe(200);
    expect((await call("GET", "/media/" + OTHER_MEDIA, { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/api/media/" + ROOT_MEDIA + "/meta", { cookie: guest })).status).toBe(200);
    expect((await call("GET", "/api/media/" + OTHER_MEDIA + "/meta", { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/search-index.json", { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/api/backlinks?slug=root", { cookie: guest })).data).toEqual({ backlinks: [] });
    expect((await call("PUT", "/api/page/root", { cookie: guest, body: { blocks: [] } })).status).toBe(401);
    expect((await call("GET", "/edit/root/", { cookie: guest })).status).toBe(302);
    expect((await call("GET", "/api/page/root/access", { cookie: guest })).data).toEqual({ page: "root", role: "read" });
    expect((await call("POST", "/api/page/root/access", { cookie: guest, body: { email: "x@y.dev", role: "full" } })).status).toBe(401);

    const access = await asOwner("GET", "/api/page/child/access");
    expect(access.data.people).toEqual([expect.objectContaining({ email: "guest@example.com", role: "read", inherited: true })]);
    expect(await asOwner("PATCH", "/api/page/root/access/rules/" + found.rule, { body: { role: "edit" } })).toMatchObject({ status: 200 });
    expect((await call("PUT", "/api/page/child", { cookie: guest, body: { blocks: [{ id: "c1", type: "paragraph", text: "edited by guest" }] } })).status).toBe(200);
    expect((await asOwner("GET", "/api/page/child")).data.blocks[0].text).toBe("edited by guest");
    expect((await call("PUT", "/api/page/other", { cookie: guest, body: { blocks: [] } })).status).toBe(401);
    expect((await call("POST", "/api/page/child/move", { cookie: guest, body: { parent: "other" } })).status).toBe(401);
    expect((await call("DELETE", "/api/page/root", { cookie: guest })).status).toBe(401);

    expect((await asOwner("DELETE", "/api/page/root/access/rules/" + found.rule)).status).toBe(200);
    expect((await call("GET", "/root/", { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/api/page/root", { cookie: guest })).status).toBe(401);
  });

  test("sub-pages can stop inheriting and restore it", async () => {
    const found = await invite("root", "inherit@example.com");
    const guest = await verify(found, "inherit@example.com");
    expect((await asOwner("PUT", "/api/page/child/access/settings", { body: { inherit: false } })).status).toBe(200);
    expect((await call("GET", "/child/", { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/grand/", { cookie: guest })).status).toBe(401);
    expect((await asOwner("GET", "/api/page/child/access")).data).toMatchObject({ inherit: false, people: [] });
    expect((await asOwner("PUT", "/api/page/child/access/settings", { body: { inherit: true } })).status).toBe(200);
    expect((await call("GET", "/grand/", { cookie: guest })).status).toBe(200);
    await asOwner("DELETE", "/api/page/root/access/rules/" + found.rule);
  });

  test("anyone with the link reads the page and sub-pages until the link is turned off or expires", async () => {
    const on = await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } });
    expect(on.status).toBe(200);
    const url = on.data.link.url as string;
    expect(url).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
    expect((await asOwner("GET", "/api/page/root/access")).data.link.url).toBe(url);
    const page = await call("GET", url);
    expect(page.status).toBe(200);
    expect(page.text).toContain("root body");
    expect(page.text).not.toContain(SECRET_TEXT);
    expect(page.text).toContain('<meta property="og:title" content="Acard">');
    // #118: the preview image URL carries the og.png content hash the build put in ACARD_STATIC_VERSIONS.
    (globalThis as any).ACARD_STATIC_VERSIONS = { "og.png": "og118abc" };
    try {
      const versioned = (await call("GET", url)).text;
      for (const key of ['property="og:image"', 'name="twitter:image"']) expect(versioned).toContain("<meta " + key + ' content="https://notes.example.com/og.png?v=og118abc">');
    } finally { delete (globalThis as any).ACARD_STATIC_VERSIONS; }
    expect(page.text).not.toMatch(/<meta (?:property|name)="(?:og|twitter):[a-z]+" content="[^"]*(?:Shared root|root body)/);
    expect(page.text).not.toContain('rel="canonical"');
    expect(page.text).toContain(url + "/child/");
    expect((await call("GET", url + "/child/")).status).toBe(200);
    expect((await call("GET", url + "/other/")).status).toBe(404);
    // #165: the page names its file with a signed address that runs out; the old unsigned one redirects to a fresh one.
    const signedSrc = new RegExp(url + "/media/" + ROOT_MEDIA + "\\?k=(\\d+)\\.([A-Za-z0-9_-]{43})").exec(page.text);
    expect(signedSrc).not.toBeNull();
    const ends = Number(signedSrc![1]) * 1000;
    expect(ends).toBeGreaterThan(Date.now() + 2 * 3600 * 1000 - 1000);
    expect(ends).toBeLessThanOrEqual(Date.now() + 3 * 3600 * 1000);
    expect((await call("GET", signedSrc![0])).status).toBe(200);
    const legacy = await call("GET", url + "/media/" + ROOT_MEDIA);
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get("location")).toMatch(new RegExp("^" + url + "/media/" + ROOT_MEDIA + "\\?k=\\d+\\.[A-Za-z0-9_-]{43}$"));
    expect((await call("GET", legacy.headers.get("location")!)).status).toBe(200);
    const tampered = signedSrc![0].slice(0, -1) + (signedSrc![0].endsWith("A") ? "B" : "A");
    expect((await call("GET", tampered)).status).toBe(403);
    expect((await call("GET", url + "/media/" + ROOT_MEDIA + "?k=" + Math.floor(Date.now() / 1000 - 60) + "." + signedSrc![2])).status).toBe(403);
    expect((await call("GET", url + "/media/" + OTHER_MEDIA)).status).toBe(404);
    expect((await call("GET", url + "/media/" + OTHER_MEDIA + "?k=" + signedSrc![1] + "." + signedSrc![2])).status).toBe(404);
    expect((await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read", expires: Date.now() - 1000 } })).status).toBe(200);
    expect((await call("GET", url)).status).toBe(401);
    // A signed file address still inside its hours stops with the link.
    expect((await call("GET", signedSrc![0])).status).toBe(401);
    expect((await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "invited" } })).status).toBe(200);
    expect((await call("GET", url)).status).toBe(401);
  });

  test("a shared video keeps its first-frame poster through the link's media route; a poster from another page is dropped", async () => {
    const on = await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } });
    const url = on.data.link.url as string;
    const video = (poster: string) => [{ id: "r1", type: "paragraph", text: "root body" }, { id: "v", type: "video", text: "", meta: { url: "/media/" + ROOT_MEDIA, poster } }];
    expect((await asOwner("PUT", "/api/page/root", { body: { blocks: video("/media/" + OTHER_MEDIA) } })).status).toBe(200);
    const shown = await call("GET", url);
    const poster = new RegExp('poster="(' + url + "/media/" + OTHER_MEDIA + '\\?k=[^"]+)"').exec(shown.text);
    expect(poster).not.toBeNull();
    expect((await call("GET", poster![1])).status).toBe(200);
    expect((await asOwner("PUT", "/api/page/root", { body: { blocks: video("/media/zzzz") } })).status).toBe(200);
    const plain = await call("GET", url);
    expect(plain.text).toMatch(new RegExp('<video controls preload="metadata" src="' + url + "/media/" + ROOT_MEDIA + '\\?k=\\d+\\.[A-Za-z0-9_-]{43}">'));
    expect((await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "invited" } })).status).toBe(200);
  });

  // #61: shared pages sent every original image (31 JPEGs, 7 MB on the owner's page) at full size with no dimensions.
  test("a link page draws components with their styles and an unknown block as a fallback card (ds10)", async () => {
    const blocks = [{ id: "r1", type: "paragraph", text: "root body" }, { id: "u1", type: "component", text: '{"label":"방문","value":"1,284","delta":"+8%"}', meta: { ui: "stat" } }, { id: "u2", type: "component", text: "{ bad", meta: { ui: "stat" } }, { id: "u3", type: "future_block", text: "", meta: null }];
    expect((await asOwner("PUT", "/api/page/root", { body: { blocks } })).status).toBe(200);
    const url = (await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } })).data.link.url as string;
    const page = await call("GET", url);
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-ui="stat"');
    expect(page.text).toContain("1,284");
    expect(page.text).toContain('data-ui-invalid="1"');
    expect(page.text).toContain('class="ui-fallback"');
    expect(page.text).toContain(".ui-stat{");
  });

  test("a link page keeps a card-grid card's box when its private link is dropped (#105)", async () => {
    const blocks = [{ id: "r1", type: "paragraph", text: "root body" }, { id: "c1", type: "component", text: '{"items":[{"title":"빠른 시작","href":"/new"},{"title":"협업"}]}', meta: { ui: "card-grid" } }];
    expect((await asOwner("PUT", "/api/page/root", { body: { blocks } })).status).toBe(200);
    const url = (await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } })).data.link.url as string;
    const page = await call("GET", url);
    expect(page.text.match(/class="ui-cards-item"/g)).toHaveLength(2);
    expect(page.text).not.toContain('href="/new"');
  });

  test("a link page sends sized AVIF/WebP copies with width/height, lazy below the first image, original kept as the link", async () => {
    const on = await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } });
    const url = on.data.link.url as string;
    const calls: string[] = [];
    env.IMAGE_RESIZER = { fetch: async (target: string) => {
      calls.push(new URL(target).pathname + new URL(target).search);
      if (target.endsWith("/meta")) return Response.json({ width: 1600, height: 900, format: "image/jpeg", lqip: "data:image/webp;base64,AAAA" });
      return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "image/webp" } });
    } };
    try {
      const blocks = [{ id: "r1", type: "paragraph", text: "root body" }, { id: "img", type: "image", text: "", meta: { src: "/media/" + ROOT_MEDIA } }, { id: "img2", type: "image", text: "", meta: { src: "/media/" + ROOT_MEDIA, width: 50 } }];
      expect((await asOwner("PUT", "/api/page/root", { body: { blocks } })).status).toBe(200);
      const page = await call("GET", url);
      expect(page.status).toBe(200);
      const imgs = [...page.text.matchAll(/<img [^>]*src="[^"]*\/media\/[^>]*>/g)].map((m) => m[0]);
      expect(imgs.length).toBe(2);
      for (const img of imgs) {
        expect(img).toContain('width="1600"');
        expect(img).toContain('height="900"');
        const k = /\?k=\d+\.[A-Za-z0-9_-]{43}/.exec(img)![0];
        expect(img).toContain(url + "/media/" + ROOT_MEDIA + "/480.webp" + k + " 480w, " + url + "/media/" + ROOT_MEDIA + "/960.webp" + k + " 960w, " + url + "/media/" + ROOT_MEDIA + "/1440.webp" + k + " 1440w\"");
        expect(img).toContain("sizes=");
      }
      expect(imgs[0]).toContain('loading="eager"');
      expect(imgs[0]).toContain("data:image/webp;base64,AAAA");
      expect(imgs[1]).toContain('loading="lazy"');
      expect(imgs[1]).toContain("calc(0.5 * 760px)");
      const k = /\?k=\d+\.[A-Za-z0-9_-]{43}/.exec(imgs[0])![0];
      expect(page.text).toContain('<source type="image/avif" srcset="' + url + "/media/" + ROOT_MEDIA + "/480.avif" + k + " 480w");
      expect(page.text).toContain('href="' + url + "/media/" + ROOT_MEDIA + k + '"');
      expect(page.text).not.toContain('"/media/' + ROOT_MEDIA);
      expect(page.text).not.toContain(" /media/" + ROOT_MEDIA);
      expect((await call("GET", url + "/media/" + ROOT_MEDIA + "/960.webp")).status).toBe(302);
      const variant = await call("GET", url + "/media/" + ROOT_MEDIA + "/960.webp" + k);
      expect(variant.status).toBe(200);
      expect(variant.headers.get("content-type")).toBe("image/webp");
      expect(variant.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      expect(calls).toContain("/resize?w=960&f=webp");
      expect((await call("GET", url + "/media/" + OTHER_MEDIA + "/960.webp")).status).toBe(404);
      expect((await call("GET", url + "/media/" + ROOT_MEDIA + "/123.webp")).status).toBe(404);
    } finally {
      delete env.IMAGE_RESIZER;
      await asOwner("PUT", "/api/page/root", { body: { blocks: [{ id: "r1", type: "paragraph", text: "root body" }, { id: "img", type: "image", text: "", meta: { src: "/media/" + ROOT_MEDIA } }, { id: "lnk", type: "paragraph", text: "see [[other]]" }] } });
    }
  });

  test("a link page is served from the edge cache until the live feed number moves, then read again", async () => {
    const on = await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } });
    const url = on.data.link.url as string;
    const store = new Map<string, Response>();
    let seq = 7;
    (globalThis as any).caches = { default: {
      match: async (key: Request) => store.get(key.url)?.clone() ?? undefined,
      put: async (key: Request, res: Response) => { store.set(key.url, res.clone()); },
    } };
    env.LIVE = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ id: seq }) }) };
    try {
      const first = await call("GET", url);
      expect(first.headers.get("x-acard-share-cache")).toBe("miss");
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      owner.query("UPDATE blocks SET text = 'changed directly' WHERE page = 'root' AND id = 'r1'").run();
      const second = await call("GET", url);
      expect(second.headers.get("x-acard-share-cache")).toBe("hit");
      expect(second.text).toContain("root body");
      seq = 8;
      const third = await call("GET", url);
      expect(third.headers.get("x-acard-share-cache")).toBe("miss");
      expect(third.text).toContain("changed directly");
      expect((await call("GET", url, { cookie: "acard_guest=o." + "A".repeat(43) })).headers.get("x-acard-share-cache")).toBeNull();
    } finally {
      delete (globalThis as any).caches;
      delete env.LIVE;
      owner.query("UPDATE blocks SET text = 'root body' WHERE page = 'root' AND id = 'r1'").run();
    }
  });

  // #57: a dropped Hyperdrive socket on a shared link page answered 500 / Cloudflare 1101 (10 of 40 concurrent on preview).
  test("a dropped database socket on a link page is a 503 retry, not a 500", async () => {
    const on = await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } });
    const url = on.data.link.url as string;
    const db = env.DB;
    const lost = () => { throw Object.assign(new Error("write CONNECTION_CLOSED 7fbe.hyperdrive.local:5432"), { code: "CONNECTION_CLOSED" }); };
    const stmt: any = { bind: () => stmt, first: lost, all: lost, run: lost, raw: lost };
    env.DB = { ...db, prepare: () => stmt, batch: lost };
    try {
      const page = await call("GET", url);
      expect(page.status).toBe(503);
      expect(page.headers.get("retry-after")).toBe("2");
    } finally {
      env.DB = db;
    }
    expect((await call("GET", url)).status).toBe(200);
    await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "invited" } });
  });

  test("an HTML block reaches link visitors only inside the sandbox, and only while the link allows it", async () => {
    const put = (slug: string, blocks: unknown[]) => asOwner("PUT", "/api/page/" + slug, { body: { blocks } });
    const before = { root: (await asOwner("GET", "/api/page/root")).data.blocks, other: (await asOwner("GET", "/api/page/other")).data.blocks };
    const html = { id: "h1", type: "html", text: "<h1>HTML 안 제목</h1><h2>둘째 제목</h2><b id=chart>chart-on-root</b><script>document.title='x'</script>", meta: { caption: "링크 차트" } };
    expect((await put("root", [...before.root, html])).status).toBe(200);
    expect((await put("other", [...before.other, { ...html, id: "h2", text: "<b>chart-on-other</b>" }])).status).toBe(200);
    const on = await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "link", role: "read" } });
    const url = on.data.link.url as string;
    const page = await call("GET", url);
    expect(page.status).toBe(200);
    const frame = /<iframe[^>]*class="acv-frame"[^>]*>/.exec(page.text)?.[0] ?? "";
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).not.toContain("allow-same-origin");
    expect(frame).not.toContain("srcdoc");
    expect(frame).toContain('src="' + url + '/frame/h1"');
    expect(page.text).not.toContain("chart-on-root");
    expect(page.text).not.toContain("chart-on-other");
    // The block's headings reach the sidebar TOC as links to the anchors beside the frame (acard-html-heading-toc).
    const sideToc = /<aside class="sv-toc sv-toc-wide"[\s\S]*?<\/aside>/.exec(page.text)?.[0] ?? "";
    expect(sideToc).toContain('href="#html-안-제목"');
    expect(sideToc).toContain('<li class="l3"><a href="#둘째-제목">');
    expect(page.text).toMatch(/<h2 id="html-안-제목" class="acv-head"[^>]*>HTML 안 제목<\/h2>[\s\S]*?<iframe[^>]*id="acv-fh1"/);
    const pageCsp = page.headers.get("content-security-policy") ?? "";
    expect(pageCsp).toContain("frame-src 'self'");
    expect(pageCsp).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*';/);
    expect(pageCsp).not.toContain("script-src 'unsafe-inline'");
    const inline = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline.length).toBe(1);
    const digest = new Bun.CryptoHasher("sha256").update(inline[0]).digest("base64");
    expect(pageCsp).toContain("script-src 'sha256-" + digest + "'");
    const doc = await call("GET", url + "/frame/h1");
    expect(doc.status).toBe(200);
    expect(doc.text).toContain("<b id=chart>chart-on-root</b><script>document.title='x'</script>");
    const frameCsp = doc.headers.get("content-security-policy") ?? "";
    expect(frameCsp).toContain("sandbox allow-scripts");
    expect(frameCsp).not.toContain("allow-same-origin");
    expect(frameCsp).toContain("default-src 'none'");
    expect(frameCsp).toContain("frame-ancestors 'self'");
    expect(doc.headers.get("x-frame-options")).not.toBe("DENY");
    expect(doc.headers.get("x-content-type-options")).toBe("nosniff");
    expect(doc.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(doc.headers.get("set-cookie")).toBeNull();
    expect((await call("GET", url + "/frame/h2")).status).toBe(404);
    expect((await call("GET", url + "/frame/r1")).status).toBe(404);
    expect((await call("GET", url + "/other/frame/h2")).status).toBe(404);
    expect((await call("GET", url + "/other/")).status).toBe(404);
    expect((await asOwner("PUT", "/api/page/root/access/general", { body: { mode: "invited" } })).status).toBe(200);
    const off = await call("GET", url);
    expect(off.status).toBe(401);
    expect(off.text).not.toContain("chart-on-root");
    expect((await call("GET", url + "/frame/h1")).status).toBe(401);
    expect((await put("root", before.root)).status).toBe(200);
    expect((await put("other", before.other)).status).toBe(200);
  });

  const np5Guests: Record<string, string> = {};
  async function np5Guest(role: "read" | "edit" | "full") {
    if (!np5Guests[role]) np5Guests[role] = await verify(await invite("root", "np5-" + role + "@example.com", role), "np5-" + role + "@example.com");
    return np5Guests[role];
  }

  test("guest database reads exclude private row pages and their appearance (#86)", async () => {
    const made = await asOwner("POST", "/api/db", { body: { title: "Row visibility", slug: "audit86-rows", parent: "root", page: true } });
    expect(made.status).toBe(200);
    const slug = made.data.slug;
    const title = (await asOwner("GET", "/api/db/" + slug)).data.properties.find((p: any) => p.type === "title").id;
    const publicRow = (await asOwner("POST", "/api/db/" + slug + "/rows", { body: { props: { [title]: "Visible row" } } })).data.row;
    const privateRow = (await asOwner("POST", "/api/db/" + slug + "/rows", { body: { props: { [title]: "audit86-private-title" } } })).data.row;
    expect((await asOwner("PUT", "/api/page/" + privateRow.page + "/settings", { body: { icon: "secret", cover: "g3" } })).status).toBe(200);
    expect((await asOwner("PUT", "/api/page/" + privateRow.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
    const guest = await np5Guest("read");
    expect((await call("GET", "/api/page/" + privateRow.page, { cookie: guest })).status).toBe(401);
    expect((await asOwner("GET", "/api/db/" + slug)).data.rows.map((r: any) => r.id)).toEqual([publicRow.id, privateRow.id]);
    const visible = await call("GET", "/api/db/" + slug, { cookie: guest });
    expect(visible.status).toBe(200);
    expect(visible.data.rows.map((r: any) => r.id)).toEqual([publicRow.id]);
    expect(visible.text).not.toContain("audit86-private-title");
    expect(visible.text).not.toContain('"pageIcon":"secret"');
    expect(visible.text).not.toContain('"cover":"g3"');
    const link = (await asOwner("PUT", "/api/page/" + slug + "/access/general", { body: { mode: "link", role: "read" } })).data.link.url;
    expect((await call("GET", link)).text).not.toContain("audit86-private-title");
    expect((await call("GET", link + "/" + privateRow.page + "/")).status).toBe(404);
    await asOwner("DELETE", "/api/db/" + slug);
  });

  test("guest database reads keep rows without their own page (imported tables, #86)", async () => {
    const made = await asOwner("POST", "/api/db", { body: { title: "Imported", slug: "audit86-imported", parent: "root", page: true } });
    expect(made.status).toBe(200);
    const id = (owner.query("SELECT id FROM databases WHERE slug = ?").get(made.data.slug) as { id: string }).id;
    owner.query("INSERT INTO db_rows (id, database_id, page, props, ord, created, updated) VALUES (?, ?, NULL, '{}', 5, 1, 1)").run("audit86-pageless", id);
    const guest = await np5Guest("read");
    const seen = await call("GET", "/api/db/" + made.data.slug, { cookie: guest });
    expect(seen.status).toBe(200);
    expect(seen.data.rows.map((r: any) => r.id)).toContain("audit86-pageless");
    await asOwner("DELETE", "/api/db/" + made.data.slug);
  });

  for (const role of ["none", "read"] as const) for (const action of ["props", "ord", "delete"] as const) {
    test("guest row " + action + " requires row edit permission, not database edit (" + role + ", #86)", async () => {
      const slug = (await asOwner("POST", "/api/db", { body: { title: "Row edits", slug: "audit86-" + role + "-" + action, parent: "root", page: true } })).data.slug;
      const title = (await asOwner("GET", "/api/db/" + slug)).data.properties.find((p: any) => p.type === "title").id;
      const rowTitle = "Unchanged " + role + " " + action;
      const row = (await asOwner("POST", "/api/db/" + slug + "/rows", { body: { props: { [title]: rowTitle } } })).data.row;
      const guest = await np5Guest("edit");
      expect((await asOwner("PUT", "/api/page/" + row.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
      if (role === "read") await invite(row.page, "np5-edit@example.com", "read");
      expect((await call("GET", "/api/page/" + row.page, { cookie: guest })).status).toBe(role === "read" ? 200 : 401);
      const path = "/api/db/" + slug + "/rows/" + row.id;
      const body = action === "props" ? { props: { [title]: "Changed" } } : { ord: 999 };
      expect((await call(action === "delete" ? "DELETE" : "PATCH", path, { cookie: guest, body })).status).toBe(401);
      const unchanged = (await asOwner("GET", "/api/db/" + slug)).data.rows[0];
      expect(unchanged).toMatchObject({ id: row.id, pageTitle: rowTitle, ord: row.ord });
      await invite(row.page, "np5-edit@example.com", "edit");
      expect((await call("PATCH", path, { cookie: guest, body: { props: { [title]: "Allowed" } } })).status).toBe(200);
      expect((await call("DELETE", path, { cookie: guest })).status).toBe(200);
      await asOwner("DELETE", "/api/db/" + slug);
    });
  }

  for (const action of ["add", "clear"] as const) {
    test("a guest two-way relation " + action + " cannot change a private target row (#86)", async () => {
      const source = (await asOwner("POST", "/api/db", { body: { title: "Source", slug: "audit86b-source-" + action, parent: "root", page: true } })).data.slug;
      const target = (await asOwner("POST", "/api/db", { body: { title: "Target", slug: "audit86b-target-" + action, parent: "root", page: true } })).data.slug;
      const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data;
      const sourceRow = (await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: {} } })).data.row;
      const privateRow = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: {} } })).data.row;
      const path = "/api/db/" + source + "/rows/" + sourceRow.id;
      if (action === "clear") expect((await asOwner("PATCH", path, { body: { props: { [rel.property.id]: [privateRow.id] } } })).status).toBe(200);
      expect((await asOwner("PUT", "/api/page/" + privateRow.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
      const guest = await np5Guest("edit");
      expect((await call("GET", "/api/page/" + privateRow.page, { cookie: guest })).status).toBe(401);
      expect((await call("PATCH", "/api/db/" + target + "/rows/" + privateRow.id, { cookie: guest, body: { props: {} } })).status).toBe(401);
      const values = async () => [
        (await asOwner("GET", "/api/db/" + source)).data.rows.find((r: any) => r.id === sourceRow.id).props[rel.property.id],
        (await asOwner("GET", "/api/db/" + target)).data.rows.find((r: any) => r.id === privateRow.id).props[rel.pair.id],
      ];
      const before = action === "add" ? [[], []] : [[privateRow.id], [sourceRow.id]];
      expect(await values()).toEqual(before);
      const next = action === "add" ? [privateRow.id] : [];
      expect((await call("PATCH", path, { cookie: guest, body: { props: { [rel.property.id]: next } } })).status).toBe(401);
      expect(await values()).toEqual(before);
      await invite(privateRow.page, "np5-edit@example.com", "edit");
      expect((await call("PATCH", path, { cookie: guest, body: { props: { [rel.property.id]: next } } })).status).toBe(200);
      expect(await values()).toEqual(action === "add" ? [[privateRow.id], [sourceRow.id]] : [[], []]);
      await asOwner("DELETE", "/api/db/" + source);
      await asOwner("DELETE", "/api/db/" + target);
    });
  }

  test("guest row delete, row buttons, templates, schema changes and sub-items cannot change a private row indirectly (#86)", async () => {
    const source = (await asOwner("POST", "/api/db", { body: { title: "Source", slug: "audit86b-paths-source", parent: "root", page: true } })).data.slug;
    const target = (await asOwner("POST", "/api/db", { body: { title: "Target", slug: "audit86b-paths-target", parent: "root", page: true } })).data.slug;
    const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data;
    const note = (await asOwner("POST", "/api/db/" + target + "/properties", { body: { name: "Note", type: "text" } })).data.property;
    const title = (await asOwner("GET", "/api/db/" + target)).data.properties.find((p: any) => p.type === "title").id;
    const open = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: { [title]: "open" } } })).data.row;
    const privateRow = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: { [title]: "private" } } })).data.row;
    const sourceRow = (await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: { [rel.property.id]: [open.id, privateRow.id] } } })).data.row;
    const button = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Touch", type: "button", config: { actions: [{ type: "update_related", relation: rel.property.id, values: { [title]: "touched" } }] } } })).data.property;
    expect((await asOwner("PUT", "/api/page/" + privateRow.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
    const guest = await np5Guest("edit");
    const targetRows = async () => Object.fromEntries((await asOwner("GET", "/api/db/" + target)).data.rows.map((r: any) => [r.id, { title: r.pageTitle, back: r.props[rel.pair.id], note: r.props[note.id] }]));
    const before = await targetRows();
    expect(before[privateRow.id].back).toEqual([sourceRow.id]);

    expect((await call("DELETE", "/api/db/" + source + "/rows/" + sourceRow.id, { cookie: guest })).status).toBe(401);
    expect((await call("POST", "/api/db/" + source + "/rows/" + sourceRow.id + "/button/" + button.id, { cookie: guest, body: {} })).status).toBe(401);
    expect((await call("POST", "/api/db/" + source + "/templates", { cookie: guest, body: { name: "Link private", props: { [rel.property.id]: [privateRow.id] } } })).status).toBe(401);
    expect((await call("PATCH", "/api/db/" + target + "/properties/" + note.id, { cookie: guest, body: { type: "number" } })).status).toBe(401);
    // #107: turning two-way off unlinks the private row too, so it needs edit on every linked row.
    expect((await call("PATCH", "/api/db/" + source + "/properties/" + rel.property.id, { cookie: guest, body: { config: { database: target, synced: false } } })).status).toBe(401);
    expect((await asOwner("GET", "/api/db/" + source)).data.properties.find((p: any) => p.id === rel.property.id).config.synced).toBe(true);
    expect(await targetRows()).toEqual(before);
    expect((await asOwner("GET", "/api/db/" + source)).data.templates).toEqual([]);

    const tree = (await asOwner("POST", "/api/db", { body: { title: "Tree", slug: "audit86b-paths-tree", parent: "root", page: true } })).data.slug;
    const sub = (await asOwner("PATCH", "/api/db/" + tree, { body: { subitems: true } })).data.config.subitems;
    const privateParent = (await asOwner("POST", "/api/db/" + tree + "/rows", { body: { props: {} } })).data.row;
    const openParent = (await asOwner("POST", "/api/db/" + tree + "/rows", { body: { props: {} } })).data.row;
    const child = (await asOwner("POST", "/api/db/" + tree + "/rows", { body: { props: { [sub.parent]: [privateParent.id] } } })).data.row;
    expect((await asOwner("PUT", "/api/page/" + privateParent.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
    const children = async () => (await asOwner("GET", "/api/db/" + tree)).data.rows.find((r: any) => r.id === privateParent.id).props[sub.children];
    expect(await children()).toEqual([child.id]);
    expect((await call("PATCH", "/api/db/" + tree + "/rows/" + openParent.id, { cookie: guest, body: { props: { [sub.children]: [child.id] } } })).status).toBe(401);
    expect((await call("PATCH", "/api/db/" + tree + "/rows/" + child.id, { cookie: guest, body: { props: { [sub.parent]: [openParent.id] } } })).status).toBe(401);
    expect(await children()).toEqual([child.id]);

    await invite(privateRow.page, "np5-edit@example.com", "edit");
    expect((await call("POST", "/api/db/" + source + "/templates", { cookie: guest, body: { name: "Link private", props: { [rel.property.id]: [privateRow.id] } } })).status).toBe(200);
    expect((await call("PATCH", "/api/db/" + target + "/properties/" + note.id, { cookie: guest, body: { type: "number" } })).status).toBe(200);
    for (const slug of [source, target, tree]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // #86 B1: a row without its own page (ZIP/markdown import) follows its own database's role, not the route's database.
  for (const action of ["row", "database"] as const) {
    test("guest " + action + " delete cannot change a page-less row in a read-only database through a two-way relation (#86)", async () => {
      const email = "np5-read@example.com";
      const guest = await np5Guest("read");
      const childRule = (await invite("child", email, "full")).rule;
      const source = (await asOwner("POST", "/api/db", { body: { title: "Source", slug: "audit86c-src-" + action, parent: "child", page: true } })).data.slug;
      const target = (await asOwner("POST", "/api/db", { body: { title: "Imported", slug: "audit86c-imp-" + action, parent: "root", page: true } })).data.slug;
      const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data;
      const imported = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: {} } })).data.row;
      owner.query("UPDATE db_rows SET page = NULL WHERE id = ?").run(imported.id);
      owner.query("DELETE FROM pages WHERE slug = ?").run(imported.page);
      const sourceRow = (await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: { [rel.property.id]: [imported.id] } } })).data.row;
      const snapshot = () => [owner.query("SELECT props, updated FROM db_rows WHERE id = ?").get(imported.id), owner.query("SELECT * FROM db_relation_links ORDER BY prop_id, src_row, dst_row").all()];
      const before = snapshot();
      expect(JSON.parse((before[0] as any).props)[rel.pair.id]).toEqual([sourceRow.id]);
      expect((await call("GET", "/api/db/" + target, { cookie: guest })).status).toBe(200);
      expect((await call("PATCH", "/api/db/" + target + "/rows/" + imported.id, { cookie: guest, body: { props: {} } })).status).toBe(401);
      const path = action === "row" ? "/api/db/" + source + "/rows/" + sourceRow.id : "/api/db/" + source;
      expect((await call("DELETE", path, { cookie: guest })).status).toBe(401);
      expect(snapshot()).toEqual(before);
      await invite(target, email, "edit");
      expect((await call("DELETE", path, { cookie: guest })).status).toBe(200);
      expect(JSON.parse((owner.query("SELECT props FROM db_rows WHERE id = ?").get(imported.id) as any).props)[rel.pair.id]).toEqual([]);
      await asOwner("DELETE", "/api/db/" + source);
      await asOwner("DELETE", "/api/db/" + target);
      expect((await asOwner("DELETE", "/api/page/child/access/rules/" + childRule)).status).toBe(200);
    });
  }

  // #86 B2: a row button checks every row every step will change before the first write, and writes all steps or none.
  test("a guest row button whose later step links a private row writes nothing (#86)", async () => {
    const source = (await asOwner("POST", "/api/db", { body: { title: "Source", slug: "audit86c-btn-source", parent: "root", page: true } })).data.slug;
    const target = (await asOwner("POST", "/api/db", { body: { title: "Target", slug: "audit86c-btn-target", parent: "root", page: true } })).data.slug;
    const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data;
    const note = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Note", type: "text" } })).data.property;
    const sourceRow = (await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: {} } })).data.row;
    const privateRow = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: {} } })).data.row;
    expect((await asOwner("PUT", "/api/page/" + privateRow.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
    const guest = await np5Guest("edit");
    const actions = [{ type: "update_row", values: { [note.id]: "step1-written" } }, { type: "update_row", values: { [rel.property.id]: [privateRow.id] } }];
    const button = await call("POST", "/api/db/" + source + "/properties", { cookie: guest, body: { name: "Two steps", type: "button", config: { actions } } });
    expect(button.status).toBe(200);
    const snapshot = () => [owner.query("SELECT id, props, updated FROM db_rows WHERE id IN (?, ?) ORDER BY id").all(sourceRow.id, privateRow.id), owner.query("SELECT * FROM db_relation_links ORDER BY prop_id, src_row, dst_row").all()];
    const before = snapshot();
    const pressed = await call("POST", "/api/db/" + source + "/rows/" + sourceRow.id + "/button/" + button.data.property.id, { cookie: guest, body: {} });
    expect(pressed.status).toBe(401);
    expect(pressed.data.updated).toBe(0);
    expect(snapshot()).toEqual(before);
    await invite(privateRow.page, "np5-edit@example.com", "edit");
    const allowed = await call("POST", "/api/db/" + source + "/rows/" + sourceRow.id + "/button/" + button.data.property.id, { cookie: guest, body: {} });
    expect(allowed.status).toBe(200);
    const after = (await asOwner("GET", "/api/db/" + source)).data.rows.find((r: any) => r.id === sourceRow.id).props;
    expect([after[note.id], after[rel.property.id]]).toEqual(["step1-written", [privateRow.id]]);
    await asOwner("DELETE", "/api/db/" + source);
    await asOwner("DELETE", "/api/db/" + target);
  });

  // #86 write-path sweep: every server path that can change a table row, property or relation value, tried by a guest
  // with full access to the shared root against a row it may not edit. Each path must refuse (401/403) and leave every
  // table byte-identical. tests/share.test.ts "every table write path ..." fails when a write path has no case here.
  let sweepGuest = "";
  // One more verified guest; the per-IP verify limit (20 / 15 min) belongs to the invite tests, so this one keeps it as it found it.
  async function sweepVerify() {
    const saved = owner.query("SELECT key, count, reset FROM share_rate").all();
    const cookie = await verify(await invite("root", "sweep-full@example.com", "full"), "sweep-full@example.com");
    owner.query("DELETE FROM share_rate").run();
    for (const row of saved as any[]) owner.query("INSERT INTO share_rate (key, count, reset) VALUES (?, ?, ?)").run(row.key, row.count, row.reset);
    return cookie;
  }
  const sweepTables = ["pages", "blocks", "databases", "db_rows", "db_properties", "db_relation_links", "db_relation_locks", "db_templates", "db_views", "db_counters", "editor_trash"];
  const tableSnapshot = () => Object.fromEntries(sweepTables.map((table) => [table, owner.query("SELECT * FROM " + table + " ORDER BY 1, 2").all()]));
  async function sweepFixture(tag: string) {
    if (!sweepGuest) sweepGuest = await sweepVerify();
    const source = (await asOwner("POST", "/api/db", { body: { title: "Src " + tag, slug: "wp-src-" + tag, parent: "root", page: true } })).data.slug;
    const target = (await asOwner("POST", "/api/db", { body: { title: "Tgt " + tag, slug: "wp-tgt-" + tag, parent: "root", page: true } })).data.slug;
    const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data;
    const note = (await asOwner("POST", "/api/db/" + target + "/properties", { body: { name: "Note", type: "text" } })).data.property;
    const srcNote = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Memo", type: "text" } })).data.property;
    const open = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: { [note.id]: "open" } } })).data.row;
    const priv = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: { [note.id]: "private" } } })).data.row;
    const src = (await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: { [rel.property.id]: [open.id, priv.id] } } })).data.row;
    const blank = (await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: {} } })).data.row;
    expect((await asOwner("PUT", "/api/page/" + priv.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
    expect((await call("GET", "/api/page/" + priv.page, { cookie: sweepGuest })).status).toBe(401);
    return { tag, source, target, rel: rel.property.id, pair: rel.pair.id, note: note.id, srcNote: srcNote.id, open, priv, src, blank, extra: {} as Record<string, any>, cleanup: [] as string[] };
  }
  type Fx = Awaited<ReturnType<typeof sweepFixture>>;
  const g = (method: string, path: string, body?: unknown) => call(method, path, { cookie: sweepGuest, body });
  const ownerButton = async (fx: Fx, actions: unknown[]) => (await asOwner("POST", "/api/db/" + fx.source + "/properties", { body: { name: "Btn", type: "button", config: { actions } } })).data.property.id;
  const SWEEP: Record<string, { setup?: (fx: Fx) => Promise<void>; run: (fx: Fx) => Promise<{ status: number }> }> = {
    "synced-create-private-page": { run: (fx) => g("POST", "/api/page/" + fx.priv.page + "/synced", { ids: ["private"], base_updated: 0 }) },
    "synced-edit-private-page": { run: (fx) => g("PATCH", "/api/page/" + fx.priv.page + "/synced/private", { blocks: [], base_updated: 0, source_updated: 0 }) },
    "synced-detach-private-page": { run: (fx) => g("POST", "/api/page/" + fx.priv.page + "/synced/private/detach", { base_updated: 0, source_updated: 0 }) },
    "block-move-private-target": {
      setup: async (fx) => { expect((await asOwner("PUT", "/api/page/" + fx.src.page, { body: { blocks: [{ id: "move-me", type: "paragraph", text: "keep me" }] } })).status).toBe(200); },
      run: async (fx) => {
        const source = await asOwner("GET", "/api/page/" + fx.src.page);
        const target = await asOwner("GET", "/api/page/" + fx.priv.page);
        return g("POST", "/api/page/" + fx.src.page + "/move-blocks", { target: fx.priv.page, ids: ["move-me"], source_updated: source.data.page.updated, target_updated: target.data.page.updated });
      },
    },
    "row-patch-props": { run: (fx) => g("PATCH", "/api/db/" + fx.target + "/rows/" + fx.priv.id, { props: { [fx.note]: "changed" } }) },
    "row-patch-ord": { run: (fx) => g("PATCH", "/api/db/" + fx.target + "/rows/" + fx.priv.id, { ord: 999 }) },
    "row-delete": { run: (fx) => g("DELETE", "/api/db/" + fx.target + "/rows/" + fx.priv.id) },
    "row-create-linking": { run: (fx) => g("POST", "/api/db/" + fx.source + "/rows", { props: { [fx.rel]: [fx.priv.id] } }) },
    "relation-add": { run: (fx) => g("PATCH", "/api/db/" + fx.source + "/rows/" + fx.blank.id, { props: { [fx.rel]: [fx.priv.id] } }) },
    "relation-clear": { run: (fx) => g("PATCH", "/api/db/" + fx.source + "/rows/" + fx.src.id, { props: { [fx.rel]: [fx.open.id] } }) },
    "linked-row-delete": { run: (fx) => g("DELETE", "/api/db/" + fx.source + "/rows/" + fx.src.id) },
    "linked-db-delete": { run: (fx) => g("DELETE", "/api/db/" + fx.source) },
    "button-update-related": {
      setup: async (fx) => { fx.extra.button = await ownerButton(fx, [{ type: "update_related", relation: fx.rel, values: { [fx.note]: "touched" } }]); },
      run: (fx) => g("POST", "/api/db/" + fx.source + "/rows/" + fx.src.id + "/button/" + fx.extra.button, {}),
    },
    "button-update-row-link": {
      setup: async (fx) => { fx.extra.button = await ownerButton(fx, [{ type: "update_row", values: { [fx.srcNote]: "step1" } }, { type: "update_row", values: { [fx.rel]: [fx.priv.id] } }]); },
      run: (fx) => g("POST", "/api/db/" + fx.source + "/rows/" + fx.blank.id + "/button/" + fx.extra.button, {}),
    },
    "button-create-row-link": {
      setup: async (fx) => { fx.extra.button = await ownerButton(fx, [{ type: "update_row", values: { [fx.srcNote]: "step1" } }, { type: "create_row", database: fx.source, values: { [fx.rel]: [fx.priv.id] } }]); },
      run: (fx) => g("POST", "/api/db/" + fx.source + "/rows/" + fx.blank.id + "/button/" + fx.extra.button, {}),
    },
    "block-button-create-row": {
      setup: async (fx) => {
        const slug = "wp-page-" + fx.tag;
        expect((await asOwner("POST", "/api/pages", { body: { title: slug, slug, parent: "root" } })).status).toBe(200);
        expect((await asOwner("PUT", "/api/page/" + slug, { body: { blocks: [{ id: "btn", type: "button", text: "add", meta: { actions: [{ type: "create_row", database: fx.source, values: { [fx.rel]: [fx.priv.id] } }] } }] } })).status).toBe(200);
        fx.extra.page = slug;
        fx.cleanup.push(slug);
      },
      run: (fx) => g("POST", "/api/page/" + fx.extra.page + "/button/btn", {}),
    },
    "template-post": { run: (fx) => g("POST", "/api/db/" + fx.source + "/templates", { name: "Link private", props: { [fx.rel]: [fx.priv.id] } }) },
    "template-schedule": {
      setup: async (fx) => { fx.extra.template = (await asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "Owner linked", props: { [fx.rel]: [fx.priv.id] } } })).data.template.id; },
      run: (fx) => g("PATCH", "/api/db/" + fx.source + "/templates/" + fx.extra.template, { recurrence: { freq: "day", interval: 1, tz: "UTC", hour: 0, minute: 0 } }),
    },
    "template-post-scalar": { run: (fx) => g("POST", "/api/db/" + fx.source + "/templates", { name: "Scalar link", props: { [fx.rel]: fx.priv.id } }) },
    "template-patch": {
      setup: async (fx) => { fx.extra.template = (await asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "Plain", props: {} } })).data.template.id; },
      run: (fx) => g("PATCH", "/api/db/" + fx.source + "/templates/" + fx.extra.template, { props: { [fx.rel]: [fx.priv.id] } }),
    },
    "property-type-change": { run: (fx) => g("PATCH", "/api/db/" + fx.target + "/properties/" + fx.note, { type: "number" }) },
    "property-unique-id": { run: (fx) => g("POST", "/api/db/" + fx.target + "/properties", { name: "No", type: "unique_id" }) },
    "property-delete": { run: (fx) => g("DELETE", "/api/db/" + fx.target + "/properties/" + fx.note) },
    "property-synced-create": { run: (fx) => g("POST", "/api/db/" + fx.source + "/properties", { name: "Again", type: "relation", config: { database: fx.target, synced: true } }) },
    "property-synced-enable": {
      setup: async (fx) => { fx.extra.oneWay = (await asOwner("POST", "/api/db/" + fx.source + "/properties", { body: { name: "One way", type: "relation", config: { database: fx.target } } })).data.property.id; },
      run: (fx) => g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.extra.oneWay, { config: { database: fx.target, synced: true } }),
    },
    "property-synced-disable": {
      setup: async (fx) => {
        fx.extra.hidden = (await asOwner("POST", "/api/db", { body: { title: "Hidden " + fx.tag, slug: "wp-hid-" + fx.tag, parent: "other", page: true } })).data.slug;
        fx.extra.toHidden = (await asOwner("POST", "/api/db/" + fx.source + "/properties", { body: { name: "To hidden", type: "relation", config: { database: fx.extra.hidden, synced: true } } })).data.property.id;
      },
      run: (fx) => g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.extra.toHidden, { config: { database: fx.extra.hidden, synced: false } }),
    },
    "property-synced-drop-pair": { run: (fx) => g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { database: fx.target, synced: false }, dropPair: true }) },
    "subitems-on": { run: (fx) => g("PATCH", "/api/db/" + fx.target, { subitems: true }) },
    "subitem-move": {
      setup: async (fx) => {
        const sub = (await asOwner("PATCH", "/api/db/" + fx.source, { body: { subitems: true } })).data.config.subitems;
        const parent = (await asOwner("POST", "/api/db/" + fx.source + "/rows", { body: { props: {} } })).data.row;
        const child = (await asOwner("POST", "/api/db/" + fx.source + "/rows", { body: { props: { [sub.parent]: [parent.id] } } })).data.row;
        expect((await asOwner("PUT", "/api/page/" + parent.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
        Object.assign(fx.extra, { sub, child });
      },
      run: (fx) => g("PATCH", "/api/db/" + fx.source + "/rows/" + fx.extra.child.id, { props: { [fx.extra.sub.parent]: [fx.blank.id] } }),
    },
    "row-page-title": { run: (fx) => g("POST", "/api/page/" + fx.priv.page + "/rename", { title: "renamed" }) },
    "row-page-save": { run: (fx) => g("PUT", "/api/page/" + fx.priv.page, { blocks: [], title: "renamed", base_updated: 0 }) },
    "row-page-history-restore": { run: (fx) => g("POST", "/api/page/" + fx.priv.page + "/history/x/restore", {}) },
    "row-page-permanent": { run: (fx) => g("DELETE", "/api/page/" + fx.priv.page + "/permanent") },
    "row-page-duplicate": { run: (fx) => g("POST", "/api/page/" + fx.priv.page + "/duplicate", {}) },
    "rules": { run: (fx) => g("POST", "/api/db/" + fx.target + "/rules", { config: { trigger: { type: "created" }, action: { type: "set", property: fx.note, value: "x" } } }) },
    "form-config": { run: (fx) => g("PUT", "/api/db/" + fx.target + "/form", { enabled: true }) },
    "import": { run: () => g("POST", "/api/import", {}) },
    "sync": { run: () => g("POST", "/api/sync", {}) },
    "home-starter": { run: () => g("POST", "/api/home/starter", {}) },
  };
  for (const [key, path] of Object.entries(SWEEP)) {
    test("guest write path " + key + " cannot change a row it may not edit and writes nothing (#86)", async () => {
      const fx = await sweepFixture(key);
      if (path.setup) await path.setup(fx);
      const before = tableSnapshot();
      const res = await path.run(fx);
      expect([401, 403]).toContain(res.status);
      expect(tableSnapshot()).toEqual(before);
      for (const slug of fx.cleanup) {
        await asOwner("DELETE", "/api/page/" + slug);
        expect((await asOwner("DELETE", "/api/page/" + slug + "/permanent")).status).toBe(200);
        // A permanent delete keeps a tombstone; this test page never existed for the rest of the file.
        owner.query("DELETE FROM editor_trash WHERE page = ?").run(slug);
      }
      for (const slug of [fx.source, fx.target, fx.extra.hidden].filter(Boolean)) await asOwner("DELETE", "/api/db/" + slug);
    });
  }

  // Gate review of 0039b9a: a guest-seeded database could claim another database's property as its two-way pair, and
  // turning that relation off with dropPair deleted the private property.
  test("a guest-seeded relation cannot claim another database's property as its pair (#86)", async () => {
    const fx = await sweepFixture("forged-pair");
    const made = await g("POST", "/api/pages", { title: "Forged", slug: "wp-forged", parent: "root", kind: "db", properties: [{ id: "title", name: "Title", type: "title" }, { id: "fake", name: "Fake", type: "relation", config: { database: fx.source, synced: true, pair: fx.note } }] });
    expect(made.status).toBe(200);
    const fake = (await asOwner("GET", "/api/db/" + made.data.slug)).data.properties.find((p: any) => p.name === "Fake");
    expect([fake.config.synced, fake.config.pair]).toEqual([false, ""]);
    owner.query("UPDATE db_properties SET config = ? WHERE id = ?").run(JSON.stringify({ ...fake.config, synced: true, pair: fx.note }), fake.id);
    const before = tableSnapshot();
    const res = await g("PATCH", "/api/db/" + made.data.slug + "/properties/" + fake.id, { config: { database: fx.source, synced: false }, dropPair: true });
    expect(res.status).toBe(200);
    const after = tableSnapshot();
    expect(owner.query("SELECT id FROM db_properties WHERE id = ?").get(fx.note)).toEqual({ id: fx.note });
    for (const table of ["db_rows", "db_relation_links", "databases", "pages", "blocks"]) expect({ table, rows: after[table] }).toEqual({ table, rows: before[table] });
    for (const slug of [made.data.slug, fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
    await asOwner("DELETE", "/api/page/" + made.data.slug);
    expect((await asOwner("DELETE", "/api/page/" + made.data.slug + "/permanent")).status).toBe(200);
    owner.query("DELETE FROM editor_trash WHERE page = ?").run(made.data.slug);
  });

  // Gate review 3 (B4): a guest turned on a recurrence for an owner template linking a private row, and the owner-run tick
  // then linked a new row to it. A recurrence-only PATCH must check the stored values; the scheduler then writes nothing.
  test("a guest cannot schedule an owner template that links a private row; the owner tick links nothing (#86)", async () => {
    const fx = await sweepFixture("schedule-tick");
    const template = (await asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "Owner linked", props: { [fx.rel]: [fx.priv.id] } } })).data.template.id;
    const back = () => (owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.priv.id) as any).props;
    const before = back();
    const res = await g("PATCH", "/api/db/" + fx.source + "/templates/" + template, { recurrence: { freq: "day", interval: 1, tz: "UTC", hour: 0, minute: 0 } });
    expect(res.status).toBe(401);
    expect((owner.query("SELECT recurrence FROM db_templates WHERE id = ?").get(template) as any).recurrence).toBeNull();
    env.RECURRING_TICK_SECRET = "tick-secret";
    try {
      const tick = await worker.fetch(new Request("https://notes.example.com/__recurring/tick", { method: "POST", headers: { "content-type": "application/json", "x-recurring-tick": "tick-secret" }, body: JSON.stringify({ ws: "owner", now: Date.now() + 3 * 24 * 60 * 60 * 1000 }) }), env, {});
      expect(tick.status).toBe(200);
      expect(((await tick.json()) as any).created).toEqual([]);
    } finally {
      delete env.RECURRING_TICK_SECRET;
    }
    expect(back()).toBe(before);
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/templates/" + template, { body: { recurrence: null } })).status).toBe(200);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // Gate review 3 (B3): turning off a two-way relation with dropPair deleted the pair property and with it the value
  // the private row held; it needs every row of the paired database. The guest can still do it once it may edit them.
  test("a guest dropPair cannot erase a private row's relation value, and works once the guest may edit every row (#86)", async () => {
    const fx = await sweepFixture("drop-pair-direct");
    const res = await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { database: fx.target, synced: false }, dropPair: true });
    expect(res.status).toBe(401);
    expect(owner.query("SELECT id FROM db_properties WHERE id = ?").get(fx.pair)).toEqual({ id: fx.pair });
    expect(JSON.parse((owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.priv.id) as any).props)[fx.pair]).toEqual([fx.src.id]);
    await invite(fx.priv.page, "sweep-full@example.com", "edit");
    const allowed = await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { database: fx.target, synced: false }, dropPair: true });
    expect(allowed.status).toBe(200);
    expect(owner.query("SELECT id FROM db_properties WHERE id = ?").get(fx.pair)).toBeNull();
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // #107 (gate-review-4 N3): a guest-seeded database stored button actions without the save-time check, so an owner press
  // wrote into a database the guest cannot see.
  test("a guest-seeded database keeps no button action aimed at a database the guest cannot edit (#107)", async () => {
    const fx = await sweepFixture("seed-button");
    const hidden = (await asOwner("POST", "/api/db", { body: { title: "Hidden seed", slug: "wp-hid-seed", parent: "other", page: true } })).data.slug;
    const made = await g("POST", "/api/pages", { title: "Seeded", slug: "wp-seeded", parent: "root", kind: "db", properties: [{ id: "title", name: "Title", type: "title" }, { id: "go", name: "Go", type: "button", config: { actions: [{ type: "create_row", database: hidden, values: {} }] } }] });
    expect(made.status).toBe(200);
    const seeded = (await asOwner("GET", "/api/db/" + made.data.slug)).data;
    const button = seeded.properties.find((p: any) => p.name === "Go");
    expect(button.config.actions).toEqual([]);
    const row = (await asOwner("POST", "/api/db/" + made.data.slug + "/rows", { body: { props: {} } })).data.row;
    expect((await asOwner("POST", "/api/db/" + made.data.slug + "/rows/" + row.id + "/button/" + button.id, { body: {} })).status).toBe(400);
    expect((await asOwner("GET", "/api/db/" + hidden)).data.rows).toEqual([]);
    for (const slug of [made.data.slug, hidden, fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
    await asOwner("DELETE", "/api/page/" + made.data.slug);
    expect((await asOwner("DELETE", "/api/page/" + made.data.slug + "/permanent")).status).toBe(200);
    owner.query("DELETE FROM editor_trash WHERE page = ?").run(made.data.slug);
  });

  // #107 (gate-review-4 N3): a button a guest wrote ran with the owner's permission when the owner pressed it, so a guest
  // could arm a link to a row it may not edit. A press now runs with the narrower of the presser's and the author's permission.
  test("an owner pressing a guest-authored button gets no more than the guest could do; the owner's own button still works (#107)", async () => {
    const fx = await sweepFixture("guest-button");
    const linked = () => privLinks(fx).length;
    const before = linked();
    const guestButton = await g("POST", "/api/db/" + fx.source + "/properties", { name: "Guest link", type: "button", config: { actions: [{ type: "update_row", values: { [fx.rel]: [fx.priv.id] } }] } });
    expect(guestButton.status).toBe(200);
    const pressed = await asOwner("POST", "/api/db/" + fx.source + "/rows/" + fx.blank.id + "/button/" + guestButton.data.property.id, { body: {} });
    expect(pressed.status).toBe(401);
    expect(linked()).toBe(before);
    // A block button the guest wrote on a page: create_row linking the private row.
    const page = "wp-guest-block";
    expect((await asOwner("POST", "/api/pages", { body: { title: page, slug: page, parent: "root" } })).status).toBe(200);
    expect((await g("PUT", "/api/page/" + page, { blocks: [{ id: "gb", type: "button", text: "add", meta: { actions: [{ type: "create_row", database: fx.source, values: { [fx.rel]: [fx.priv.id] } }] } }] })).status).toBe(200);
    expect((await asOwner("POST", "/api/page/" + page + "/button/gb", { body: {} })).status).toBe(401);
    expect(linked()).toBe(before);
    // The guest may run its own button on rows it may edit, and so may the owner pressing it.
    const openButton = (await g("POST", "/api/db/" + fx.source + "/properties", { name: "Guest open", type: "button", config: { actions: [{ type: "update_row", values: { [fx.rel]: [fx.open.id] } }] } })).data.property.id;
    expect((await asOwner("POST", "/api/db/" + fx.source + "/rows/" + fx.blank.id + "/button/" + openButton, { body: {} })).status).toBe(200);
    // Owner-authored control: the same link from the owner's own button goes through.
    const ownerButton = (await asOwner("POST", "/api/db/" + fx.source + "/properties", { body: { name: "Owner link", type: "button", config: { actions: [{ type: "update_row", values: { [fx.rel]: [fx.priv.id] } }] } } })).data.property.id;
    expect((await asOwner("POST", "/api/db/" + fx.source + "/rows/" + fx.blank.id + "/button/" + ownerButton, { body: {} })).status).toBe(200);
    expect(linked()).toBe(before + 2); // one edge each way
    await asOwner("DELETE", "/api/page/" + page);
    expect((await asOwner("DELETE", "/api/page/" + page + "/permanent")).status).toBe(200);
    owner.query("DELETE FROM editor_trash WHERE page = ?").run(page);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // #107: when the guest who wrote a button can no longer be checked (session ended), an owner press writes nothing.
  test("an owner press of a button whose guest author's session ended writes nothing (#107)", async () => {
    const fx = await sweepFixture("gone-author");
    const guest = await freshGuest("button-author@example.com");
    const button = (await call("POST", "/api/db/" + fx.source + "/properties", { cookie: guest.cookie, body: { name: "Memo it", type: "button", config: { actions: [{ type: "update_row", values: { [fx.srcNote]: "pressed" } }] } } })).data.property.id;
    expect((await asOwner("POST", "/api/db/" + fx.source + "/rows/" + fx.blank.id + "/button/" + button, { body: {} })).status).toBe(200);
    expect((await asOwner("DELETE", "/api/page/root/access/rules/" + guest.rule)).status).toBe(200);
    owner.query("UPDATE share_sessions SET revoked = 1 WHERE token_hash = ?").run(guest.hash);
    const memo = () => JSON.parse((owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.src.id) as any).props)[fx.srcNote];
    const was = memo();
    const res = await asOwner("POST", "/api/db/" + fx.source + "/rows/" + fx.src.id + "/button/" + button, { body: {} });
    expect(res.status).toBe(403);
    expect(memo()).toBe(was);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // #107 (gate-review-4 N2): turning a two-way relation off without dropPair, or deleting one side, removes the links of
  // rows in the other database; it was judged by that database's role only.
  test("a guest cannot unlink a private row by turning two-way off or deleting the paired property; it can once it may edit that row (#107)", async () => {
    const fx = await sweepFixture("turn-off");
    const before = privLinks(fx);
    expect(before.length).toBeGreaterThan(0);
    expect((await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { database: fx.target, synced: false } })).status).toBe(401);
    expect((await g("DELETE", "/api/db/" + fx.source + "/properties/" + fx.rel)).status).toBe(401);
    expect((await g("DELETE", "/api/db/" + fx.target + "/properties/" + fx.pair)).status).toBe(401);
    expect(privLinks(fx)).toEqual(before);
    await invite(fx.priv.page, "sweep-full@example.com", "edit");
    expect((await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { database: fx.target, synced: false } })).status).toBe(200);
    expect(privLinks(fx)).toEqual([]);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // #106: an agent's per-page rule on a row page (or on a row a two-way relation would change) now applies to row writes
  // through the agent API and MCP, like the share-guest path.
  test("agent row writes follow per-row-page agent rules, including rows a two-way relation changes (#106)", async () => {
    const fx = await sweepFixture("agent-rows");
    const made = await asOwner("POST", "/api/agents/tokens", { body: { name: "row-writer", scopes: ["read", "write"] } });
    const bearer = made.data.token;
    const level = (slug: string, value: string) => asOwner("PUT", "/api/page/" + slug + "/access/agents", { body: { token: made.data.record.id, level: value } });
    expect((await level(fx.priv.page, "read")).status).toBe(200);
    const rowProps = (id: string) => JSON.parse((owner.query("SELECT props FROM db_rows WHERE id = ?").get(id) as any).props);
    const v1 = (method: string, path: string, body: unknown) => call(method, "/api/v1/databases/" + path, { bearer, body });
    // The read-only row itself.
    const direct = await v1("PATCH", fx.target + "/rows/" + fx.priv.id, { props: { [fx.note]: "agent" } });
    expect(direct.status).toBe(403);
    expect(rowProps(fx.priv.id)[fx.note]).toBe("private");
    const mcp = await worker.fetch(new Request("https://notes.example.com/mcp", { method: "POST", headers: { authorization: "Bearer " + bearer, accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_database_row", arguments: { database: fx.target, row: fx.priv.id, props: { [fx.note]: "mcp" } } } }) }), env, {});
    const mcpText = await mcp.text();
    expect(mcpText).toContain('"isError":true');
    expect(mcpText).toContain("권한");
    expect(rowProps(fx.priv.id)[fx.note]).toBe("private");
    // A writable row whose two-way link would change the read-only row, by update and by a new row.
    const links = privLinks(fx);
    expect((await v1("PATCH", fx.source + "/rows/" + fx.blank.id, { props: { [fx.rel]: [fx.priv.id] } })).status).toBe(403);
    expect((await v1("PATCH", fx.source + "/rows/" + fx.src.id, { props: { [fx.rel]: [fx.open.id] } })).status).toBe(403);
    expect((await v1("POST", fx.source + "/rows", { props: { [fx.rel]: [fx.priv.id] } })).status).toBe(403);
    expect(privLinks(fx)).toEqual(links);
    // Rows the token may write still work.
    expect((await v1("PATCH", fx.target + "/rows/" + fx.open.id, { props: { [fx.note]: "agent" } })).status).toBe(200);
    expect(rowProps(fx.open.id)[fx.note]).toBe("agent");
    expect((await v1("PATCH", fx.source + "/rows/" + fx.blank.id, { props: { [fx.rel]: [fx.open.id] } })).status).toBe(200);
    expect((await v1("POST", fx.source + "/rows", { props: { [fx.srcNote]: "new" } })).status).toBe(201);
    await asOwner("DELETE", "/api/agents/tokens/" + made.data.record.id);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // Gate re-review of b5283a1: a relation value stored as one string (not an array) skipped the template check, and the
  // owner tick normalised it into a link to the private row.
  test("a guest template with a single-string relation value is checked like an array and the tick links nothing (#86)", async () => {
    const fx = await sweepFixture("scalar-tick");
    const back = () => (owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.priv.id) as any).props;
    const before = back();
    expect((await g("POST", "/api/db/" + fx.source + "/templates", { name: "Scalar", props: { [fx.rel]: fx.priv.id } })).status).toBe(401);
    const plain = (await g("POST", "/api/db/" + fx.source + "/templates", { name: "Plain", props: {} })).data.template.id;
    expect((await g("PATCH", "/api/db/" + fx.source + "/templates/" + plain, { props: { [fx.rel]: fx.priv.id }, recurrence: { freq: "day", interval: 1, tz: "UTC", hour: 0, minute: 0 } })).status).toBe(401);
    env.RECURRING_TICK_SECRET = "tick-secret";
    try {
      const tick = await worker.fetch(new Request("https://notes.example.com/__recurring/tick", { method: "POST", headers: { "content-type": "application/json", "x-recurring-tick": "tick-secret" }, body: JSON.stringify({ ws: "owner", now: Date.now() + 3 * 24 * 60 * 60 * 1000 }) }), env, {});
      expect(((await tick.json()) as any).created).toEqual([]);
    } finally {
      delete env.RECURRING_TICK_SECRET;
    }
    expect(back()).toBe(before);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  const ownerTick = async () => {
    env.RECURRING_TICK_SECRET = "tick-secret";
    try {
      const tick = await worker.fetch(new Request("https://notes.example.com/__recurring/tick", { method: "POST", headers: { "content-type": "application/json", "x-recurring-tick": "tick-secret" }, body: JSON.stringify({ ws: "owner", now: Date.now() + 3 * 24 * 60 * 60 * 1000 }) }), env, {});
      return { status: tick.status, created: ((await tick.json()) as any).created };
    } finally {
      delete env.RECURRING_TICK_SECRET;
    }
  };
  const daily = { freq: "day", interval: 1, tz: "UTC", hour: 0, minute: 0 };

  // Gate review 5 (B7): under a one-link limit the template check looked only at the last id while the template kept every
  // id, so once the limit was lifted the owner tick linked all of them, the private row included.
  test("a template saved under a one-link limit is checked for every id it keeps; lifting the limit later links no private row (#86)", async () => {
    const fx = await sweepFixture("limit-tick");
    const back = () => (owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.priv.id) as any).props;
    const before = back();
    const relation = (await asOwner("GET", "/api/db/" + fx.source)).data.properties.find((prop: any) => prop.id === fx.rel);
    expect((await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { ...relation.config, limit: 1 } })).status).toBe(200);
    const posted = await g("POST", "/api/db/" + fx.source + "/templates", { name: "Limit", props: { [fx.rel]: [fx.priv.id, fx.open.id] } });
    const template = posted.data?.template?.id;
    if (template) await g("PATCH", "/api/db/" + fx.source + "/templates/" + template, { recurrence: daily });
    expect((await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { config: { ...relation.config, limit: null } })).status).toBe(200);
    const tick = await ownerTick();
    // The template keeps what a row made under the limit gets (the last id) and is checked for exactly that value.
    const stored = template ? JSON.parse((owner.query("SELECT props FROM db_templates WHERE id = ?").get(template) as any).props)[fx.rel] : null;
    expect({ post: posted.status, stored, tick: tick.status, privateRowAfterTick: back() }).toEqual({ post: 200, stored: [fx.open.id], tick: 200, privateRowAfterTick: before });
    // Every id it keeps is checked: the private row as the kept (last) id is refused.
    expect((await g("POST", "/api/db/" + fx.source + "/templates", { name: "Limit last", props: { [fx.rel]: [fx.open.id, fx.priv.id] } })).status).toBe(401);
    if (template) await asOwner("DELETE", "/api/db/" + fx.source + "/templates/" + template);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // Gate review 5 (B8): a template key that matched no property name was not checked when saved, and the tick matched it
  // against the names at run time, so renaming the relation to that key made the owner tick link the private row.
  test("a template key naming no property is not kept, so renaming a relation to it later links no private row (#86)", async () => {
    const fx = await sweepFixture("rename-tick");
    const back = () => (owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.priv.id) as any).props;
    const before = back();
    const posted = await g("POST", "/api/db/" + fx.source + "/templates", { name: "Alias", props: { Alias: fx.priv.id } });
    const template = posted.data?.template?.id;
    if (template) await g("PATCH", "/api/db/" + fx.source + "/templates/" + template, { recurrence: daily });
    expect((await g("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { name: "Alias" })).status).toBe(200);
    const tick = await ownerTick();
    const stored = template ? JSON.parse((owner.query("SELECT props FROM db_templates WHERE id = ?").get(template) as any).props) : null;
    expect({ post: posted.status, stored, tick: tick.status, privateRowAfterTick: back() }).toEqual({ post: 400, stored: null, tick: 200, privateRowAfterTick: before });
    if (template) await asOwner("DELETE", "/api/db/" + fx.source + "/templates/" + template);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // Gate review 5 (N2): a template refuses relation values that can never link (like row POST), stores name keys under the
  // property id and keeps the relation value as the list the tick writes.
  test("a template stores relation values as id-keyed lists and refuses values that cannot link (#86)", async () => {
    const fx = await sweepFixture("tpl-shapes");
    const post = (props: unknown) => asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "Shape", props } });
    const refused: Record<string, number> = {};
    for (const [label, value] of Object.entries({ comma: fx.open.id + "," + fx.priv.id, newline: fx.open.id + "\n" + fx.priv.id, object: { id: fx.open.id }, objectList: [{ id: fx.open.id }], number: 12345, boolean: true, missing: "no-such-row" })) {
      refused[label] = (await post({ [fx.rel]: value })).status;
    }
    expect(refused).toEqual({ comma: 400, newline: 400, object: 400, objectList: 400, number: 400, boolean: 400, missing: 400 });
    const byName = await post({ Related: fx.open.id });
    expect(byName.status).toBe(200);
    expect(JSON.parse((owner.query("SELECT props FROM db_templates WHERE id = ?").get(byName.data.template.id) as any).props)).toEqual({ [fx.rel]: [fx.open.id] });
    const plain = (await post({})).data.template.id;
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/templates/" + plain, { body: { props: { [fx.rel]: true } } })).status).toBe(400);
    for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug);
  });

  // ---- #86 gate review 6: a relation link is made only with the permission of whoever saved the value ----
  const tickAt = async (days: number) => {
    env.RECURRING_TICK_SECRET = "tick-secret";
    try {
      const tick = await worker.fetch(new Request("https://notes.example.com/__recurring/tick", { method: "POST", headers: { "content-type": "application/json", "x-recurring-tick": "tick-secret" }, body: JSON.stringify({ ws: "owner", now: Date.now() + days * 24 * 60 * 60 * 1000 }) }), env, {});
      return { status: tick.status, body: (await tick.json()) as any };
    } finally {
      delete env.RECURRING_TICK_SECRET;
    }
  };
  // Every edge touching the private row (both directions); a tick that links it adds two.
  const privLinks = (fx: Fx) => owner.query("SELECT prop_id, src_row, dst_row FROM db_relation_links WHERE src_row = ? OR dst_row = ? ORDER BY 1, 2, 3").all(fx.priv.id, fx.priv.id);
  const storedProps = (template: string) => JSON.parse((owner.query("SELECT props FROM db_templates WHERE id = ?").get(template) as any).props);
  const dropDbs = async (fx: Fx) => { for (const slug of [fx.source, fx.target]) await asOwner("DELETE", "/api/db/" + slug); };
  const sourceRows = (fx: Fx) => (owner.query("SELECT COUNT(*) AS n FROM db_rows r JOIN databases d ON d.id = r.database_id WHERE d.slug = ?").get(fx.source) as any).n as number;
  const templateView = async (fx: Fx, template: string) => (await asOwner("GET", "/api/db/" + fx.source)).data.templates.find((t: any) => t.id === template);
  // A guest of its own (edit on root), so revoking it touches no other test. Keeps the per-IP verify limit as it found it.
  async function freshGuest(email: string, role = "edit") {
    const saved = owner.query("SELECT key, count, reset FROM share_rate").all();
    const found = await invite("root", email, role);
    const cookie = await verify(found, email);
    owner.query("DELETE FROM share_rate").run();
    for (const row of saved as any[]) owner.query("INSERT INTO share_rate (key, count, reset) VALUES (?, ?, ?)").run(row.key, row.count, row.reset);
    return { cookie, rule: found.rule, hash: new Bun.CryptoHasher("sha256").update(cookie.split(".")[1]).digest("hex") };
  }
  const sourceId = (fx: Fx) => (owner.query("SELECT id FROM databases WHERE slug = ?").get(fx.source) as any).id as string;
  // A template row exactly as a build before this fix stored it: no saver record. recurrence copied from a real schedule.
  async function legacyTemplate(fx: Fx, name: string, props: Record<string, unknown>) {
    const made = (await asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "schedule source", props: {} } })).data.template.id;
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/templates/" + made, { body: { recurrence: daily } })).status).toBe(200);
    const recurrence = (owner.query("SELECT recurrence FROM db_templates WHERE id = ?").get(made) as any).recurrence;
    expect((await asOwner("DELETE", "/api/db/" + fx.source + "/templates/" + made)).status).toBe(200);
    const id = sourceId(fx) + "_tlegacy" + name;
    owner.query("INSERT INTO db_templates (id, database_id, name, icon, props, blocks, ord, recurrence) VALUES (?, ?, ?, '', ?, '[]', 0, ?)").run(id, sourceId(fx), name, JSON.stringify(props), recurrence);
    return id;
  }
  // Names of the tests below; the write-path inventory test fails when one of the required ones is gone.
  const SAVER_TESTS = new Set<string>();
  const saverTest = (name: string, title: string, fn: () => Promise<void>) => { SAVER_TESTS.add(name); test(title + " (#86 " + name + ")", fn); };

  // B9: a value saved while the property was text was never checked as a relation; the owner then turned the property into
  // a two-way relation and the owner-run tick linked the private row.
  test("a template value saved on a text property never links when the owner turns it into a two-way relation (#86 b9-text-to-relation)", async () => {
    const fx = await sweepFixture("b9-text");
    const templates: string[] = [];
    for (const value of [fx.priv.id, [fx.priv.id]]) {
      const posted = await g("POST", "/api/db/" + fx.source + "/templates", { name: "Memo", props: { [fx.srcNote]: value } });
      expect(posted.status).toBe(200);
      templates.push(posted.data.template.id);
      expect((await g("PATCH", "/api/db/" + fx.source + "/templates/" + posted.data.template.id, { recurrence: daily })).status).toBe(200);
    }
    const before = privLinks(fx);
    const turned = await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + fx.srcNote, { body: { type: "relation", config: { database: fx.target, synced: true } } });
    expect(turned.status).toBe(200);
    const tick = await tickAt(3);
    expect({ tick: tick.status, privLinks: privLinks(fx) }).toEqual({ tick: 200, privLinks: before });
    // The values were kept aside, not turned into links.
    expect(templates.map((id) => storedProps(id)[fx.srcNote])).toEqual([undefined, undefined]);
    const kept = owner.query("SELECT ref, value FROM db_value_backups WHERE prop_id = ? AND kind = 'template' ORDER BY ref").all(fx.srcNote) as any[];
    expect(kept.map((row) => [row.ref, JSON.parse(row.value)]).sort()).toEqual([[templates[0], fx.priv.id], [templates[1], [fx.priv.id]]].sort());
    expect(turned.data.unlinked).toBeGreaterThanOrEqual(2);
    await dropDbs(fx);
  });

  test("a guest who turns a relation into text and saves a template value links nothing once the owner turns it back (#86 b9-relation-text-relation)", async () => {
    const fx = await sweepFixture("b9-back");
    // #107: the guest itself may not turn this relation off (it unlinks the private row), so the owner turns it into text.
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { body: { type: "text" } })).status).toBe(200);
    const posted = await g("POST", "/api/db/" + fx.source + "/templates", { name: "Back", props: { [fx.rel]: fx.priv.id } });
    expect(posted.status).toBe(200);
    expect((await g("PATCH", "/api/db/" + fx.source + "/templates/" + posted.data.template.id, { recurrence: daily })).status).toBe(200);
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { body: { type: "relation", config: { database: fx.target, synced: true } } })).status).toBe(200);
    const before = privLinks(fx);
    const tick = await tickAt(3);
    expect({ tick: tick.status, privLinks: privLinks(fx) }).toEqual({ tick: 200, privLinks: before });
    expect(storedProps(posted.data.template.id)[fx.rel]).toBeUndefined();
    await dropDbs(fx);
  });

  // N6: the same gap for row cells. A guest-written text cell became a link when the owner turned the property into a
  // relation (text -> one-way -> two-way). Old values are kept aside and the response says how many were not linked.
  test("a text cell never becomes a link when the property turns into a relation; the value is kept aside and counted (#86 n6-row-text-to-relation)", async () => {
    const fx = await sweepFixture("n6-row");
    expect((await g("PATCH", "/api/db/" + fx.source + "/rows/" + fx.blank.id, { props: { [fx.srcNote]: fx.priv.id } })).status).toBe(200);
    const before = privLinks(fx);
    const oneWay = await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + fx.srcNote, { body: { type: "relation", config: { database: fx.target } } });
    const twoWay = await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + fx.srcNote, { body: { config: { database: fx.target, synced: true } } });
    expect({ oneWay: oneWay.status, twoWay: twoWay.status, privLinks: privLinks(fx), unlinked: oneWay.data.unlinked }).toEqual({ oneWay: 200, twoWay: 200, privLinks: before, unlinked: 1 });
    expect(JSON.parse((owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.blank.id) as any).props)[fx.srcNote]).toEqual([]);
    const kept = owner.query("SELECT kind, ref, value FROM db_value_backups WHERE prop_id = ? AND ref = ?").all(fx.srcNote, fx.blank.id) as any[];
    expect(kept.map((row) => [row.kind, JSON.parse(row.value)])).toEqual([["row", fx.priv.id]]);
    await dropDbs(fx);
  });

  // B11 (gate review 7): deleting a property left its row and template values under the old id, and a property POST could
  // reuse that id, so a guest made it a relation with the same id; once the owner turned on two-way the tick linked the
  // private row. Deleting now moves the values to db_value_backups, and a POST id that still has values gets a fresh id.
  test("a deleted property's values never come back as links through a new property with the same id (#86 b11-delete-recreate)", async () => {
    const fx = await sweepFixture("b11-del");
    const posted = await g("POST", "/api/db/" + fx.source + "/templates", { name: "Memo", props: { [fx.srcNote]: fx.priv.id } });
    expect(posted.status).toBe(200);
    expect((await g("PATCH", "/api/db/" + fx.source + "/templates/" + posted.data.template.id, { recurrence: daily })).status).toBe(200);
    expect((await g("PATCH", "/api/db/" + fx.source + "/rows/" + fx.blank.id, { props: { [fx.srcNote]: fx.priv.id } })).status).toBe(200);
    const before = privLinks(fx);
    expect((await g("DELETE", "/api/db/" + fx.source + "/properties/" + fx.srcNote)).status).toBe(200);
    const again = await g("POST", "/api/db/" + fx.source + "/properties", { id: fx.srcNote, name: "Memo", type: "relation", config: { database: fx.target } });
    expect(again.status).toBe(200);
    const id = again.data.property.id;
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + id, { body: { config: { database: fx.target, synced: true } } })).status).toBe(200);
    const tick = await tickAt(3);
    expect({ tick: tick.status, privLinks: privLinks(fx) }).toEqual({ tick: 200, privLinks: before });
    expect([storedProps(posted.data.template.id)[fx.srcNote], JSON.parse((owner.query("SELECT props FROM db_rows WHERE id = ?").get(fx.blank.id) as any).props)[fx.srcNote]]).toEqual([undefined, undefined]);
    const kept = owner.query("SELECT kind, value, reason FROM db_value_backups WHERE prop_id = ? ORDER BY kind").all(fx.srcNote) as any[];
    expect(kept.map((row) => [row.kind, JSON.parse(row.value), row.reason])).toEqual([["row", fx.priv.id, "delete"], ["template", fx.priv.id, "delete"]]);
    await dropDbs(fx);
  });

  test("a property POST never reuses an id that rows or templates still hold values for (#86 b11-leftover-id)", async () => {
    const fx = await sweepFixture("b11-id");
    // Values a build before this fix left behind when the property was deleted.
    const stale = sourceId(fx) + "_pstale";
    const template = (await asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "Stale", props: {} } })).data.template.id;
    owner.query("UPDATE db_templates SET props = ? WHERE id = ?").run(JSON.stringify({ [stale]: fx.priv.id }), template);
    const made = await g("POST", "/api/db/" + fx.source + "/properties", { id: stale, name: "Again", type: "relation", config: { database: fx.target } });
    expect(made.status).toBe(200);
    expect(made.data.property.id).not.toBe(stale);
    const fresh = await g("POST", "/api/db/" + fx.source + "/properties", { id: sourceId(fx) + "_punused", name: "Unused", type: "text" });
    expect(fresh.data.property.id).toBe(sourceId(fx) + "_punused");
    await dropDbs(fx);
  });

  // B10: templates stored by earlier builds (id key + one string, id key + extra ids) have no saver record. They may have
  // been saved by a guest, so in a database a guest could ever edit they do not run until someone saves them again.
  saverTest("legacy-guest-db", "a legacy template with no saver record links no private row and is shown as stopped", async () => {
    const fx = await sweepFixture("b10-legacy");
    const scalar = await legacyTemplate(fx, "b6", { [fx.rel]: fx.priv.id });
    const extra = await legacyTemplate(fx, "b7", { [fx.rel]: [fx.priv.id, fx.open.id] });
    const before = privLinks(fx);
    const rows = sourceRows(fx);
    const tick = await tickAt(3);
    expect({ tick: tick.status, privLinks: privLinks(fx), rows: sourceRows(fx) }).toEqual({ tick: 200, privLinks: before, rows });
    expect([(await templateView(fx, scalar)).blocked, (await templateView(fx, extra)).blocked].every((b) => typeof b === "string" && b.length > 0)).toBe(true);
    expect((await tickAt(5)).status).toBe(200);
    expect({ privLinks: privLinks(fx), rows: sourceRows(fx) }).toEqual({ privLinks: before, rows });
    // The owner saving it again makes it the owner's template; then it runs as the owner.
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/templates/" + scalar, { body: { props: { [fx.rel]: [fx.open.id] } } })).status).toBe(200);
    expect((await templateView(fx, scalar)).blocked).toBeNull();
    await tickAt(7);
    expect(sourceRows(fx)).toBe(rows + 1);
    expect(privLinks(fx)).toEqual(before);
    await dropDbs(fx);
  });

  test("a legacy template in a database no guest could ever edit still runs as the owner (#86)", async () => {
    expect((await asOwner("POST", "/api/pages", { body: { title: "Solo", slug: "wp-solo", parent: null } })).status).toBe(200);
    const source = (await asOwner("POST", "/api/db", { body: { title: "Solo src", slug: "wp-solo-src", parent: "wp-solo", page: true } })).data.slug;
    const target = (await asOwner("POST", "/api/db", { body: { title: "Solo tgt", slug: "wp-solo-tgt", parent: "wp-solo", page: true } })).data.slug;
    const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data.property.id;
    const row = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: {} } })).data.row;
    expect((await asOwner("PUT", "/api/page/" + row.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
    const fx = { source, target, priv: row } as unknown as Fx;
    const id = await legacyTemplate(fx, "solo", { [rel]: [row.id] });
    await tickAt(3);
    expect(sourceRows(fx)).toBe(1);
    expect(privLinks(fx).length).toBe(2);
    expect((await templateView(fx, id)).blocked).toBeNull();
    await dropDbs(fx);
    await asOwner("DELETE", "/api/page/wp-solo");
    expect((await asOwner("DELETE", "/api/page/wp-solo/permanent")).status).toBe(200);
    // These pages never existed for the rest of the file: no tombstones, and the private row page's slug ("새-행") must not
    // keep its inherit-off setting for the next row that takes the same slug.
    owner.query("DELETE FROM editor_trash WHERE page IN ('wp-solo', 'wp-solo-src', 'wp-solo-tgt')").run();
    owner.query("DELETE FROM share_pages WHERE page = ?").run(row.page);
  });

  // Lead order on gate review 6: the saver must still resolve, with the narrower of its permission when it saved and now.
  // Anything that cannot be resolved stops that template: nothing is written, the refusal is recorded and shown, and the
  // next tick refuses again (no other permission is borrowed). Making a row from it is refused the same way.
  const SAVER_BREAKS: Record<string, (fx: Fx, guest: { rule: string; hash: string }, template: string) => Promise<void>> = {
    "session-revoked": async (_fx, guest) => { owner.query("UPDATE share_sessions SET revoked = 1 WHERE token_hash = ?").run(guest.hash); },
    "session-deleted": async (_fx, guest) => { owner.query("DELETE FROM share_sessions WHERE token_hash = ?").run(guest.hash); },
    "saver-unreadable": async (_fx, _guest, template) => { owner.query("UPDATE db_template_savers SET roles = 'not json' WHERE template_id = ?").run(template); },
    "rule-revoked": async (_fx, guest) => { expect((await asOwner("DELETE", "/api/page/root/access/rules/" + guest.rule)).status).toBe(200); },
    "role-narrowed": async (_fx, guest) => { expect((await asOwner("PATCH", "/api/page/root/access/rules/" + guest.rule, { body: { role: "read" } })).status).toBe(200); },
  };
  for (const [name, breakSaver] of Object.entries(SAVER_BREAKS)) {
    saverTest(name, "a guest-saved schedule whose saver can no longer be resolved (" + name + ") writes nothing, is recorded and stays stopped", async () => {
      const fx = await sweepFixture("sv-" + name);
      const guest = await freshGuest("saver-" + name + "@example.com");
      const posted = await call("POST", "/api/db/" + fx.source + "/templates", { cookie: guest.cookie, body: { name: "Guest daily", props: { [fx.rel]: [fx.open.id] } } });
      expect(posted.status).toBe(200);
      const template = posted.data.template.id;
      expect((await call("PATCH", "/api/db/" + fx.source + "/templates/" + template, { cookie: guest.cookie, body: { recurrence: daily } })).status).toBe(200);
      // Control: while the saver resolves, the tick runs it and links the row it could edit.
      const rows = sourceRows(fx);
      expect((await tickAt(3)).status).toBe(200);
      expect(sourceRows(fx)).toBe(rows + 1);
      await breakSaver(fx, guest, template);
      const before = tableSnapshot();
      const first = await tickAt(5);
      expect(first.status).toBe(200);
      expect(first.body.created.filter((c: any) => c.template === template)).toEqual([]);
      expect(tableSnapshot()).toEqual(before);
      expect(typeof (await templateView(fx, template)).blocked).toBe("string");
      expect((await tickAt(7)).status).toBe(200);
      expect(tableSnapshot()).toEqual(before);
      const fromTemplate = await asOwner("POST", "/api/db/" + fx.source + "/rows", { body: { template, props: {} } });
      expect(fromTemplate.status).toBe(403);
      expect(tableSnapshot()).toEqual(before);
      // The owner saving only the schedule again does not lend the owner's permission to the guest's values: the saver is
      // checked again on the next run and the template stops again, writing no row.
      expect((await asOwner("PATCH", "/api/db/" + fx.source + "/templates/" + template, { body: { recurrence: daily } })).status).toBe(200);
      const rowsBeforeOwnerSchedule = sourceRows(fx);
      await tickAt(9);
      expect({ rows: sourceRows(fx), stopped: typeof (await templateView(fx, template)).blocked }).toEqual({ rows: rowsBeforeOwnerSchedule, stopped: "string" });
      await dropDbs(fx);
    });
  }

  test("an owner-saved template linking a private row still runs, and a guest saver keeps linking rows it may edit (#86)", async () => {
    const fx = await sweepFixture("sv-owner");
    const template = (await asOwner("POST", "/api/db/" + fx.source + "/templates", { body: { name: "Owner daily", props: { [fx.rel]: [fx.priv.id] } } })).data.template.id;
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/templates/" + template, { body: { recurrence: daily } })).status).toBe(200);
    const before = privLinks(fx).length;
    await tickAt(3);
    expect(privLinks(fx).length).toBe(before + 2);
    expect((await templateView(fx, template)).blocked).toBeNull();
    const made = await asOwner("POST", "/api/db/" + fx.source + "/rows", { body: { template, props: {} } });
    expect(made.status).toBe(200);
    await dropDbs(fx);
  });

  // N5: an owner API caller may still send a property name as a template key; it is stored under the id. A name that
  // matches no property or more than one is a 400, never a silent drop.
  saverTest("n5-name-keys", "a template name key matching two properties is refused", async () => {
    const slug = (await asOwner("POST", "/api/db", { body: { title: "Dup names", slug: "wp-dup-names", parent: "root", page: true } })).data.slug;
    const first = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Dup", type: "text" } })).data.property.id;
    expect((await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Dup", type: "text" } })).status).toBe(200);
    const dup = await asOwner("POST", "/api/db/" + slug + "/templates", { body: { name: "T", props: { Dup: "x" } } });
    expect(dup.status).toBe(400);
    const plain = (await asOwner("POST", "/api/db/" + slug + "/templates", { body: { name: "T", props: {} } })).data.template.id;
    expect((await asOwner("PATCH", "/api/db/" + slug + "/templates/" + plain, { body: { props: { Dup: "x" } } })).status).toBe(400);
    const byId = await asOwner("POST", "/api/db/" + slug + "/templates", { body: { name: "T", props: { [first]: "x" } } });
    expect([byId.status, storedProps(byId.data.template.id)]).toEqual([200, { [first]: "x" }]);
    await asOwner("DELETE", "/api/db/" + slug);
  });

  // B10 migration: stored templates are rewritten to the checked shape; the original values stay in the backup table.
  saverTest("migration", "the template migration clears every legacy shape and keeps the original values", async () => {
    const fx = await sweepFixture("b10-migrate");
    const relation = (await asOwner("GET", "/api/db/" + fx.source)).data.properties.find((prop: any) => prop.id === fx.rel);
    expect((await asOwner("PATCH", "/api/db/" + fx.source + "/properties/" + fx.rel, { body: { config: { ...relation.config, limit: 1 } } })).status).toBe(200);
    const shapes = {
      i: await legacyTemplate(fx, "mi", { [fx.rel]: fx.open.id }),
      ii: await legacyTemplate(fx, "mii", { [fx.rel]: [fx.priv.id, fx.open.id] }),
      iii: await legacyTemplate(fx, "miii", { [fx.rel]: [fx.src.id] }),
    };
    const original = Object.fromEntries(Object.entries(shapes).map(([k, id]) => [k, storedProps(id)]));
    const migrate = async () => {
      env.TEMPLATE_MIGRATE_SECRET = "migrate-secret";
      try {
        const res = await worker.fetch(new Request("https://notes.example.com/__templates/migrate", { method: "POST", headers: { "content-type": "application/json", "x-template-migrate": "migrate-secret" }, body: JSON.stringify({ ws: "owner" }) }), env, {});
        return { status: res.status, body: (await res.json()) as any };
      } finally {
        delete env.TEMPLATE_MIGRATE_SECRET;
      }
    };
    const run = await migrate();
    expect(run.status).toBe(200);
    expect([run.body.before.i >= 1, run.body.before.ii >= 1, run.body.before.iii >= 1]).toEqual([true, true, true]);
    expect(run.body.after).toEqual({ i: 0, ii: 0, iii: 0 });
    expect(run.body.changed).toEqual(expect.arrayContaining(Object.values(shapes)));
    expect(Object.fromEntries(Object.entries(shapes).map(([k, id]) => [k, storedProps(id)]))).toEqual({ i: { [fx.rel]: [fx.open.id] }, ii: { [fx.rel]: [fx.open.id] }, iii: { [fx.rel]: [] } });
    for (const [k, id] of Object.entries(shapes)) {
      const kept = owner.query("SELECT value FROM db_value_backups WHERE kind = 'template' AND ref = ?").all(id) as any[];
      expect({ k, kept: kept.map((row) => JSON.parse(row.value)) }).toEqual({ k, kept: [original[k]] });
    }
    // Wrong secret: not found. A second run changes nothing.
    expect((await worker.fetch(new Request("https://notes.example.com/__templates/migrate", { method: "POST", headers: { "x-template-migrate": "nope" }, body: "{}" }), env, {})).status).toBe(404);
    expect((await migrate()).body.changed).toEqual([]);
    await dropDbs(fx);
  });

  // Gate review of 0039b9a: one batch for all button steps must still run database rules once per step.
  test("an owner row button runs rules on every step like separate saves (#86)", async () => {
    const slug = (await asOwner("POST", "/api/db", { body: { title: "Rule steps", slug: "wp-rule-steps", parent: "root", page: true } })).data.slug;
    const flag = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Flag", type: "checkbox" } })).data.property.id;
    const memo = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Note", type: "text" } })).data.property.id;
    expect((await asOwner("POST", "/api/db/" + slug + "/rules", { body: { config: { trigger: { type: "changed", property: flag, value: true }, action: { type: "set", property: memo, value: "rule-fired" } } } })).status).toBe(201);
    const row = (await asOwner("POST", "/api/db/" + slug + "/rows", { body: { props: { [memo]: "before" } } })).data.row;
    const button = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Toggle", type: "button", config: { actions: [{ type: "update_row", values: { [flag]: true } }, { type: "update_row", values: { [flag]: false } }] } } })).data.property.id;
    const pressed = await asOwner("POST", "/api/db/" + slug + "/rows/" + row.id + "/button/" + button, { body: {} });
    expect([pressed.status, pressed.data.updated]).toEqual([200, 2]);
    const props = (await asOwner("GET", "/api/db/" + slug)).data.rows[0].props;
    expect([props[flag], props[memo]]).toEqual([false, "rule-fired"]);
    await asOwner("DELETE", "/api/db/" + slug);
  });

  // Gate review of 0039b9a: one batch for all button steps must still run database rules once per step.
  test("an owner row button runs rules on every step like separate saves (#86)", async () => {
    const slug = (await asOwner("POST", "/api/db", { body: { title: "Rule steps", slug: "wp-rule-steps", parent: "root", page: true } })).data.slug;
    const flag = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Flag", type: "checkbox" } })).data.property.id;
    const memo = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Note", type: "text" } })).data.property.id;
    expect((await asOwner("POST", "/api/db/" + slug + "/rules", { body: { config: { trigger: { type: "changed", property: flag, value: true }, action: { type: "set", property: memo, value: "rule-fired" } } } })).status).toBe(201);
    const row = (await asOwner("POST", "/api/db/" + slug + "/rows", { body: { props: { [memo]: "before" } } })).data.row;
    const button = (await asOwner("POST", "/api/db/" + slug + "/properties", { body: { name: "Toggle", type: "button", config: { actions: [{ type: "update_row", values: { [flag]: true } }, { type: "update_row", values: { [flag]: false } }] } } })).data.property.id;
    const pressed = await asOwner("POST", "/api/db/" + slug + "/rows/" + row.id + "/button/" + button, { body: {} });
    expect([pressed.status, pressed.data.updated]).toEqual([200, 2]);
    const props = (await asOwner("GET", "/api/db/" + slug)).data.rows[0].props;
    expect([props[flag], props[memo]]).toEqual([false, "rule-fired"]);
    await asOwner("DELETE", "/api/db/" + slug);
  });

  // Every statement that writes table data, by function (and by handleApi route), with the sweep case or the reason that
  // covers it. A new write statement, or one moved to another function, fails this test until it is listed here.
  const WRITE_SQL = /(?:INSERT(?: OR [A-Z]+)? INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+(?:db_rows|db_relation_links|db_properties|db_templates|databases|db_views|db_counters|db_rules|db_relation_locks|db_forms|db_template_runs)\b/g;
  const WRITE_PATHS: Record<string, { count: number; cases?: string[]; reason?: string }> = {
    "gate/_worker.js#importZip": { count: 1, cases: ["import"] },
    "gate/_worker.js#runDueTemplates": { count: 4, reason: "runs later as the owner, so a guest request is checked when it stores the values or a schedule: template POST, PATCH props, and any PATCH that leaves a recurrence on", cases: ["template-post", "template-patch", "template-schedule"] },
    "gate/_worker.js#CYCLE_GUARD": { count: 1, cases: ["subitem-move"] },
    "gate/_worker.js#migrateTemplates": { count: 1, reason: "one-time rewrite behind TEMPLATE_MIGRATE_SECRET (no guest route); only narrows stored values to the checked shape and keeps the originals in db_value_backups (test: template migration)" },
    "gate/_worker.js#applyRowProps": { count: 10, cases: ["relation-add", "relation-clear", "row-create-linking"] },
    "gate/_worker.js#deleteRowsWithRelations": { count: 1, cases: ["row-delete", "linked-row-delete"] },
    "gate/_worker.js#rowDeleteRelationStatements": { count: 3, cases: ["linked-row-delete", "linked-db-delete"] },
    "gate/_worker.js#nextUniqueId": { count: 1, cases: ["property-unique-id"] },
    "gate/_worker.js#ensureUniqueIds": { count: 3, cases: ["property-unique-id", "property-type-change"] },
    "gate/_worker.js#createDatabase": { count: 2, reason: "makes a new database under a page the guest may edit; seeded relations lose any pair (test: forged seed pair)" },
    "gate/_worker.js#relationCacheStatement": { count: 1, cases: ["relation-add", "linked-row-delete"] },
    "gate/_worker.js#relationConversionStatements": { count: 2, cases: ["property-type-change", "property-delete"], reason: "clears the old values of a property the request turns into a relation; runs only after the type-change check (every row of the database editable) and keeps the values in db_value_backups" },
    "gate/_worker.js#enableRelationPair": { count: 6, cases: ["property-synced-create", "property-synced-enable", "subitems-on"] },
    "gate/_worker.js#disableRelationPairStatements": { count: 5, cases: ["property-synced-disable", "property-synced-drop-pair", "row-page-permanent"], reason: "a pair counts only when it lives in the target database and points back (test: forged seed pair)" },
    "gate/_worker.js#switchSubitems": { count: 4, cases: ["subitems-on"] },
    "gate/_worker.js#saveProperties": { count: 2, reason: "only for a database createDatabase or the ZIP import just made; relation pair is never taken from input (test: forged seed pair)" },
    "gate/_worker.js#syncPageTitleToRow": { count: 2, cases: ["row-page-title", "row-page-save"] },
    "gate/_worker.js#syncDbSeed": { count: 6, cases: ["sync"] },
    "gate/_worker.js#prepareCreateRow": { count: 1, cases: ["row-create-linking", "button-create-row-link", "block-button-create-row"] },
    "gate/_worker.js#preparePatchRow": { count: 1, cases: ["row-patch-props", "button-update-row-link", "button-update-related"] },
    "gate/_worker.js#permanentDeletePlan": { count: 7, cases: ["row-page-permanent"] },
    "gate/_worker.js#handleApi:db PATCH": { count: 1, cases: ["subitems-on"], reason: "title/icon/config of the database page itself; the route needs edit on it" },
    "gate/_worker.js#handleApi:db DELETE": { count: 8, cases: ["linked-db-delete"] },
    "gate/_worker.js#handleApi:properties POST": { count: 2, cases: ["property-unique-id", "property-synced-create"] },
    "gate/_worker.js#handleApi:properties PATCH": { count: 4, cases: ["property-type-change", "property-synced-enable", "property-synced-disable"] },
    "gate/_worker.js#handleApi:properties DELETE": { count: 3, cases: ["property-delete"] },
    "gate/_worker.js#handleApi:rows PATCH": { count: 1, cases: ["row-patch-ord"] },
    "gate/_worker.js#handleApi:views POST": { count: 1, reason: "view settings only, no row values; the route needs edit on the database" },
    "gate/_worker.js#handleApi:views PATCH": { count: 1, reason: "view settings only, no row values; the route needs edit on the database" },
    "gate/_worker.js#handleApi:views DELETE": { count: 1, reason: "view settings only, no row values; the route needs edit on the database" },
    "gate/_worker.js#handleApi:templates POST": { count: 1, cases: ["template-post", "template-post-scalar"] },
    "gate/_worker.js#handleApi:templates PATCH": { count: 1, cases: ["template-patch", "template-schedule"] },
    "gate/_worker.js#handleApi:templates DELETE": { count: 1, reason: "removes a template, no row values" },
    "features/db-rules.js": { count: 3, cases: ["rules"] },
    "features/form-row.js": { count: 1, cases: ["form-config"], reason: "public form submit makes a new row; relation is not an allowed form field" },
    "features/home-setup.js": { count: 2, cases: ["home-starter"] },
  };
  async function tableWriteInventory() {
    const files = ["gate/_worker.js", "agent-api.js", "editor-pages.js", ...[...new Bun.Glob("features/*.js").scanSync({ cwd: ROOT })].map((f) => f.replace(/\\/g, "/")).sort()];
    const out: Record<string, number> = {};
    for (const file of files) {
      let fn = file.startsWith("gate/") ? "(top)" : "";
      let route = "";
      for (const line of (await readFile(join(ROOT, file), "utf8")).split("\n")) {
        if (file === "gate/_worker.js") {
          const m = /^(?:async )?function (\w+)|^const (\w+) =/.exec(line);
          if (m) { fn = m[1] || m[2]; route = ""; }
          if (fn === "handleApi") {
            const r = /^ {4,6}if \((?:!target && |target && )?(?:method === "(\w+)"|kind === "(\w+)")/.exec(line);
            if (r) route = (r[2] ? r[2] : route.split(" ")[0]) + (r[1] ? " " + r[1] : "");
          }
        }
        const n = (line.match(WRITE_SQL) || []).length;
        if (n) { const key = file + (fn ? "#" + fn : "") + (fn === "handleApi" && route ? ":" + route : ""); out[key] = (out[key] || 0) + n; }
      }
    }
    return out;
  }
  test("every table write path is listed with a guest sweep case or a reason, and every guest write route is swept (#86)", async () => {
    const found = await tableWriteInventory();
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITE_PATHS).map(([key, entry]) => [key, entry.count])));
    for (const [key, entry] of Object.entries(WRITE_PATHS)) {
      expect({ key, covered: !!(entry.cases?.length || entry.reason) }).toEqual({ key, covered: true });
      for (const name of entry.cases ?? []) expect({ key, name, swept: name in SWEEP }).toEqual({ key, name, swept: true });
    }
    // Guest write routes (features/share.js GUEST_ROUTES) that reach table data, each with its sweep cases.
    const share = await readFile(join(ROOT, "features", "share.js"), "utf8");
    const routes = [...share.matchAll(/^\s+\["([A-Z|]+)", (.+), "(\w+)"(?:, [^\]]+)?\],$/gm)].map((m) => m[1] + " " + m[2]).filter((r) => !/^GET(\|HEAD)? /.test(r));
    const GUEST_WRITE_ROUTES: Record<string, string[]> = {
      "POST /^\\/api\\/pages$/": [],
      'PUT new RegExp(P + "$")': ["row-page-save"],
      'DELETE new RegExp(P + "$")': [],
      'POST new RegExp(P + "\\\\/rename$")': ["row-page-title"],
      'POST new RegExp(P + "\\\\/move$")': [],
      'PATCH new RegExp(P + "\\\\/blocks$")': ["row-page-save"],
      'POST new RegExp(P + "\\\\/move-blocks$")': ["block-move-private-target"],
      'POST new RegExp(P + "\\\\/synced$")': ["synced-create-private-page"],
      'PATCH new RegExp(P + "\\\\/synced\\\\/[^/]+$")': ["synced-edit-private-page"],
      'POST new RegExp(P + "\\\\/synced\\\\/[^/]+\\\\/detach$")': ["synced-detach-private-page"],
      'POST new RegExp(P + "\\\\/button\\\\/[^/]+$")': ["block-button-create-row"],
      'PUT new RegExp(P + "\\\\/settings$")': [],
      'POST new RegExp(P + "\\\\/comments$")': [],
      'PATCH|DELETE new RegExp(P + "\\\\/comments\\\\/[^/]+$")': [],
      'POST new RegExp(P + "\\\\/history\\\\/[^/]+\\\\/restore$")': ["row-page-history-restore"],
      'POST new RegExp(P + "\\\\/access\\\\/request$")': [],
      'GET|POST|PUT|PATCH|DELETE new RegExp(P + "\\\\/(?:access|share)(?:\\\\/.*)?$")': [],
      "PATCH /^\\/api\\/db\\/([^/]+)$/": ["subitems-on"],
      "DELETE /^\\/api\\/db\\/([^/]+)$/": ["linked-db-delete"],
      "POST|PATCH|DELETE /^\\/api\\/db\\/([^/]+)\\/(?:rows|properties|views|templates)(?:\\/[^/]+)?$/": ["row-patch-props", "row-delete", "row-create-linking", "property-type-change", "property-delete", "template-post", "template-patch"],
      "POST /^\\/api\\/db\\/([^/]+)\\/rows\\/[^/]+\\/button\\/[^/]+$/": ["button-update-related", "button-update-row-link", "button-create-row-link"],
    };
    expect(routes).toEqual(Object.keys(GUEST_WRITE_ROUTES));
    // Gate review 6 + lead order: the link-time saver check keeps one test per way a saver can stop resolving, plus the
    // legacy and migration cases. Removing one of them fails here.
    expect([...SAVER_TESTS].sort()).toEqual(["legacy-guest-db", "migration", "n5-name-keys", "role-narrowed", "rule-revoked", "saver-unreadable", "session-deleted", "session-revoked"]);
    for (const names of Object.values(GUEST_WRITE_ROUTES)) for (const name of names) expect(name in SWEEP).toBe(true);
  });

  test("deleting a database whose rows are two-way linked stays under the D1 100-parameter limit (#86)", async () => {
    const source = (await asOwner("POST", "/api/db", { body: { title: "Many", slug: "wp-many-src", parent: "root", page: true } })).data.slug;
    const target = (await asOwner("POST", "/api/db", { body: { title: "Many back", slug: "wp-many-tgt", parent: "root", page: true } })).data.slug;
    const rel = (await asOwner("POST", "/api/db/" + source + "/properties", { body: { name: "Related", type: "relation", config: { database: target, synced: true } } })).data;
    const back = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: {} } })).data.row;
    for (let i = 0; i < 130; i += 1) expect((await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: { [rel.property.id]: [back.id] } } })).status).toBe(200);
    if (!sweepGuest) sweepGuest = await sweepVerify();
    maxParams = 100;
    try {
      const res = await call("DELETE", "/api/db/" + source, { cookie: sweepGuest });
      expect(res.status).toBe(200);
    } finally {
      maxParams = Infinity;
    }
    expect((await asOwner("GET", "/api/db/" + target)).data.rows[0].props[rel.pair.id]).toEqual([]);
    expect(owner.query("SELECT COUNT(*) AS n FROM db_relation_links WHERE src_row = ? OR dst_row = ?").get(back.id, back.id)).toEqual({ n: 0 });
    await asOwner("DELETE", "/api/db/" + target);
  });

  for (const hidden of ["database", "row"] as const) {
    test("guest rollups and relation formulas exclude hidden " + hidden + " targets (#86)", async () => {
      const source = (await asOwner("POST", "/api/db", { body: { title: "Source", slug: "audit86-source-" + hidden, parent: "root", page: true } })).data.slug;
      const target = (await asOwner("POST", "/api/db", { body: { title: "Target", slug: "audit86-target-" + hidden, parent: hidden === "database" ? "other" : "root", page: true } })).data.slug;
      const property = async (slug: string, body: unknown) => {
        const result = await asOwner("POST", "/api/db/" + slug + "/properties", { body });
        expect(result.status).toBe(200);
        return result.data.property;
      };
      const amount = await property(target, { name: "Amount", type: "number" });
      const relation = await property(source, { name: "Related", type: "relation", config: { database: target } });
      const rollup = await property(source, { name: "Total", type: "rollup", config: { relation_property: relation.id, target_property: amount.id, function: "sum" } });
      const formula = await property(source, { name: "Formula", type: "formula", config: { expression: 'prop("Related").map(current.prop("Amount")).sum()' } });
      const title = (await asOwner("GET", "/api/db/" + target)).data.properties.find((p: any) => p.type === "title").id;
      const privateRow = (await asOwner("POST", "/api/db/" + target + "/rows", { body: { props: { [title]: "Target " + hidden, [amount.id]: 987654 } } })).data.row;
      await asOwner("POST", "/api/db/" + source + "/rows", { body: { props: { [relation.id]: [privateRow.id] } } });
      const guest = await np5Guest("read");
      if (hidden === "row") expect((await asOwner("PUT", "/api/page/" + privateRow.page + "/access/settings", { body: { inherit: false } })).status).toBe(200);
      else await invite(privateRow.page, "np5-read@example.com", "read");
      expect((await call("GET", "/api/page/" + privateRow.page, { cookie: guest })).status).toBe(hidden === "row" ? 401 : 200);
      const ownerResult = (await asOwner("GET", "/api/db/" + source)).data.rows[0];
      expect(ownerResult.computed).toMatchObject({ [rollup.id]: 987654, [formula.id]: 987654 });
      const result = await call("GET", "/api/db/" + source, { cookie: guest });
      expect(result.status).toBe(200);
      expect(result.data.rows[0].computed).toMatchObject({ [rollup.id]: 0, [formula.id]: 0 });
      await asOwner("DELETE", "/api/db/" + source);
      await asOwner("DELETE", "/api/db/" + target);
    });
  }

  test("a guest can change a two-way relation only when it may edit both databases (notion-parity-5 C2)", async () => {
    const trips = (await asOwner("POST", "/api/db", { body: { title: "여행", slug: "np5-trips", parent: "root", page: true } })).data;
    const plans = (await asOwner("POST", "/api/db", { body: { title: "일정", slug: "np5-plans", parent: "other", page: true } })).data;
    const rel = (await asOwner("POST", "/api/db/" + plans.slug + "/properties", { body: { name: "여행", type: "relation", config: { database: trips.slug, synced: true }, pairName: "일정" } })).data;
    const trip = (await asOwner("POST", "/api/db/" + trips.slug + "/rows", { body: { props: {} } })).data.row;
    const plan = (await asOwner("POST", "/api/db/" + plans.slug + "/rows", { body: { props: {} } })).data.row;
    const values = async () => [
      (await asOwner("GET", "/api/db/" + trips.slug)).data.rows.find((r: any) => r.id === trip.id).props[rel.pair.id],
      (await asOwner("GET", "/api/db/" + plans.slug)).data.rows.find((r: any) => r.id === plan.id).props[rel.property.id],
    ];
    const reader = await np5Guest("read");
    const denied = await call("PATCH", "/api/db/" + trips.slug + "/rows/" + trip.id, { cookie: reader, body: { props: { [rel.pair.id]: [plan.id] } } });
    expect(denied.status).toBe(401);
    expect(await values()).toEqual([[], []]);
    const editor = await np5Guest("edit");
    const otherSide = await call("PATCH", "/api/db/" + trips.slug + "/rows/" + trip.id, { cookie: editor, body: { props: { [rel.pair.id]: [plan.id] } } });
    expect(otherSide.status).toBe(401);
    expect(await values()).toEqual([[], []]);
    expect((await asOwner("PATCH", "/api/db/" + trips.slug + "/rows/" + trip.id, { body: { props: { [rel.pair.id]: [plan.id] } } })).status).toBe(200);
    expect(await values()).toEqual([[plan.id], [trip.id]]);
    await asOwner("DELETE", "/api/db/" + trips.slug);
    await asOwner("DELETE", "/api/db/" + plans.slug);
  });

  test("an edit guest cannot save or run a button whose target database it may not edit; readers and visitors cannot press at all (notion-parity-7 C3 C4)", async () => {
    const mine = (await asOwner("POST", "/api/db", { body: { title: "내 할 일", slug: "np7-mine", parent: "root", page: true } })).data;
    const theirs = (await asOwner("POST", "/api/db", { body: { title: "남의 기록", slug: "np7-theirs", parent: "other", page: true } })).data;
    const count = async (slug: string) => (await asOwner("GET", "/api/db/" + slug)).data.rows.length;
    const editor = await np5Guest("edit");
    const reader = await np5Guest("read");

    const before = (await asOwner("GET", "/api/page/child")).data.blocks;
    const save = (cookie: string, actions: unknown) => call("GET", "/api/page/child", { cookie }).then((page) =>
      call("PUT", "/api/page/child", { cookie, body: { base_updated: page.data.page.updated, blocks: [...before, { id: "np7", type: "button", text: "추가", meta: { actions } }] } }));
    expect((await save(editor, [{ type: "create_row", database: theirs.slug }])).status).toBe(200);
    expect((await asOwner("GET", "/api/page/child")).data.blocks.find((b: any) => b.id === "np7").meta.actions).toBeUndefined();
    expect((await save(editor, [{ type: "create_row", database: mine.slug }])).status).toBe(200);
    expect((await asOwner("GET", "/api/page/child")).data.blocks.find((b: any) => b.id === "np7").meta.actions).toEqual([{ type: "create_row", database: mine.slug, values: {} }]);
    expect((await call("POST", "/api/page/child/button/np7", { cookie: editor, body: {} })).status).toBe(200);
    expect(await count(mine.slug)).toBe(1);

    expect((await asOwner("PUT", "/api/page/child", { body: { blocks: [...before, { id: "np7", type: "button", text: "추가", meta: { actions: [{ type: "create_row", database: theirs.slug }] } }] } })).status).toBe(200);
    const forbidden = await call("POST", "/api/page/child/button/np7", { cookie: editor, body: {} });
    expect(forbidden.status).toBe(403);
    expect(await count(theirs.slug)).toBe(0);

    const linked = (await asOwner("POST", "/api/db/" + mine.slug + "/properties", { body: { name: "기록", type: "relation", config: { database: theirs.slug } } })).data.property;
    const theirRow = (await asOwner("POST", "/api/db/" + theirs.slug + "/rows", { body: { props: {} } })).data.row;
    const myRow = (await asOwner("POST", "/api/db/" + mine.slug + "/rows", { body: { props: { [linked.id]: [theirRow.id] } } })).data.row;
    const theirTitle = (await asOwner("GET", "/api/db/" + theirs.slug)).data.properties.find((p: any) => p.type === "title").id;
    const related = (await asOwner("POST", "/api/db/" + mine.slug + "/properties", { body: { name: "기록 바꾸기", type: "button", config: { actions: [{ type: "update_related", relation: linked.id, values: { [theirTitle]: "바뀜" } }] } } })).data.property;
    const relatedPress = await call("POST", "/api/db/" + mine.slug + "/rows/" + myRow.id + "/button/" + related.id, { cookie: editor, body: {} });
    expect(relatedPress.status).toBe(403);
    expect((await asOwner("GET", "/api/db/" + theirs.slug)).data.rows[0].pageTitle).not.toBe("바뀜");
    const stealProp = await call("POST", "/api/db/" + mine.slug + "/properties", { cookie: editor, body: { name: "훔치기", type: "button", config: { actions: [{ type: "create_row", database: theirs.slug }] } } });
    expect(stealProp.status).toBe(403);

    const rowsBefore = await count(mine.slug);
    expect((await call("POST", "/api/page/child/button/np7", { cookie: reader, body: {} })).status).toBe(401);
    expect((await call("POST", "/api/db/" + mine.slug + "/rows/" + myRow.id + "/button/" + related.id, { cookie: reader, body: {} })).status).toBe(401);
    expect((await call("POST", "/api/page/child/button/np7", { body: {} })).status).toBe(401);
    expect(await count(mine.slug)).toBe(rowsBefore);
    expect(await count(theirs.slug)).toBe(1);

    expect((await asOwner("PUT", "/api/page/child", { body: { blocks: before } })).status).toBe(200);
    await asOwner("DELETE", "/api/db/" + mine.slug);
    await asOwner("DELETE", "/api/db/" + theirs.slug);
  });

  test("person candidates are this database page's shared emails, all for full, self and assigned for edit, none for read (notion-parity-5 C10)", async () => {
    const team = (await asOwner("POST", "/api/db", { body: { title: "팀 할 일", slug: "np5-team", parent: "root", page: true, properties: [{ id: "title", name: "이름", type: "title" }, { id: "who", name: "담당", type: "person" }] } })).data;
    const schema = (await asOwner("GET", "/api/db/" + team.slug)).data;
    const who = schema.properties.find((p: any) => p.type === "person").id;
    const edit = await np5Guest("edit");
    const read = await np5Guest("read");
    await invite("root", "np5-full@example.com", "full");
    const full = await verify(await invite("root", "np5-full@example.com", "full"), "np5-full@example.com");
    await invite("other", "np5-elsewhere@example.com", "edit");
    const owner = await asOwner("GET", "/api/db/" + team.slug + "/people");
    expect(owner.status).toBe(200);
    const emails = owner.data.people.map((p: any) => p.email);
    expect(emails).toEqual(expect.arrayContaining(["owner@test.dev", "np5-full@example.com", "np5-edit@example.com", "np5-read@example.com"]));
    expect(emails).not.toContain("np5-elsewhere@example.com");
    const asFull = await call("GET", "/api/db/" + team.slug + "/people", { cookie: full });
    expect(asFull.data.people.map((p: any) => p.email).sort()).toEqual([...emails].sort());
    expect((await asOwner("POST", "/api/db/" + team.slug + "/rows", { body: { props: { [who]: ["np5-full@example.com"] } } })).status).toBe(200);
    const asEdit = await call("GET", "/api/db/" + team.slug + "/people", { cookie: edit });
    expect(asEdit.status).toBe(200);
    expect(asEdit.data.people.map((p: any) => p.email).sort()).toEqual(["np5-edit@example.com", "np5-full@example.com"]);
    const blocked = await call("POST", "/api/db/" + team.slug + "/rows", { cookie: edit, body: { props: { [who]: ["np5-read@example.com"] } } });
    expect(blocked.status).toBe(400);
    expect((await call("POST", "/api/db/" + team.slug + "/rows", { cookie: edit, body: { props: { [who]: ["np5-edit@example.com"] } } })).status).toBe(200);
    const asRead = await call("GET", "/api/db/" + team.slug + "/people", { cookie: read });
    expect(asRead.status).toBe(401);
    expect(JSON.stringify(asRead.data)).not.toContain("@example.com");
    await asOwner("DELETE", "/api/db/" + team.slug);
  });

  test("a button round-trips through the agent read_page/update_page operations; actions on a database the token may not write are not saved (notion-parity-7 C3)", async () => {
    const ok = (await asOwner("POST", "/api/db", { body: { title: "할 일", slug: "np7-mcp-ok", parent: "root", page: true } })).data;
    const hidden = (await asOwner("POST", "/api/db", { body: { title: "숨긴 DB", slug: "np7-mcp-hidden", parent: "other", page: true } })).data;
    const made = await asOwner("POST", "/api/agents/tokens", { body: { name: "np7-writer", scopes: ["read", "write"] } });
    const ops: Record<string, (args: any) => [string, string, unknown]> = {
      create_page: (a) => ["POST", "/api/v1/pages", a],
      read_page: (a) => ["GET", "/api/v1/pages/" + encodeURIComponent(a.slug) + "?format=json", undefined],
      update_page: (a) => ["PUT", "/api/v1/pages/" + encodeURIComponent(a.slug), a],
    };
    const tool = (name: string, args: unknown) => { const [m, p, b] = ops[name](args); return call(m, p, { bearer: made.data.token, body: b }); };
    const content = (res: any) => { expect(res.status).toBeLessThan(300); return res.data; };
    const md = (label: string, db: string) => '---\nacard_meta: 1\n---\n\n- [button] ' + label + '\n<!--acard {"actions":[{"type":"create_row","database":"' + db + '"},{"type":"open","target":"created"}],"color":"blue"}-->\n';
    const created = content(await tool("create_page", { title: "np7 버튼", parent: "root", markdown: md("추가", ok.slug) }));
    const read = content(await tool("read_page", { slug: created.slug }));
    expect(read.markdown).toContain("- [button] 추가\n<!--acard ");
    expect(read.markdown).toContain('"database":"' + ok.slug + '"');
    const updated = content(await tool("update_page", { slug: created.slug, markdown: read.markdown.replace("- [button] 추가", "- [button] 할 일 더하기"), expectedUpdated: read.updated }));
    expect(updated.updated).toBe(true);
    const page = (await asOwner("GET", "/api/page/" + encodeURIComponent(created.slug))).data.blocks[0];
    expect(page.text).toBe("할 일 더하기");
    expect(page.meta.actions[0]).toEqual({ type: "create_row", database: ok.slug, values: {} });
    const pressed = await asOwner("POST", "/api/page/" + encodeURIComponent(created.slug) + "/button/" + page.id, { body: {} });
    expect(pressed.status).toBe(200);
    expect((await asOwner("GET", "/api/db/" + ok.slug)).data.rows.length).toBe(1);

    expect((await asOwner("PUT", "/api/page/other/access/agents", { body: { token: made.data.record.id, level: "read" } })).status).toBe(200);
    const sneaky = content(await tool("create_page", { title: "np7 숨김", parent: "root", markdown: md("몰래", hidden.slug) }));
    expect(sneaky.buttons).toContain("버튼 1개");
    const stored = (await asOwner("GET", "/api/page/" + encodeURIComponent(sneaky.slug))).data.blocks[0];
    expect(stored.meta.actions).toBeUndefined();
    expect(stored.meta.color).toBe("blue");

    await asOwner("PUT", "/api/page/other/access/agents", { body: { token: made.data.record.id, level: "inherit" } });
    await asOwner("DELETE", "/api/agents/tokens/" + made.data.record.id);
    for (const slug of [created.slug, sneaky.slug]) owner.query("DELETE FROM pages WHERE slug = ?").run(slug);
    await asOwner("DELETE", "/api/db/" + ok.slug);
    await asOwner("DELETE", "/api/db/" + hidden.slug);
  });

  test("agent tokens are narrowed per page and never widened", async () => {
    const made = await asOwner("POST", "/api/agents/tokens", { body: { name: "writer", scopes: ["read", "write"] } });
    const reader = await asOwner("POST", "/api/agents/tokens", { body: { name: "reader", scopes: ["read"] } });
    const blocks = await call("GET", "/api/v1/pages/root/blocks", { bearer: made.data.token });
    expect(blocks.status).toBe(200);
    const edit = (token: string, version: number) => call("PATCH", "/api/v1/pages/root/blocks/r1", { bearer: token, body: { markdown: "agent edit", expected_version: version } });
    expect((await asOwner("PUT", "/api/page/root/access/agents", { body: { token: made.data.record.id, level: "read" } })).status).toBe(200);
    expect((await edit(made.data.token, blocks.data.version)).status).toBe(403);
    expect((await call("GET", "/api/v1/pages/root", { bearer: made.data.token })).status).toBe(200);
    expect((await asOwner("PUT", "/api/page/root/access/agents", { body: { token: reader.data.record.id, level: "write" } })).status).toBe(200);
    expect((await edit(reader.data.token, blocks.data.version)).status).toBe(403);
    expect((await asOwner("PUT", "/api/page/root/access/agents", { body: { token: made.data.record.id, level: "write" } })).status).toBe(200);
    expect((await edit(made.data.token, blocks.data.version)).status).toBe(200);
    expect((await asOwner("PUT", "/api/page/other/access/agents", { body: { token: made.data.record.id, level: "none" } })).status).toBe(200);
    expect((await call("GET", "/api/v1/pages/other", { bearer: made.data.token })).status).toBe(403);
    expect(JSON.stringify((await call("GET", "/api/v1/pages", { bearer: made.data.token })).data)).not.toContain('"other"');
    const mcp = await call("POST", "/mcp", { bearer: made.data.token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_page", arguments: { slug: "other" } } } });
    expect(JSON.stringify(mcp.data)).not.toContain(SECRET_TEXT);
    await asOwner("DELETE", "/api/agents/tokens/" + made.data.record.id);
    await asOwner("DELETE", "/api/agents/tokens/" + reader.data.record.id);
  });

  test("moving a page under a shared parent asks for confirmation", async () => {
    const found = await invite("other", "move@example.com");
    const warned = await asOwner("POST", "/api/page/grand/move", { body: { parent: "other" } });
    expect(warned.status).toBe(409);
    expect(warned.data.error).toContain("이 페이지가 공유됩니다");
    expect((await asOwner("POST", "/api/page/grand/move", { body: { parent: "other", confirmShare: true } })).status).toBe(200);
    expect((await asOwner("POST", "/api/page/grand/move", { body: { parent: "child", confirmShare: true } })).status).toBe(200);
    await asOwner("DELETE", "/api/page/other/access/rules/" + found.rule);
  });

  test("someone without access asks for it, the owner approves or denies, and approval opens the page", async () => {
    const anon = await call("POST", "/s/o/r/root", { form: { email: "Ask@Example.com", role: "edit", note: "please" } });
    expect(anon.status).toBe(200);
    expect((await call("POST", "/s/o/r/no-such-page", { form: { email: "ask@example.com" } })).text).toBe(anon.text);
    await call("POST", "/s/o/r/root", { form: { email: "deny@example.com" } });
    const state = await asOwner("GET", "/api/page/root/access");
    const asked = state.data.requests.find((entry: any) => entry.email === "ask@example.com");
    const denied = state.data.requests.find((entry: any) => entry.email === "deny@example.com");
    expect(asked).toMatchObject({ role: "edit", note: "please" });
    expect((await asOwner("POST", "/api/page/root/access/requests/" + denied.id, { body: { decision: "deny" } })).status).toBe(200);
    const approved = await asOwner("POST", "/api/page/root/access/requests/" + asked.id, { body: { decision: "approve" } });
    expect(approved.status).toBe(200);
    expect(approved.data.invite.code).toMatch(/^\d{6}$/);
    const guest = await verify(approved.data.invite, "ask@example.com");
    expect((await call("PUT", "/api/page/child", { cookie: guest, body: { blocks: [{ id: "c1", type: "paragraph", text: "child body" }] } })).status).toBe(200);
    expect((await asOwner("GET", "/api/page/root/access")).data.requests).toEqual([]);
    const denyGuest = await call("GET", "/root/", { cookie: "acard_guest=o." + "A".repeat(43) });
    expect(denyGuest.status).toBe(401);

    const reader = await invite("child", "reader@example.com");
    const readerCookie = await verify(reader, "reader@example.com");
    expect((await call("POST", "/api/page/child/access/request", { cookie: readerCookie, body: { role: "edit" } })).status).toBe(201);
    const pending = (await asOwner("GET", "/api/page/child/access")).data.requests[0];
    expect(pending).toMatchObject({ email: "reader@example.com", role: "edit" });
    const upgraded = await asOwner("POST", "/api/page/child/access/requests/" + pending.id, { body: { decision: "approve" } });
    expect(upgraded.data.invite).toBeNull();
    expect((await call("PUT", "/api/page/child", { cookie: readerCookie, body: { blocks: [{ id: "c1", type: "paragraph", text: "child body" }] } })).status).toBe(200);
    for (const rule of [approved.data.rule, upgraded.data.rule]) await asOwner("DELETE", "/api/page/" + (rule === approved.data.rule ? "root" : "child") + "/access/rules/" + rule);
  });

  test("publishing makes a public page that unpublishing removes; sub-pages only when chosen", async () => {
    const made = await asOwner("POST", "/api/page/root/access/publish");
    expect(made.status).toBe(201);
    const url = made.data.url as string;
    const page = await call("GET", url);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await call("GET", url + "/child/")).status).toBe(404);
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: true, allowIndex: true, siteTitle: "Acard 사이트" } });
    expect((await call("GET", url + "/child/")).status).toBe(200);
    const indexed = await call("GET", url);
    expect(indexed.headers.get("x-robots-tag")).toBe("index, follow");
    expect(indexed.text).toContain("Acard 사이트");
    expect(indexed.text).toContain('<link rel="canonical" href="https://notes.example.com' + url + '">');
    expect(indexed.text).toContain('<meta property="og:title" content="Shared root">');
    expect(indexed.text).toContain('<meta property="og:url" content="https://notes.example.com' + url + '">');
    expect((await call("GET", url + "/child/?utm_source=x")).text).toContain('<link rel="canonical" href="https://notes.example.com' + url + '/child">');
    expect((await asOwner("GET", "/api/page/root/access")).data.publish.url).toBe(url);
    expect((await asOwner("DELETE", "/api/page/root/access/publish")).status).toBe(200);
    expect((await call("GET", url)).status).toBe(404);
    expect((await call("GET", url + "/child/")).status).toBe(404);
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: false, allowIndex: false, siteTitle: "" } });
  });

  test("#124 [[title]] links on a published page point inside the publish URL; a page outside it stays plain text", async () => {
    const blocks = [{ id: "w1", type: "paragraph", text: "see [[shared child#Part two|the child]] and [[other]]" }];
    const before = (await asOwner("GET", "/api/page/root")).data;
    const base = before.page.updated;
    expect((await asOwner("PUT", "/api/page/root", { body: { blocks, base_updated: base } })).status).toBe(200);
    const url = (await asOwner("POST", "/api/page/root/access/publish")).data.url as string;
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: true, allowIndex: false, siteTitle: "" } });
    const page = await call("GET", url);
    expect(page.text).toContain('href="' + url + '/child/#part-two"');
    expect(page.text).toContain(">the child</a>");
    expect(page.text).not.toContain('href="/other/');
    expect(page.text).not.toContain(url + "/other");
    expect((await asOwner("DELETE", "/api/page/root/access/publish")).status).toBe(200);
    const now = (await asOwner("GET", "/api/page/root")).data.page.updated;
    expect((await asOwner("PUT", "/api/page/root", { body: { blocks: before.blocks, base_updated: now } })).status).toBe(200);
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: false, allowIndex: false, siteTitle: "" } });
  });
  test("#124 a published page with search allowed lists itself and its readable sub-pages in <url>/sitemap.xml; otherwise 404", async () => {
    const made = await asOwner("POST", "/api/page/root/access/publish");
    const url = made.data.url as string;
    expect((await call("GET", url + "/sitemap.xml")).status).toBe(404);
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: false, allowIndex: true, siteTitle: "" } });
    const only = await call("GET", url + "/sitemap.xml");
    expect(only.status).toBe(200);
    expect(only.headers.get("content-type")).toContain("application/xml");
    expect([...only.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(["https://notes.example.com" + url]);
    expect((await call("GET", url)).text).toContain('<link rel="sitemap" type="application/xml" href="' + url + '/sitemap.xml">');
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: true, allowIndex: true, siteTitle: "" } });
    const all = [...(await call("GET", url + "/sitemap.xml")).text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(all).toContain("https://notes.example.com" + url + "/child");
    expect(all.every((loc) => loc.startsWith("https://notes.example.com" + url))).toBe(true);
    const link = await asOwner("POST", "/api/page/root/access/link", { body: { role: "read" } });
    const linkUrl = String(link.data?.link?.url ?? "");
    if (linkUrl) expect((await call("GET", linkUrl + "/sitemap.xml")).status).toBe(404);
    expect((await asOwner("DELETE", "/api/page/root/access/publish")).status).toBe(200);
    expect((await call("GET", url + "/sitemap.xml")).status).toBe(404);
    if (link.data?.link?.id) await asOwner("DELETE", "/api/page/root/access/rules/" + link.data.link.id);
    await asOwner("PUT", "/api/page/root/access/settings", { body: { publishSubpages: false, allowIndex: false, siteTitle: "" } });
  });
  test("#116 the owner's share theme fixes the published page's theme; system keeps the viewer's setting", async () => {
    const url = (await asOwner("POST", "/api/page/root/access/publish")).data.url as string;
    const htmlTag = (text: string) => /<html[^>]*>/.exec(text)![0];
    expect(htmlTag((await call("GET", url, { cookie: "acard_lang=ko" })).text)).toBe('<html lang="ko">');
    expect((await asOwner("GET", "/api/page/root/access")).data.settings.theme).toBe("system");
    expect((await asOwner("PUT", "/api/page/root/access/settings", { body: { theme: "sepia" } })).status).toBe(400);
    expect((await asOwner("PUT", "/api/page/root/access/settings", { body: { theme: "dark" } })).status).toBe(200);
    const dark = (await call("GET", url, { cookie: "acard_lang=ko" })).text;
    expect(htmlTag(dark)).toBe('<html lang="ko" data-theme="dark">');
    expect(dark).toContain('<meta name="color-scheme" content="dark">');
    // The viewer's toggle still switches a fixed dark page to light.
    expect(dark).toContain('html[data-theme="dark"]:has(#sv-tt:checked):not(#sv-none){color-scheme:light;');
    expect((await asOwner("GET", "/api/page/root/access")).data.settings.theme).toBe("dark");
    // Another setting leaves the theme alone.
    await asOwner("PUT", "/api/page/root/access/settings", { body: { siteTitle: "" } });
    expect(htmlTag((await call("GET", url, { cookie: "acard_lang=ko" })).text)).toBe('<html lang="ko" data-theme="dark">');
    await asOwner("PUT", "/api/page/root/access/settings", { body: { theme: "light" } });
    expect(htmlTag((await call("GET", url, { cookie: "acard_lang=ko" })).text)).toBe('<html lang="ko" data-theme="light">');
    await asOwner("PUT", "/api/page/root/access/settings", { body: { theme: "system" } });
    expect(htmlTag((await call("GET", url, { cookie: "acard_lang=ko" })).text)).toBe('<html lang="ko">');
    expect((await asOwner("DELETE", "/api/page/root/access/publish")).status).toBe(200);
  });

  test("shared subpage cards strip inline markdown, escape and truncate plain text, and fetch one paragraph per page", async () => {
    for (const [slug, parent] of [["cards-root", null], ["cards-a", "cards-root"], ["cards-b", "cards-root"], ["cards-empty", "cards-root"]]) {
      expect((await asOwner("POST", "/api/pages", { body: { slug, title: slug, parent } })).status).toBe(200);
    }
    const markdown = "**bold**, *italic*, _under_, `code`, [link](https://notes.example.com), [[slug]] snake_case_name a*b <tag> & " + "x".repeat(80);
    const plain = "bold, italic, under, code, link, slug snake_case_name a*b <tag> & " + "x".repeat(80);
    const insert = owner.query("INSERT INTO blocks (page, id, ord, type, text, checked, indent) VALUES (?, ?, ?, ?, ?, 0, 0)");
    for (const slug of ["cards-a", "cards-b"]) {
      insert.run(slug, "heading", 0, "heading1", "Not a paragraph");
      insert.run(slug, "blank", 1, "paragraph", "   ");
      // Insertion order differs from ord, so selecting the first stored row is wrong.
      for (let i = 0; i < 20; i++) insert.run(slug, "later" + i, 10 + i, "paragraph", "Later paragraph " + i);
      insert.run(slug, "first", 2, "paragraph", slug === "cards-a" ? markdown : "Second page summary");
    }
    await asOwner("PUT", "/api/page/cards-root/access/settings", { body: { publishSubpages: true } });
    const published = await asOwner("POST", "/api/page/cards-root/access/publish");
    expect(published.status).toBe(201);
    const db = env.DB;
    const queries: { sql: string; params: unknown[]; rows: { page: string; text: string }[] }[] = [];
    env.DB = { ...db, prepare(sql: string) {
      const wrap = (statement: any, params: unknown[]): any => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values), values),
        all: async () => {
          const result = await statement.all();
          if (/FROM blocks\b/.test(sql) && sql.includes("paragraph")) queries.push({ sql, params, rows: result.results });
          return result;
        },
      });
      return wrap(db.prepare(sql), []);
    } };
    let rendered;
    try { rendered = await call("GET", published.data.url); } finally { env.DB = db; }
    expect(rendered.status).toBe(200);
    const summaries = [...rendered.text.matchAll(/<small>(.*?)<\/small>/g)].map(match => match[1]);
    expect(queries).toHaveLength(1);
    // Execute the exact production query through pgD1 as well, not a SQL-string mock.
    const lite = new PGlite();
    try {
      await lite.exec("CREATE TABLE blocks (page TEXT, id TEXT, ord BIGINT, type TEXT, text TEXT)");
      const pg = pgD1({ query: async (sql, params) => {
        const result = await lite.query<Record<string, unknown>>(sql, params);
        return { rows: result.rows, count: result.affectedRows ?? result.rows.length };
      }, transaction: async () => { throw new Error("Summary reads do not use transactions"); } });
      const rows = owner.query("SELECT page, id, ord, type, text FROM blocks WHERE page LIKE 'cards-%'").all() as { page: string; id: string; ord: number; type: string; text: string }[];
      for (const row of rows) await pg.prepare("INSERT INTO blocks VALUES (?, ?, ?, ?, ?)").bind(row.page, row.id, row.ord, row.type, row.text).run();
      const result = await pg.prepare(queries[0].sql).bind(...queries[0].params).all();
      const expectedRows = [{ page: "cards-a", text: markdown }, { page: "cards-b", text: "Second page summary" }];
      expect({ summaries, sqliteRows: queries[0].rows, postgresRows: result.results }).toEqual({
        summaries: [plain.slice(0, 70).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "Second page summary"],
        sqliteRows: expectedRows, postgresRows: expectedRows,
      });
    } finally { await lite.close(); }
  }, 20000);

  test("a permanently deleted page takes its sharing rules and requests with it", async () => {
    const first = await asOwner("POST", "/api/pages", { body: { title: "Temp", slug: "temp-share" } });
    expect(first.data.slug).toBe("temp-share");
    const found = await invite("temp-share", "temp@example.com");
    const guest = await verify(found, "temp@example.com");
    expect((await call("GET", "/api/page/temp-share", { cookie: guest })).status).toBe(200);
    expect((await asOwner("DELETE", "/api/page/temp-share")).status).toBe(200);
    expect((await asOwner("DELETE", "/api/page/temp-share/permanent")).status).toBe(200);
    expect(owner.query("SELECT count(*) AS n FROM share_rules WHERE page = 'temp-share'").get()).toEqual({ n: 0 });
    expect(owner.query("SELECT count(*) AS n FROM share_requests WHERE page = 'temp-share'").get()).toEqual({ n: 0 });
    expect((await call("GET", "/api/page/temp-share", { cookie: guest })).status).toBe(401);
    expect((await call("GET", "/api/tree", { cookie: guest })).data.pages).toEqual([]);
  });

  test("robots.txt, sitemap.xml and the share image are public; signed-in paths stay behind the gate", async () => {
    const robots = await call("GET", "/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.text).toContain("Sitemap: https://notes.example.com/sitemap.xml");
    const sitemap = await call("GET", "/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    for (const path of ["/og.png", "/apple-touch-icon.png", "/favicon.ico"]) expect((await call("GET", path)).status, path).toBe(404);
    expect((await call("GET", "/api/tree")).status).toBe(401);
  });

  test("state changes from another origin are refused", async () => {
    expect((await asOwner("PUT", "/api/page/root/access/general", { origin: "https://evil.test", body: { mode: "link" } })).status).toBe(403);
    expect((await asOwner("PUT", "/api/page/root", { origin: "https://evil.test", body: { blocks: [] } })).status).toBe(403);
  });

  // Invite mail is not wired yet, so codes are handed over by hand and last 24 hours (owner call 2026-10-20).
  test("invite codes last 24 hours: a 23-hour-old code still opens the page", async () => {
    const found = await invite("root", "day@example.com");
    const row = owner.query("SELECT created, expires FROM share_invites WHERE rule = ? AND used IS NULL").get(found.rule) as { created: number; expires: number };
    expect(row.expires - row.created).toBe(24 * 60 * 60 * 1000);
    owner.query("UPDATE share_invites SET created = created - ?, expires = expires - ? WHERE rule = ? AND used IS NULL").run(23 * 3600e3, 23 * 3600e3, found.rule);
    expect((await call("POST", found.url, { form: { email: "day@example.com", code: found.code } })).status).toBe(303);
    await asOwner("DELETE", "/api/page/root/access/rules/" + found.rule);
  });

  test("invite codes stop after five wrong tries and refuse once expired", async () => {
    const found = await invite("root", "tries@example.com");
    for (let i = 0; i < 5; i += 1) expect((await call("POST", found.url, { form: { email: "tries@example.com", code: "x" } })).status).toBe(401);
    expect((await call("POST", found.url, { form: { email: "tries@example.com", code: found.code } })).status).toBe(401);
    const late = await asOwner("POST", "/api/page/root/access/rules/" + found.rule + "/code");
    owner.query("UPDATE share_invites SET expires = 1 WHERE used IS NULL").run();
    expect((await call("POST", late.data.url, { form: { email: "tries@example.com", code: late.data.code } })).status).toBe(401);
    await asOwner("DELETE", "/api/page/root/access/rules/" + found.rule);
  });

  // A permanent delete keeps a tombstone; these test pages never existed for the rest of the file.
  async function dropPage(slug: string) {
    await asOwner("DELETE", "/api/page/" + slug);
    expect((await asOwner("DELETE", "/api/page/" + slug + "/permanent")).status).toBe(200);
    owner.query("DELETE FROM editor_trash WHERE page = ?").run(slug);
  }

  // #114: a visitor with an edit link and no account used to see only a read-only page. The link page now offers an email
  // check (mailed 6-digit code, no sign-up) that opens a guest session holding that link.
  test("an edit link visitor confirms an email code and then edits text, blocks, cells, rows and checkboxes (#114)", async () => {
    const mails: { to: string[]; text: string }[] = [];
    const before = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input instanceof Request ? input.url : input) === "https://api.resend.com/emails") { mails.push(JSON.parse(init.body)); return Response.json({ id: "m1" }); }
      return before(input, init);
    }) as typeof fetch;
    env.RESEND_API_KEY = "re_test";
    // The per-IP verify limit belongs to the invite tests; this test leaves it as it found it (like sweepVerify).
    const savedRate = owner.query("SELECT key, count, reset FROM share_rate").all();
    owner.query("DELETE FROM share_rate").run();
    try {
      const page = (await asOwner("POST", "/api/pages", { body: { title: "Edit link", slug: "e114", parent: null } })).data.slug;
      expect((await asOwner("PUT", "/api/page/" + page, { body: { blocks: [{ id: "t1", type: "paragraph", text: "before" }] } })).status).toBe(200);
      const dbSlug = (await asOwner("POST", "/api/db", { body: { title: "Tasks", slug: "e114-db", parent: page, page: true } })).data.slug;
      const title = (await asOwner("GET", "/api/db/" + dbSlug)).data.properties.find((p: any) => p.type === "title").id;
      const flag = (await asOwner("POST", "/api/db/" + dbSlug + "/properties", { body: { name: "Done", type: "checkbox" } })).data.property.id;
      const row = (await asOwner("POST", "/api/db/" + dbSlug + "/rows", { body: { props: { [title]: "row one" } } })).data.row;
      const url = (await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "edit" } })).data.link.url as string;
      const token = url.split("/").pop()!;

      const shown = await call("GET", url, { cookie: "acard_lang=ko" });
      expect(shown.status).toBe(200);
      expect(shown.text).toContain("편집 허용");
      expect(shown.text).toContain('href="/s/o/l/' + token + '"');
      expect((await call("PUT", "/api/page/" + page, { body: { blocks: [] } })).status).toBe(401);

      expect((await call("GET", "/s/o/l/" + token, { cookie: "acard_lang=ko" })).text).toContain("코드 받기");
      expect((await call("GET", "/s/o/l/" + token)).text).toContain("Get code");
      expect((await call("POST", "/s/o/l/" + token, { form: { email: "not-an-email" } })).status).toBe(400);
      const asked = await call("POST", "/s/o/l/" + token, { form: { email: "Seymour@Example.com" } });
      expect(asked.status).toBe(200);
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toEqual(["seymour@example.com"]);
      // The code mail is in the visitor's language (English here: no Korean browser, no acard_lang).
      expect(mails[0].subject).toMatch(/^Acard verification code \d{6}$/);
      const code = /\b(\d{6})\b/.exec(mails[0].text)![1];
      expect(asked.text).not.toContain(code);
      const verifyUrl = /action="(\/s\/o\/i\/[A-Za-z0-9_-]{43})"/.exec(asked.text)![1];
      expect((await call("POST", verifyUrl, { form: { email: "other@example.com", code } })).status).toBe(401);
      const done = await call("POST", verifyUrl, { form: { email: "seymour@example.com", code } });
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe("/edit/" + page + "/");
      const guest = "acard_guest=" + /acard_guest=([^;]+)/.exec(done.headers.get("set-cookie")!)![1];

      expect((await call("GET", "/edit/" + page + "/", { cookie: guest })).status).toBe(200);
      expect((await call("PUT", "/api/page/" + page, { cookie: guest, body: { blocks: [{ id: "t1", type: "paragraph", text: "typed by link guest" }] } })).status).toBe(200);
      const current = (await call("GET", "/api/page/" + page, { cookie: guest })).data;
      const order = [...current.blocks.map((b: any) => b.id), "t2"];
      expect((await call("PATCH", "/api/page/" + page + "/blocks", { cookie: guest, body: { base_updated: current.page.updated, upserts: [{ id: "t2", type: "paragraph", text: "new block", ord: order.length - 1 }], deletes: [], order } })).status).toBe(200);
      expect((await call("PATCH", "/api/db/" + dbSlug + "/rows/" + row.id, { cookie: guest, body: { props: { [title]: "cell by link guest" } } })).status).toBe(200);
      expect((await call("PATCH", "/api/db/" + dbSlug + "/rows/" + row.id, { cookie: guest, body: { props: { [flag]: true } } })).status).toBe(200);
      expect((await call("POST", "/api/db/" + dbSlug + "/rows", { cookie: guest, body: { props: { [title]: "row by link guest" } } })).status).toBe(200);
      expect((await asOwner("GET", "/api/page/" + page)).data.blocks.map((b: any) => b.text)).toEqual(["typed by link guest", "new block"]);
      const rows = (await asOwner("GET", "/api/db/" + dbSlug)).data.rows;
      expect(rows.map((r: any) => r.pageTitle).sort()).toEqual(["cell by link guest", "row by link guest"]);
      expect(rows.find((r: any) => r.id === row.id).props[flag]).toBe(true);
      // The link grants this page only: other pages stay closed.
      expect((await call("PUT", "/api/page/other", { cookie: guest, body: { blocks: [] } })).status).toBe(401);

      // Lowering the link to read takes edit away from that session at once.
      expect((await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "read" } })).status).toBe(200);
      expect((await call("PUT", "/api/page/" + page, { cookie: guest, body: { blocks: [] } })).status).toBe(401);
      await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "invited" } });
      await asOwner("DELETE", "/api/db/" + dbSlug);
      await dropPage(page);
      owner.query("DELETE FROM editor_trash WHERE page = ?").run(dbSlug);
    } finally {
      globalThis.fetch = before;
      delete env.RESEND_API_KEY;
      owner.query("DELETE FROM share_rate").run();
      for (const row of savedRate as any[]) owner.query("INSERT INTO share_rate (key, count, reset) VALUES (?, ?, ?)").run(row.key, row.count, row.reset);
    }
  });

  test("overlapping code requests for one email send at most three mails (#114 gate review)", async () => {
    const savedRate = owner.query("SELECT key, count, reset FROM share_rate").all();
    owner.query("DELETE FROM share_rate").run();
    let mails = 0;
    const before = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => String(input instanceof Request ? input.url : input) === "https://api.resend.com/emails" ? (mails += 1, Response.json({ id: "m" })) : before(input, init)) as typeof fetch;
    env.RESEND_API_KEY = "re_test";
    const page = (await asOwner("POST", "/api/pages", { body: { title: "Burst", slug: "b114", parent: null } })).data.slug;
    try {
      const token = ((await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "edit" } })).data.link.url as string).split("/").pop();
      slowReads = true;
      const answers = await Promise.all(Array.from({ length: 12 }, () => call("POST", "/s/o/l/" + token, { form: { email: "burst@example.com" } }))).finally(() => { slowReads = false; });
      expect(answers.filter((r) => r.status === 200)).toHaveLength(3);
      expect(answers.filter((r) => r.status === 429)).toHaveLength(9);
      expect(mails).toBe(3);
    } finally {
      globalThis.fetch = before;
      delete env.RESEND_API_KEY;
      await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "invited" } });
      await dropPage(page);
      owner.query("DELETE FROM share_rate").run();
      for (const row of savedRate as any[]) owner.query("INSERT INTO share_rate (key, count, reset) VALUES (?, ?, ?)").run(row.key, row.count, row.reset);
    }
  });

  test("a read link offers no email step and its visitors write nothing (#114)", async () => {
    const savedRate = owner.query("SELECT key, count, reset FROM share_rate").all();
    owner.query("DELETE FROM share_rate").run();
    const page = (await asOwner("POST", "/api/pages", { body: { title: "Read link", slug: "r114", parent: null } })).data.slug;
    expect((await asOwner("PUT", "/api/page/" + page, { body: { blocks: [{ id: "t1", type: "paragraph", text: "keep" }] } })).status).toBe(200);
    const url = (await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "read" } })).data.link.url as string;
    const token = url.split("/").pop()!;
    const shown = await call("GET", url, { cookie: "acard_lang=ko" });
    expect(shown.text).toContain("읽기 전용");
    expect(shown.text).not.toContain("/s/o/l/");
    // The read link offers the owner-approved edit request instead (Discord follow-up to 114).
    expect(shown.text).toContain('href="/s/o/r/' + page + '?role=edit">편집 권한 요청</a>');
    const askEdit = await call("GET", "/s/o/r/" + page + "?role=edit", { cookie: "acard_lang=ko" });
    expect(askEdit.status).toBe(200);
    expect(askEdit.text).toContain('<option value="edit" selected>편집 허용</option>');
    const askPlain = await call("GET", "/s/o/r/" + page, { cookie: "acard_lang=ko" });
    expect(askPlain.text).toContain('<option value="edit">편집 허용</option>');
    expect(askPlain.text).not.toContain(" selected");
    const badEmail = await call("POST", "/s/o/r/" + page, { cookie: "acard_lang=ko", form: { email: "nope", role: "edit" } });
    expect(badEmail.status).toBe(400);
    expect(badEmail.text).toContain('<option value="edit" selected>편집 허용</option>');
    // The same page and form read in English for a reader without a Korean choice or browser (owner, slack C0C91GZDVC7
    // 1792921459.431739: English example pages opened from X showed the request-edit flow in Korean).
    const enPage = await call("GET", url);
    expect(enPage.text).toContain('?role=edit">Request edit access</a>');
    const askEn = await call("GET", "/s/o/r/" + page + "?role=edit");
    expect(askEn.text).toContain('<html lang="en">');
    expect(askEn.text).toContain('<option value="edit" selected>Can edit</option>');
    expect(askEn.text).not.toMatch(/[\uac00-\ud7a3]/);
    const badEn = await call("POST", "/s/o/r/" + page, { form: { email: "nope", role: "edit" } });
    expect(badEn.text).toContain("Please check the email address.");
    const snapshot = () => JSON.stringify([owner.query("SELECT * FROM blocks WHERE page = ?").all(page), owner.query("SELECT count(*) AS n FROM share_invites").get(), owner.query("SELECT count(*) AS n FROM share_sessions").get()]);
    const before = snapshot();
    expect((await call("GET", "/s/o/l/" + token)).status).toBe(404);
    expect((await call("POST", "/s/o/l/" + token, { form: { email: "r@example.com" } })).status).toBe(404);
    expect((await call("PUT", "/api/page/" + page, { body: { blocks: [] } })).status).toBe(401);
    expect(snapshot()).toBe(before);
    // An edit link turned back to read refuses a code that was asked for while it allowed editing.
    const mails: { text: string }[] = [];
    const realFetchNow = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => String(input instanceof Request ? input.url : input) === "https://api.resend.com/emails" ? (mails.push(JSON.parse(init.body)), Response.json({ id: "m" })) : realFetchNow(input, init)) as typeof fetch;
    env.RESEND_API_KEY = "re_test";
    try {
      await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "edit" } });
      const asked = await call("POST", "/s/o/l/" + token, { form: { email: "late@example.com" } });
      const verifyUrl = /action="(\/s\/o\/i\/[A-Za-z0-9_-]{43})"/.exec(asked.text)![1];
      await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "read" } });
      expect((await call("POST", verifyUrl, { form: { email: "late@example.com", code: /\b(\d{6})\b/.exec(mails[0].text)![1] } })).status).toBe(401);
    } finally {
      globalThis.fetch = realFetchNow;
      delete env.RESEND_API_KEY;
    }
    // Without a mail key no code is made and the visitor is told so.
    await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "link", role: "edit" } });
    const pending = owner.query("SELECT count(*) AS n FROM share_invites WHERE email = 'nomail@example.com' AND used IS NULL").get();
    expect((await call("POST", "/s/o/l/" + token, { form: { email: "nomail@example.com" } })).status).toBe(503);
    expect(owner.query("SELECT count(*) AS n FROM share_invites WHERE email = 'nomail@example.com' AND used IS NULL").get()).toEqual(pending);
    await asOwner("PUT", "/api/page/" + page + "/access/general", { body: { mode: "invited" } });
    await dropPage(page);
    owner.query("DELETE FROM share_rate").run();
    for (const row of savedRate as any[]) owner.query("INSERT INTO share_rate (key, count, reset) VALUES (?, ?, ?)").run(row.key, row.count, row.reset);
  });

  // Every route the worker knows must sit behind the resolver: a guest that may read only "root" sends every method
  // to every route aimed at "other" and must never get its content or change it.
  test("no route lets a guest reach a page it was not given", async () => {
    const worker = (await readFile(join(ROOT, "gate/_worker.js"), "utf8")).replace(/\r\n/g, "\n");
    const handleApi = worker.slice(worker.indexOf("async function handleApi"));
    const sources = [handleApi, ...(await Promise.all(["editor-pages.js", ...(await Array.fromAsync(new Bun.Glob("features/*.js").scan({ cwd: ROOT })))].map((file) => readFile(join(ROOT, file), "utf8"))))];
    const literals = new Set<string>();
    const patterns: RegExp[] = [];
    for (const [i, source] of sources.entries()) {
      for (const match of source.matchAll(/path [!=]== "(\/[^"]*)"(?! \+)/g)) literals.add(i === 0 && !match[1].startsWith("/api") ? "/api" + match[1] : match[1]);
      for (const match of source.matchAll(/(\/\^\\\/[^\n]*?\$\/)\.exec\((?:path|url\.pathname)\)/g)) {
        const re = new Function("return " + match[1])() as RegExp;
        patterns.push(i === 0 && !re.source.startsWith("^\\/api") ? new RegExp("^\\/api" + re.source.slice(1)) : re);
      }
    }
    const samples = [
      "/import", "/import/",
      "/api/sync", "/api/upload", "/api/media-usage", "/api/media/" + OTHER_MEDIA, "/api/link-preview?url=https://x.test", "/api/media/import", "/api/page/other/attachments", "/api/import", "/api/import/md", "/api/import/batches", "/api/import/batches/impx0001", "/api/import/batches/impx0001/chunk", "/api/export?slug=other",
      "/api/export?scope=all", "/api/tree", "/api/search?q=zebra", "/api/backlinks?slug=other", "/api/pages", "/api/page/other", "/api/page/other/rename",
      "/api/page/other/move", "/api/page/other/blocks", "/api/page/other/move-blocks", "/api/page/other/settings", "/api/page/other/comments", "/api/page/other/comments/oc",
      "/api/page/other/synced", "/api/page/other/synced/instance", "/api/page/other/synced/instance/detach",
      "/api/page/other/history", "/api/page/other/history/h1/restore", "/api/page/other/trash", "/api/page/other/restore", "/api/page/other/permanent",
      "/api/page/other/duplicate", "/api/page/other/from-template", "/api/page/other/share", "/api/page/other/share/" + "a".repeat(64), "/api/page/other/access",
      "/api/page/other/access/general", "/api/page/other/access/settings", "/api/page/other/access/publish", "/api/page/other/access/agents",
      "/api/page/other/access/rules/r1", "/api/page/other/access/requests/" + "a".repeat(32), "/api/editor/trash", "/api/editor/trash/empty", "/api/editor/templates", "/api/db", "/api/db/list",
      "/api/db/other", "/api/db/other/rows", "/api/db/other/rows/r1", "/api/db/other/properties", "/api/db/other/views", "/api/db/other/templates",
      "/api/db/other/rules", "/api/db/other/rules/x", "/api/db/other/form", "/api/forms/f1", "/api/forms/f1/submit", "/api/templates", "/api/templates/welcome",
      "/api/ai/polish", "/api/ai/write", "/api/ai/ask", "/api/quick-note", "/api/home/starter", "/api/home/summary", "/api/first-run", "/api/projects", "/api/projects/settings", "/api/projects/backfill", "/api/projects/other/drafts", "/api/projects/other/drafts/apply", "/api/v1/memo", "/api/v1/pages/other/blocks", "/api/v1/agent-skills", "/api/v1/media", "/form/f1",
      "/api/agent", "/api/agent/status", "/api/agent/chat", "/api/agent/sessions", "/api/agent/chat/other", "/api/agent/pages/other/sessions",
      "/api/agent/pages/other/rule", "/api/agent/sessions/s1/step", "/api/agent/suggestions/g1/accept",
      "/api/agent/warm", "/api/agent/latency", "/api/agent/chat-suggestions/g1/apply",
      "/api/journal/sessions", "/api/journal/sessions/j1", "/api/journal/memory/x", "/api/journal/digest", "/api/journal/agents",
      "/api/folders/tree", "/api/folders/prefs", "/api/folders/view", "/api/folders/undo", "/api/folders/activity", "/api/folders/bulk", "/api/folders/suggest", "/api/folders/suggest/apply",
      "/api/parts", "/api/parts/kit", "/api/parts/kit/share", "/api/parts/themes", "/api/parts/themes/kit", "/api/parts/themes/kit/share", "/p/" + "A".repeat(43) + "/acard-part.json", "/api/tags", "/api/tags/merge", "/api/tags/x", "/api/tags/x/pages", "/api/page/other/tags", "/api/v1/folders/tags", "/api/v1/folders/move",
      "/api/page-view/migrate", "/api/page-view/undo", "/api/v1/page-view/migrate", "/api/v1/pages/other/view", "/api/page/other/view",
      "/api/v1/journal/start", "/api/v1/journal/log", "/api/v1/journal/end", "/api/v1/journal/memory", "/api/v1/journal/visual", "/api/v1/doc-guides/split", "/api/v1/components", "/api/v1/components/stat",
      "/api/guide", 
      "/other/", "/edit/other/", "/print/other/", "/media/" + OTHER_MEDIA, "/api/media/" + OTHER_MEDIA + "/meta", "/p/" + "A".repeat(43), "/p/" + "A".repeat(43) + "/sitemap.xml", "/api/graph", "/api/graph?around=other&depth=2", "/graph", "/graph/", "/s/i/" + "A".repeat(43), "/s/l/" + "A".repeat(43), "/s/logout", "/s/r/other",
    ];
    const uncovered = [...[...literals].filter((path) => !samples.some((sample) => sample.split("?")[0] === path)), ...patterns.filter((re) => !samples.some((sample) => re.test(sample.split("?")[0]))).map(String)];
    expect(uncovered).toEqual([]);

    const found = await invite("root", "routes@example.com", "full");
    const guest = await verify(found, "routes@example.com");
    const before = JSON.stringify(owner.query("SELECT * FROM pages WHERE slug = 'other' UNION ALL SELECT page, id, text, ord, type, checked, indent, meta FROM blocks WHERE page = 'other'").all());
    const pages = owner.query("SELECT count(*) AS n FROM pages").get();
    for (const sample of samples) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const res = await call(method, sample, { cookie: guest, body: method === "GET" ? undefined : { parent: "other", slug: "other", title: "x", blocks: [], email: "a@b.dev", mode: "link", text: "x" } });
        expect({ sample, method, leak: res.text.includes(SECRET_TEXT) }).toEqual({ sample, method, leak: false });
        if (!["/api/tree", "/api/search?q=zebra", "/api/db/list", "/s/logout", "/s/r/other"].includes(sample) && !sample.startsWith("/api/v1/") && !sample.startsWith("/p/") && !sample.startsWith("/s/")) {
          expect({ sample, method, ok: res.status < 300 }).toEqual({ sample, method, ok: false });
        }
      }
    }
    expect(JSON.stringify(owner.query("SELECT * FROM pages WHERE slug = 'other' UNION ALL SELECT page, id, text, ord, type, checked, indent, meta FROM blocks WHERE page = 'other'").all())).toBe(before);
    expect(owner.query("SELECT count(*) AS n FROM pages").get()).toEqual(pages);
    expect(owner.query("SELECT count(*) AS n FROM editor_trash WHERE page != 'temp-share'").get()).toEqual({ n: 0 });
    await asOwner("DELETE", "/api/page/root/access/rules/" + found.rule);
  });
});
