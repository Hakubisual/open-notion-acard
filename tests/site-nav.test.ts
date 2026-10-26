// One top bar on the public pages (acard-site-bar-unify): /compare, /download and /guide serve the landing's
// <header class="nav"> through the bundled entry, for a visitor and a signed-in member, with the beta open and closed,
// in en/ko/zh. The only allowed differences are "#x" written as "/#x" and aria-current on the page's own link.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleWorkerSource } from "./assemble-worker";
import { withSiteNav } from "../gate/site-nav-html";

class FakeDurableObject { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } }
class FakeWorkerEntrypoint { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } }
mock.module("cloudflare:workers", () => ({ DurableObject: FakeDurableObject, WorkerEntrypoint: FakeWorkerEntrypoint }));

const ROOT = join(import.meta.dir, "..");
const SUPABASE = "https://supa.test";
const MEMBER = "55555555-5555-4555-8555-555555555555";
const PAGES = ["/download"];
const realFetch = globalThis.fetch;
let worker: any;
let env: any;
let keyPair: CryptoKeyPair;
let dir: string;
const site: Record<string, string> = {};

const b64url = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
async function jwt(sub: string) {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ sub, email: "member@test.dev", exp: Math.floor(Date.now() / 1000) + 600, iss: SUPABASE + "/auth/v1", aud: "authenticated", role: "authenticated" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(sig);
}
function memoryKv() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    getWithMetadata: async (key: string) => ({ value: map.get(key) ?? null, metadata: null }),
    put: async (key: string, value: string) => { map.set(key, value); },
    delete: async (key: string) => { map.delete(key); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}
async function get(path: string, lang: string, member: boolean, beta: string) {
  const cookie = "acard_lang=" + lang + (member ? "; acard_at=" + (await jwt(MEMBER)) : "");
  const request = new Request("https://notes.example.com" + path, { headers: { accept: "text/html", cookie }, redirect: "manual" });
  const res: Response = await worker.fetch(request, { ...env, BETA_MODE: beta }, { waitUntil() {} });
  return { status: res.status, html: await res.text() };
}
const bar = (html: string) => (/<header class="nav">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "no header.nav")
  .replace(/href="#/g, 'href="/#').replace(/ aria-current="page"/g, "");

beforeAll(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "acard-site-nav-"));
  const landing = await readFile(join(ROOT, "assets/_site/index.html"), "utf8");
  site["/_site/index.html"] = landing;
  for (const path of PAGES) site["/_site" + path + ".html"] = withSiteNav(await readFile(join(ROOT, "assets/_site" + path + ".html"), "utf8"), landing, path);
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
  const { WorkspaceStore } = await import("../workers/acard-workspace/index.js");
  keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === SUPABASE + "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
    if (url.origin === SUPABASE) return Response.json([]);
    return realFetch(input, init);
  }) as typeof fetch;
  const stores = new Map<string, any>();
  const sqlStorage = (sqlite: Database) => ({
    sql: { exec: (sql: string, ...params: unknown[]) => { const rows = sqlite.query(sql).all(...(params as any[])) as any[]; return { toArray: () => rows, one: () => rows[0] }; }, get databaseSize() { return 0; } },
    transactionSync: (fn: () => unknown) => sqlite.transaction(fn)(),
    deleteAll: async () => {}, get: async () => undefined, put: async () => {}, setAlarm: async () => {}, deleteAlarm: async () => {},
  });
  env = {
    MEDIA: memoryKv(), OUTBOX: memoryKv(), GATE_PASSWORD: "pw", GATE_SECRET: "secret", OWNER_USER_ID: "00000000-0000-4000-8000-000000000001",
    SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    ASSETS: { fetch: async (request: Request) => {
      const html = site[new URL(request.url).pathname];
      return html ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response("Not Found", { status: 404 });
    } },
    WORKSPACE: { idFromName: (name: string) => name, get: (id: string) => { if (!stores.has(id)) stores.set(id, new WorkspaceStore({ storage: sqlStorage(new Database(":memory:")) }, {})); return stores.get(id); } },
  };
}, 120000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("public pages show the landing's top bar", () => {
  for (const beta of ["open", "closed"]) for (const member of [false, true]) for (const lang of ["en", "ko", "zh"]) {
    test(`${beta} beta, ${member ? "member" : "visitor"}, ${lang}`, async () => {
      const landing = await get("/", lang, member, beta);
      expect(landing.status).toBe(200);
      expect(landing.html.includes('data-session="1"')).toBe(member);
      for (const path of PAGES) {
        const page = await get(path, lang, member, beta);
        expect({ path, status: page.status, bar: bar(page.html) }).toEqual({ path, status: 200, bar: bar(landing.html) });
        expect(page.html.match(/테스터|#테스터-등록|class="discord"/g) ?? [], path).toEqual([]);
      }
    });
  }
});
