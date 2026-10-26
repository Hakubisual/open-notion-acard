import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleWorkerSource } from "./assemble-worker";

class FakeDurableObject {
  ctx: any;
  env: any;
  constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
}
class FakeWorkerEntrypoint { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } }
mock.module("cloudflare:workers", () => ({ DurableObject: FakeDurableObject, WorkerEntrypoint: FakeWorkerEntrypoint }));

const SUPABASE = "https://supa.test";
const OWNER_UID = "00000000-0000-4000-8000-000000000001";
const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";
const hex = (uid: string) => uid.replace(/-/g, "");

function d1(sqlite: Database) {
  const statement = (sql: string, params: unknown[] = []): any => ({
    sql, params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({ success: true, meta: { changes: sqlite.query(sql).run(...(params as any[])).changes } }),
    all: async () => ({ results: sqlite.query(sql).all(...(params as any[])) }),
    first: async () => sqlite.query(sql).get(...(params as any[])) ?? null,
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

function sqlStorage(sqlite: Database) {
  return {
    sql: {
      exec: (sql: string, ...params: unknown[]) => {
        const rows = sqlite.query(sql).all(...(params as any[])) as any[];
        return { toArray: () => rows, one: () => rows[0] };
      },
      get databaseSize() { return 0; },
    },
    transactionSync: (fn: () => unknown) => sqlite.transaction(fn)(),
    deleteAll: async () => {
      const tables = sqlite.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%'").all() as any[];
      for (const t of tables.filter((x) => x.type === "trigger")) sqlite.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      for (const t of tables.filter((x) => x.type === "table")) { try { sqlite.exec(`DROP TABLE IF EXISTS "${t.name}"`); } catch { continue; } }
    },
  };
}

function memoryKv() {
  const map = new Map<string, { value: unknown; metadata: unknown }>();
  return {
    map,
    get: async (key: string) => map.get(key)?.value ?? null,
    getWithMetadata: async (key: string) => map.get(key) ?? { value: null, metadata: null },
    put: async (key: string, value: unknown, options?: any) => { map.set(key, { value, metadata: options?.metadata ?? null }); },
    delete: async (key: string) => { map.delete(key); },
    list: async (options: { prefix?: string } = {}) => ({ keys: [...map.keys()].filter((k) => k.startsWith(options.prefix ?? "")).map((name) => ({ name })), list_complete: true }),
  };
}

let worker: any;
let env: any;
let owner: Database;
let stores: Map<string, any>;
let keyPair: CryptoKeyPair;
let dir: string;
const realFetch = globalThis.fetch;

const b64url = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

async function jwt(sub: string, { exp = Math.floor(Date.now() / 1000) + 600, key = keyPair.privateKey, iss = SUPABASE + "/auth/v1" } = {}) {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ sub, email: sub.slice(0, 4) + "@test.dev", exp, iss, aud: "authenticated", role: "authenticated" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(sig);
}

async function call(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown; host?: string } = {}) {
  const headers: Record<string, string> = { accept: "text/html,application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = "Bearer " + opts.bearer;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res: Response = await worker.fetch(new Request("https://" + (opts.host ?? "notes.example.com") + path, { method, headers, redirect: "manual", body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), env, {});
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers };
}

const as = async (uid: string) => "acard_at=" + (await jwt(uid));

beforeAll(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "acard-tenancy-"));
  const core = join(dir, "acard-core.js");
  await writeFile(core, "const __mod = (function () {\n" + assembleWorkerSource() + "\n})();\nexport default __mod;\nexport const acardHost = __mod.acardHost;\n");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "gate", "agent-entry.ts")],
    format: "esm", target: "browser", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers"],
    plugins: [{ name: "core", setup(build) { build.onResolve({ filter: /[\\/]acard-core\.js$/ }, () => ({ path: core })); } }],
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const out = join(dir, "worker.mjs");
  await writeFile(out, await built.outputs[0].text());
  worker = (await import(out)).default;
  const { WorkspaceStore } = await import("../workers/acard-workspace/index.js");

  keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SUPABASE + "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
    if (url.startsWith(SUPABASE + "/rest/v1/profiles")) return Response.json([{ id: "x", display_name: "t", avatar_url: null, handle: "t", use_case: null, onboarded_at: "2026-10-16T00:00:00Z" }]);
    if (url.startsWith(SUPABASE)) return Response.json({}, { status: 401 });
    return realFetch(input, init);
  }) as typeof fetch;

  owner = new Database(":memory:");
  stores = new Map();
  const assets: Record<string, string> = {
    "/_site/index.html": "<html>LANDING notes.example.com</html>",
    "/_site/login.html": "<html>LOGIN</html>",
    "/_site/settings.html": "<html>SETTINGS</html>",
    "/_site/desktop-wait.html": "<html>DESKTOP WAIT</html>",
    "/_site/desktop-start.html": "<html>DESKTOP START</html>",
    "/_site/desktop-tour.html": "<html>DESKTOP TOUR</html>",
    "/notes-seed.json": JSON.stringify({ pages: [{ slug: "owner-secret", title: "Owner Secret", parent: null, ord: 1, kind: "note", updated: 1, hash: "h1", blocks: [{ id: "b1", type: "paragraph", text: "zebra owner confidential", indent: 0 }] }] }),
    "/search-index.json": "[{\"t\":\"Owner Secret\"}]",
    "/owner-secret/index.html": "<html>OWNER STATIC zebra</html>",
    "/editor.html": "<html>EDITOR</html>",
    "/style.css": "body{}",
  };
  env = {
    DB: d1(owner),
    MEDIA: memoryKv(),
    OAUTH_KV: undefined,
    GATE_PASSWORD: "pw", GATE_SECRET: "secret",
    OWNER_USER_ID: OWNER_UID,
    SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: "anon",
    ASSETS: { fetch: async (request: Request) => {
      const raw = new URL(request.url).pathname;
      const path = raw.endsWith("/") && raw !== "/" ? raw + "index.html" : raw;
      const body = assets[path];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "application/json", etag: "e1" } });
    } },
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!stores.has(id)) stores.set(id, new WorkspaceStore({ storage: sqlStorage(new Database(":memory:")) }, {}));
        return stores.get(id);
      },
    },
  };
  await env.MEDIA.put("media/aaaaaaaaaaaaaaaa", new Uint8Array([1, 2, 3]).buffer, { metadata: { mime: "image/png", name: "o.png" } });
  const ownerTree = await call("GET", "/api/tree", { cookie: await as(OWNER_UID) });
  expect(ownerTree.status).toBe(200);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("one site, many workspaces", () => {
  test("the exported fetch boundary secures HTML, redirects, APIs and early returns", async () => {
    const cookie = await as(OWNER_UID);
    for (const [path, who] of [["/", undefined], ["/login", undefined], ["/edit/owner-secret", cookie], ["/?sw=off", undefined], ["/api/tree", undefined], ["/mcp", undefined], ["/sse", undefined], ["/connect", undefined]]) {
      const response = await call("GET", path!, { cookie: who });
      expect([path, response.headers.get("x-content-type-options"), response.headers.get("referrer-policy"), response.headers.get("strict-transport-security")]).toEqual([path, "nosniff", "no-referrer", "max-age=31536000; includeSubDomains"]);
      if (response.headers.get("content-type")?.startsWith("text/html")) {
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      }
    }
  });

  // #88 follow-up (lead check): the worker's own early 400s for undecodable paths go through the same finalizer.
  // A path with an invalid percent escape (%ZZ) is refused by Cloudflare's edge before the Worker runs, so the
  // reachable cases are well-formed escapes that are not UTF-8.
  test("undecodable paths get a 400 with the security headers, never a 500 (#88)", async () => {
    const cookie = await as(OWNER_UID);
    for (const path of ["/print/%E0%A4%A", "/print/%C3%28/", "/api/page/%E0%A4%A", "/api/db/%E0%A4%A"]) {
      const response = await call("GET", path, { cookie });
      expect([path, response.status]).toEqual([path, 400]);
      expect([path, response.headers.get("x-content-type-options"), response.headers.get("referrer-policy"), response.headers.get("strict-transport-security")])
        .toEqual([path, "nosniff", "no-referrer", "max-age=31536000; includeSubDomains"]);
      if (response.headers.get("content-type")?.startsWith("text/html")) expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  test("response finalization preserves route policies and immutable headers", async () => {
    const previous = env.ASSETS;
    try {
      for (const [csp, frame, expectedCsp, expectedFrame] of [
        ["default-src 'none'", null, "default-src 'none'; frame-ancestors 'none'", "DENY"],
        ["frame-ancestors 'self'", null, "frame-ancestors 'self'", null],
        ["style-src 'self'", "SAMEORIGIN", "style-src 'self'", "SAMEORIGIN"],
        ["frame-ancestors 'none'", "DENY", "frame-ancestors 'none'", "DENY"],
      ]) {
        env.ASSETS = { fetch: async () => new Response("<html>frame</html>", { headers: {
          "content-type": "text/html", "content-security-policy": csp!, "referrer-policy": "same-origin", "strict-transport-security": "max-age=60", "x-content-type-options": "nosniff", ...(frame ? { "x-frame-options": frame } : {}),
        } }) };
        const response = await call("GET", "/frame.js");
        expect(response.headers.get("content-security-policy")).toBe(expectedCsp);
        expect(response.headers.get("x-frame-options")).toBe(expectedFrame);
        expect(response.headers.get("referrer-policy")).toBe("same-origin");
        expect(response.headers.get("strict-transport-security")).toBe("max-age=60");
      }
      env.ASSETS = { fetch: async () => Response.redirect("https://notes.example.com/", 302) };
      const redirect = await call("GET", "/redirect.js");
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("https://notes.example.com/");
      expect(redirect.headers.get("x-content-type-options")).toBe("nosniff");
      env.ASSETS = { fetch: async () => { throw new Error("header regression"); } };
      const failed = await call("GET", "/error.js");
      expect(failed.status).toBe(500);
      expect(failed.headers.get("x-frame-options")).toBe("DENY");
      expect(failed.headers.get("x-content-type-options")).toBe("nosniff");
    } finally { env.ASSETS = previous; }
  });

  test("invalid account JSON objects return bad_json without throwing", async () => {
    const cookie = await as(OWNER_UID);
    for (const path of ["/api/profile", "/api/auth/login", "/api/auth/forgot", "/api/auth/reset"]) {
      for (const body of [null, [], "text", 42, true]) {
        const response = await call("POST", path, { cookie, body });
        expect([path, body, response.status, response.data.error]).toEqual([path, body, 400, "bad_json"]);
      }
    }
    // Email sign-up is closed (#173): the body is never read, so any body gets the same refusal.
    for (const body of [null, [], "text", 42, true]) {
      const response = await call("POST", "/api/auth/signup", { cookie, body });
      expect([body, response.status, response.data.error]).toEqual([body, 403, "email_signup_closed"]);
    }
  });

  test("malformed print encoding returns 400 without throwing", async () => {
    expect((await call("GET", "/print/%E0%A4%A/", { cookie: await as(OWNER_UID) })).status).toBe(400);
  });

  test("malformed SSE JSON returns a JSON-RPC parse error", async () => {
    const made = await call("POST", "/api/agents/tokens", { cookie: await as(OWNER_UID), body: { name: "SSE regression", scopes: ["read"] } });
    let owner: string | null = null;
    const previous = env.SSE_RELAY;
    env.SSE_RELAY = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (input: string) => {
        const url = new URL(input);
        if (url.pathname === "/open") { owner = url.searchParams.get("owner"); return new Response(null); }
        if (url.pathname === "/owner") return Response.json({ owner });
        throw new Error("Malformed JSON must not reach relay delivery");
      } }),
    };
    try {
      expect((await call("GET", "/sse", { bearer: made.data.token })).status).toBe(200);
      const response = await worker.fetch(new Request("https://notes.example.com/sse/message?sessionId=11111111-1111-4111-8111-111111111111", {
        method: "POST", headers: { authorization: "Bearer " + made.data.token, "content-type": "application/json" }, body: "{",
      }), env, {});
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    } finally { env.SSE_RELAY = previous; }
  });

  test("unexpected failures become no-store structured responses on every route", async () => {
    const original = env.ASSETS;
    env.ASSETS = { fetch: async () => { throw new Error("private failure detail"); } };
    try {
      for (const path of ["/", "/login", "/style.css"]) {
        const response = await call("GET", path);
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.text).not.toContain("private failure detail");
      }
    } finally { env.ASSETS = original; }
    const db = env.DB;
    env.DB = { prepare: () => { throw new Error("private database detail"); } };
    try {
      for (const path of ["/api/v1/me", "/mcp", "/sse"]) {
        const response = await call("GET", path, { bearer: "acard_" + "x".repeat(40) });
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.data.error).toBe("internal_error");
        expect(response.text).not.toContain("private database detail");
      }
    } finally { env.DB = db; }
  });

  test("logged out: landing at /, account pages served, app API refused", async () => {
    const home = await call("GET", "/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("LANDING");
    expect((await call("GET", "/login")).text).toContain("LOGIN");
    expect((await call("GET", "/api/tree")).status).toBe(401);
    expect((await call("GET", "/owner-secret/")).status).toBe(303);
  });

  // The old /connect page was merged into 설정 > 에이전트 연결 (owner pick 2026-10-20); old links must still land there.
  test("desktop waiting is public, onboarding requires a session, and login preserves the handoff", async () => {
    const cookie = await as(UID_A);
    expect((await call("GET", "/desktop/wait")).text).toContain("DESKTOP WAIT");
    expect((await call("GET", "/desktop/wait", { cookie })).text).toContain("DESKTOP WAIT");
    for (const page of ["start", "tour"]) {
      const path = "/desktop/" + page;
      const anonymous = await call("GET", path);
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get("location")).toBe("/login?next=" + encodeURIComponent(path));
      const signedIn = await call("GET", path, { cookie });
      expect(signedIn.status).toBe(200);
      expect(signedIn.text).toContain("DESKTOP " + page.toUpperCase());
      expect(signedIn.text).not.toContain("owner-secret");
    }
    const resumed = await call("GET", "/login?next=%2Fapi%2Fauth%2Fdesktop%2Fhandoff", { cookie });
    expect(resumed.headers.get("location")).toBe("/api/auth/desktop/handoff");
    const reserved = await call("GET", "/api/handle?h=desktop", { cookie });
    expect(reserved.data.status).toBe("reserved");
    expect((await call("GET", "/owner-secret/desktop/start", { cookie })).status).toBe(404);
  });

  test("/connect sends signed-in and signed-out people to 설정 > 에이전트 연결", async () => {
    const cookie = await as(OWNER_UID);
    for (const [path, to] of [["/connect", "/settings/agents/"], ["/connect/", "/settings/agents/"], ["/connect?from=mail", "/settings/agents/?from=mail"]]) {
      for (const who of [cookie, undefined]) {
        const res = await call("GET", path, { cookie: who });
        expect([path, !!who, res.status, res.headers.get("location")]).toEqual([path, !!who, 301, to]);
      }
    }
    expect((await call("GET", "/settings/agents/")).headers.get("location")).toBe("/login?next=/settings/agents/");
  });

  test("owner signs in with Google session and sees the existing workspace", async () => {
    const cookie = await as(OWNER_UID);
    const tree = await call("GET", "/api/tree", { cookie });
    expect(tree.data.pages.map((p: any) => p.slug)).toContain("owner-secret");
    const page = await call("GET", "/owner-secret/", { cookie });
    expect(page.status).toBe(200);
    expect(page.text).toContain("zebra");
  });

  // #44: the pooler is out of connections everywhere (even outside the page handlers): the Worker answers 503 with the
  // retrying page or a retry JSON, never an uncaught exception (Cloudflare 1101).
  test("a busy database pooler never throws out of the Worker", async () => {
    const cookie = await as(OWNER_UID);
    const db = env.DB;
    const busy = () => { throw Object.assign(new Error("(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15"), { code: "XX000" }); };
    const stmt: any = { bind: () => stmt, first: busy, all: busy, run: busy, raw: busy };
    env.DB = { prepare: () => stmt, batch: busy, exec: busy };
    try {
      const page = await call("GET", "/owner-secret/", { cookie });
      expect(page.status).toBe(503);
      expect(page.text).toContain("잠시 연결이 몰렸어요");
      expect(page.text).not.toContain("없는 문서");
      const tree = await call("GET", "/api/tree", { cookie });
      expect(tree.status).toBe(503);
      expect(tree.headers.get("retry-after")).toBe("2");
      expect(tree.data.retry).toBe(true);
    const agent = await call("GET", "/api/v1/pages", { bearer: "acard_" + "x".repeat(40) });
    expect(agent.status).toBe(503);
    } finally {
      env.DB = db;
    }
    expect((await call("GET", "/owner-secret/", { cookie })).status).toBe(200);
  });
  // #57: Hyperdrive dropping a pooled socket ("Network connection lost.", "write CONNECTION_CLOSED") was thrown out of the
  // Worker as Cloudflare 1101 for the owner's first screen and agent calls.
  test("a dropped database socket never throws out of the Worker", async () => {
    const cookie = await as(OWNER_UID);
    const db = env.DB;
    for (const message of ["Network connection lost.", "write CONNECTION_CLOSED 7fbe.hyperdrive.local:5432"]) {
      const lost = () => { throw Object.assign(new Error(message), { code: message.startsWith("write") ? "CONNECTION_CLOSED" : undefined }); };
      const stmt: any = { bind: () => stmt, first: lost, all: lost, run: lost, raw: lost };
      env.DB = { prepare: () => stmt, batch: lost, exec: lost };
      try {
        const agent = await call("GET", "/api/v1/me", { bearer: "acard_" + "x".repeat(40) });
        expect(agent.status).toBe(503);
        const tree = await call("GET", "/api/tree", { cookie });
        expect(tree.status).toBe(503);
      } finally {
        env.DB = db;
      }
    }
  });
  test("a new account gets an empty workspace with the same app and can create a page that persists", async () => {
    const cookie = await as(UID_A);
    const tree = await call("GET", "/api/tree", { cookie });
    expect(tree.status).toBe(200);
    expect(tree.data.pages).toEqual([]);
    // acard-home-first: "/" is the landing for a signed-in account too; the workspace home is /home/.
    const landing = await call("GET", "/", { cookie });
    expect(landing.status).toBe(200);
    expect(landing.text).toContain("LANDING");
    const home = await call("GET", "/home/", { cookie });
    expect(home.status).toBe(200);
    expect(home.text).toContain('class="shell"');
    expect(home.text).not.toContain("Owner Secret");
    const created = await call("POST", "/api/pages", { cookie, body: { title: "A의 첫 페이지" } });
    expect(created.status).toBe(200);
    const again = await call("GET", "/api/tree", { cookie: await as(UID_A) });
    expect(again.data.pages.map((p: any) => p.title)).toEqual(expect.arrayContaining(["Home", "A의 첫 페이지"]));
    expect(owner.query("SELECT count(*) AS n FROM pages WHERE title = 'A의 첫 페이지'").get()).toEqual({ n: 0 });
  });

  test("a member cannot reach owner pages, search, static seeds, media or share creation", async () => {
    const cookie = await as(UID_A);
    expect((await call("GET", "/api/page/owner-secret", { cookie })).status).toBe(404);
    expect((await call("GET", "/owner-secret/", { cookie })).status).toBe(404);
    const search = await call("GET", "/api/search?q=zebra", { cookie });
    expect(JSON.stringify(search.data)).not.toContain("owner-secret");
    for (const path of ["/notes-seed.json", "/search-index.json", "/db-seed.json"]) expect((await call("GET", path, { cookie })).status).toBe(404);
    expect((await call("GET", "/media/aaaaaaaaaaaaaaaa", { cookie })).status).toBe(404);
    expect((await call("POST", "/api/page/owner-secret/share", { cookie })).status).toBe(404);
    expect((await call("GET", "/api/db/list", { cookie })).data.databases ?? []).toEqual([]);
  });

  test("workspace tokens only open their own store; owner tokens keep working", async () => {
    const cookieA = await as(UID_A);
    const made = await call("POST", "/api/agents/tokens", { cookie: cookieA, body: { name: "A bot", scopes: ["read", "write"] } });
    expect(made.status).toBe(201);
    expect(made.data.token).toStartWith("acard_m" + hex(UID_A) + "_");
    const list = await call("GET", "/api/v1/pages", { bearer: made.data.token });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).not.toContain("owner-secret");
    expect((await call("GET", "/api/v1/pages/owner-secret", { bearer: made.data.token })).status).toBe(404);
    const forged = made.data.token.replace(hex(UID_A), hex(UID_B));
    expect((await call("GET", "/api/v1/pages", { bearer: forged })).status).toBe(401);

    const ownerMade = await call("POST", "/api/agents/tokens", { cookie: await as(OWNER_UID), body: { name: "devlog", scopes: ["read", "write"] } });
    expect(ownerMade.data.token).toStartWith("acard_");
    // Owner tokens are acard_ + random base64url, so ~1 in 64 start with "m"; a member token is acard_m<32 hex>_.
    expect(ownerMade.data.token).not.toMatch(/^acard_m[0-9a-f]{32}_/);
    const ownerList = await call("GET", "/api/v1/pages", { bearer: ownerMade.data.token });
    expect(JSON.stringify(ownerList.data)).toContain("owner-secret");
    const appended = await call("POST", "/api/v1/pages", { bearer: ownerMade.data.token, body: { title: "개발 일지 테스트", markdown: "hello" } });
    expect([200, 201]).toContain(appended.status);
  });

  test("agent writes stop at the per-minute limit with 429 + Retry-After; reads and the person's own editor saves keep working", async () => {
    const cookieB = await as(UID_B);
    const made = await call("POST", "/api/agents/tokens", { cookie: cookieB, body: { name: "loop bot", scopes: ["read", "write"] } });
    const page = await call("POST", "/api/v1/pages", { bearer: made.data.token, body: { title: "limit", markdown: "x" } });
    const slug = page.data.slug;
    const mcp = (name: string, args: Record<string, unknown>) => worker.fetch(new Request("https://notes.example.com/mcp", { method: "POST", headers: { authorization: "Bearer " + made.data.token, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, {});
    for (let i = 1; i < 60; i++) expect((await mcp("append_to_page", { slug, markdown: "line " + i })).status).toBe(200);
    const over = await mcp("append_to_page", { slug, markdown: "one too many" });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await over.json()) as any).error).toContain("1분에 쓸 수 있는 횟수(60번)");
    expect((await call("POST", "/api/v1/pages", { bearer: made.data.token, body: { title: "again", markdown: "y" } })).status).toBe(429);
    expect((await mcp("read_page", { slug })).status).toBe(200);
    expect((await call("GET", "/api/v1/pages/" + encodeURIComponent(slug), { bearer: made.data.token })).status).toBe(200);
    const read = await call("GET", "/api/page/" + encodeURIComponent(slug), { cookie: cookieB });
    for (let i = 0; i < 3; i++) {
      const saved = await call("PUT", "/api/page/" + encodeURIComponent(slug), { cookie: cookieB, body: { base_updated: (await call("GET", "/api/page/" + encodeURIComponent(slug), { cookie: cookieB })).data.page.updated, blocks: [{ id: "p" + i, type: "paragraph", text: "person " + i }] } });
      expect(saved.status).toBe(200);
    }
    expect(read.status).toBe(200);
  });

  test("two members never see each other", async () => {
    await call("POST", "/api/pages", { cookie: await as(UID_B), body: { title: "B only" } });
    const a = await call("GET", "/api/tree", { cookie: await as(UID_A) });
    expect(a.data.pages.map((p: any) => p.title)).not.toContain("B only");
  });

  test("a forged or expired session is treated as logged out", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    expect((await call("GET", "/api/tree", { cookie: "acard_at=" + (await jwt(OWNER_UID, { key: other.privateKey })) })).status).toBe(401);
    expect((await call("GET", "/api/tree", { cookie: "acard_at=" + (await jwt(OWNER_UID, { exp: 10 })) })).status).toBe(401);
    expect((await call("GET", "/api/tree", { cookie: "acard_at=" + (await jwt(OWNER_UID, { iss: "https://evil.test/auth/v1" })) })).status).toBe(401);
  });

  test("Notion import sends a signed-out visitor to login with its return path", async () => {
    const response = await call("GET", "/import");
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location")!, "https://notes.example.com");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("/import");
  });

  test("old hosts redirect people to notes.example.com but keep agent paths answering during the move", async () => {
    const page = await call("GET", "/board/?x=1", { host: "old.notes.example.com" });
    expect(page.status).toBe(301);
    expect(page.headers.get("location")).toBe("https://notes.example.com/board/?x=1");
    expect((await call("GET", "/", { host: "legacy.notes.example.com" })).headers.get("location")).toBe("https://notes.example.com/");
    expect((await call("GET", "/api/v1/pages", { host: "old.notes.example.com" })).status).toBe(401);
    env.LEGACY_MODE = "redirect-all";
    try { expect((await call("GET", "/api/v1/pages", { host: "old.notes.example.com" })).status).toBe(301); }
    finally { delete env.LEGACY_MODE; }
  });

  test("the old owner password ticket no longer opens anything on the site", async () => {
    const ticketTime = String(Math.floor(Date.now() / 1000) + 3600);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ticketTime)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const cookie = "dn_auth=" + ticketTime + "." + mac;
    expect((await call("GET", "/api/tree", { cookie })).status).toBe(401);
    expect((await call("GET", "/api/agents/tokens", { cookie })).status).toBe(401);
    expect((await call("POST", "/__gate")).status).toBe(303);
  });

  test("only a request carrying the forward secret is treated as notes.example.com", async () => {
    env.FORWARD_SECRET = "fwd-secret";
    try {
      const google = (secret: string) => worker.fetch(new Request("https://notes-example.pages.dev/api/auth/google", { headers: { "x-acard-forward": secret, "x-acard-host": "notes.example.com" }, redirect: "manual" }), env, {});
      const viaWorker = await worker.fetch(new Request("https://notes-example.pages.dev/login", { headers: { "x-acard-forward": "fwd-secret", "x-acard-host": "notes.example.com", accept: "text/html" } }), env, {});
      expect(viaWorker.status).toBe(200);
      const trusted = decodeURIComponent((await google("fwd-secret")).headers.get("location") ?? "");
      expect(trusted).toContain("redirect_to=https://notes.example.com/api/auth/callback");
      const forged = decodeURIComponent((await google("wrong")).headers.get("location") ?? "");
      expect(forged).toContain("redirect_to=https://notes-example.pages.dev/api/auth/callback");
    } finally { delete env.FORWARD_SECRET; }
  });

  test("deleting a member account wipes its store and media but refuses the owner", async () => {
    const ws = hex(UID_B);
    await env.MEDIA.put("ws/" + ws + "/media/bbbbbbbbbbbbbbbb", new Uint8Array([9]).buffer, {});
    const before = await stores.get("ws:" + ws).stats();
    expect(before.pages).toBeGreaterThan(0);
    const del = await call("POST", "/api/account/delete", { cookie: await as(UID_B) });
    expect(del.status).toBe(500);
    expect((await stores.get("ws:" + ws).stats()).pages).toBe(0);
    expect([...env.MEDIA.map.keys()].some((k: string) => k.startsWith("ws/" + ws))).toBe(false);
    expect((await call("POST", "/api/account/delete", { cookie: await as(OWNER_UID) })).status).toBe(403);
    expect(owner.query("SELECT count(*) AS n FROM pages WHERE slug = 'owner-secret'").get()).toEqual({ n: 1 });
  });
});

test("member share URLs reach the share route with their page, media and HTML-block frame paths", async () => {
  const { MEMBER_SHARE } = await import("../gate/tenancy");
  const ws = hex(UID_A), tok = "A".repeat(43);
  for (const rest of ["", "/", "/sub/", "/media/0123456789abcdef", "/frame/bpqhtml0", "/sub/frame/b1"]) expect(MEMBER_SHARE.exec("/p/m" + ws + "/" + tok + rest)?.[2]).toBe("/" + tok + rest);
  for (const bad of ["/a/b/c", "/media/xyz", "/sub/frame/b1/x"]) expect(MEMBER_SHARE.test("/p/m" + ws + "/" + tok + bad)).toBe(false);
});

describe("repeating templates run per workspace (notion-parity C5)", () => {
  const RA = "44444444-4444-4444-8444-444444444444";
  const RB = "55555555-5555-4555-8555-555555555555";
  const tickCall = (body: unknown, secret?: string) => worker.fetch(new Request("https://notes.example.com/__recurring/tick", { method: "POST", headers: { "content-type": "application/json", ...(secret === undefined ? {} : { "x-recurring-tick": secret }) }, body: JSON.stringify(body) }), env, {});

  async function memberDiary(uid: string) {
    const cookie = await as(uid);
    const db = (await call("POST", "/api/db", { cookie, body: { title: "반복 " + uid.slice(0, 4) } })).data;
    const base = "/api/db/" + encodeURIComponent(db.slug);
    const tpl = (await call("POST", base + "/templates", { cookie, body: { name: "오늘", props: {}, blocks: [] } })).data.template;
    const saved = (await call("PATCH", base + "/templates/" + encodeURIComponent(tpl.id), { cookie, body: { recurrence: { freq: "day", hour: 7, minute: 0, tz: "Asia/Seoul" } } })).data.template;
    return { cookie, base, tpl: saved };
  }

  test("(e) without the secret header the tick is 404 like the agent tick and changes nothing", async () => {
    env.RECURRING_TICK_SECRET = "tick-secret";
    const { cookie, base, tpl } = await memberDiary(RA);
    const due = tpl.recurrence.next_run + 1000;
    expect((await tickCall({ ws: hex(RA), now: due })).status).toBe(404);
    expect((await tickCall({ ws: hex(RA), now: due }, "wrong")).status).toBe(404);
    expect((await call("GET", base, { cookie })).data.rows.length).toBe(0);
    expect((await tickCall({ ws: "../owner", now: due }, "tick-secret")).status).toBe(400);
    const agent = await worker.fetch(new Request("https://notes.example.com/__agent/tick", { method: "POST", body: "{}" }), env, {});
    expect(agent.status).toBe(404);
  });

  test("(f) a tick for workspace A makes A's row and never B's", async () => {
    env.RECURRING_TICK_SECRET = "tick-secret";
    const a = await memberDiary(RA);
    const b = await memberDiary(RB);
    const due = Math.max(a.tpl.recurrence.next_run, b.tpl.recurrence.next_run) + 1000;
    const before = (await call("GET", a.base, { cookie: a.cookie })).data.rows.length;
    const res = await tickCall({ ws: hex(RA), now: due }, "tick-secret");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.created.length).toBeGreaterThanOrEqual(1);
    expect((await call("GET", a.base, { cookie: a.cookie })).data.rows.length).toBe(before + 1);
    expect((await call("GET", b.base, { cookie: b.cookie })).data.rows.length).toBe(0);
    const ownerRows = owner.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'db_template_runs'").get() as any;
    if (ownerRows.n) expect(owner.query("SELECT count(*) AS n FROM db_template_runs").get()).toEqual({ n: 0 });
  });

  test("(g) saving a repeat arms the member store's alarm; the alarm calls the site and re-arms; the last repeat off clears it", async () => {
    env.RECURRING_TICK_SECRET = "tick-secret";
    const uid = "33333333-3333-4333-8333-333333333333";
    const { cookie, base, tpl } = await memberDiary(uid);
    const store = stores.get("ws:" + hex(uid));
    const alarms: (number | null)[] = [];
    const storage = store.ctx.storage;
    const kv = new Map<string, unknown>();
    storage.setAlarm = async (at: number) => { alarms.push(at); };
    storage.deleteAlarm = async () => { alarms.push(null); };
    storage.put = async (k: string, v: unknown) => { kv.set(k, v); };
    storage.get = async (k: string) => kv.get(k);
    await call("PATCH", base + "/templates/" + encodeURIComponent(tpl.id), { cookie, body: { recurrence: { freq: "day", hour: 7, minute: 0, tz: "Asia/Seoul" } } });
    const armed = alarms.at(-1)!;
    expect(armed).toBe((await call("GET", base, { cookie })).data.templates[0].recurrence.next_run);
    expect(kv.get("recurringWs")).toBe(hex(uid));
    // The alarm posts to the site; route that fetch into this worker with a clock past the run.
    store.env = { SITE_URL: "https://notes.example.com", RECURRING_TICK_SECRET: "tick-secret" };
    const realFetchHere = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://notes.example.com/__recurring/tick") {
        const body = JSON.parse(init.body);
        return worker.fetch(new Request(url, { method: "POST", headers: init.headers, body: JSON.stringify({ ...body, now: armed + 1000 }) }), env, {});
      }
      return realFetchHere(input, init);
    }) as typeof fetch;
    try { await store.alarm(); } finally { globalThis.fetch = realFetchHere; }
    expect((await call("GET", base, { cookie })).data.rows.length).toBe(1);
    expect(alarms.at(-1)).toBe(armed + 24 * 3600000);
    await call("PATCH", base + "/templates/" + encodeURIComponent(tpl.id), { cookie, body: { recurrence: null } });
    expect(alarms.at(-1)).toBeNull();
  });
});
