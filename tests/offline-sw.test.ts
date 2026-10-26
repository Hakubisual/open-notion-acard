import { expect, test } from "bun:test";
import { createOfflineWorker, route, shellRefs, shouldCache } from "../offline-sw.js";
import { assembleWorkerSource } from "./assemble-worker";

const origin = "https://notes.test";
const id = "aaaaaaaaaaaaaaaa";
const cacheName = (kind: string) => "acard-" + kind + "-test-" + id;
const req = (path: string, method = "GET") => new Request(origin + path, { method });
const html = (text = "private") => new Response('<main id="main">' + text + '</main>', { headers: { "content-type": "text/html", "x-acard-id": id } });

test("anonymous update can fetch only the generated worker script, not private routes", async () => {
  const worker = new Function(assembleWorkerSource())();
  const env = { GATE_PASSWORD: "fixture-pw", GATE_SECRET: "fixture-secret", ASSETS: { fetch: async () => new Response("/* generated worker */") } };
  const response = await worker.fetch(req("/sw.js"), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("service-worker-allowed")).toBe("/");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  for (const path of ["/one/", "/api/page/one", "/api/tree", "/notes-seed.json", "/app.js", "/edit/one", "/sw.js/extra"]) {
    expect((await worker.fetch(req(path), env)).status).toBe(401);
  }
  expect((await worker.fetch(req("/sw.js", "POST"), env)).status).toBe(401);
});

// Cache API semantics used by the worker: cloned responses, absolute keys,
// named-cache deletion and independently surviving cache handles.
class MemoryCache {
  entries = new Map<string, Response>();
  key(input: Request | string) { return typeof input === "string" ? input : input.url; }
  async put(input: Request | string, response: Response) { this.entries.set(this.key(input), response.clone()); }
  async match(input: Request | string) { return this.entries.get(this.key(input))?.clone(); }
  async delete(input: Request | string) { return this.entries.delete(this.key(input)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}
class MemoryCaches {
  stores = new Map<string, MemoryCache>();
  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) { cache = new MemoryCache(); this.stores.set(name, cache); }
    return cache;
  }
  async keys() { return [...this.stores.keys()]; }
  async has(name: string) { return this.stores.has(name); }
  async delete(name: string) { return this.stores.delete(name); }
}
function fixture() {
  const caches = new MemoryCaches();
  let network: (request: Request) => Promise<Response> = async () => html();
  const errors: unknown[] = [];
  const sw = createOfflineWorker({ caches, origin, fetch: (request: Request) => network(request), report: (error: unknown) => errors.push(error) }, { version: "test", shell: ["/app.js?v=abc"] });
  return { caches, sw, errors, network(fn: typeof network) { network = fn; }, offline() { network = async () => { throw new TypeError("offline"); }; } };
}

test("cache fake preserves clone and deletion semantics", async () => {
  const caches = new MemoryCaches();
  const cache = await caches.open("test");
  await cache.put(req("/one/"), html());
  expect(await (await cache.match(req("/one/")))?.text()).toContain("private");
  expect(await (await cache.match(req("/one/")))?.text()).toContain("private");
  await caches.delete("test");
  expect(await caches.keys()).toEqual([]);
  expect(await (await caches.open("test")).keys()).toEqual([]);
});

test("only page HTML, page API, tree and exact shell URLs are cacheable", () => {
  for (const path of ["/", "/one/", "/api/page/one", "/api/tree"]) {
    expect(route(req(path), origin)).not.toBeNull();
    expect(shouldCache(req(path), html(), origin)).toBe(true);
  }
  for (const path of ["/__gate", "/__logout", "/api/agents", "/api/agents/x", "/mcp", "/mcp/", "/sse", "/oauth/login", "/oauth/", "/p/token", "/p/", "/api/search", "/edit/one", "/edit/", "/print/one/", "/notes-seed.json", "/one/?acard-revalidate=1", "/?acard-revalidate=1"]) {
    expect(route(req(path), origin)).toBeNull();
    expect(shouldCache(req(path), html(), origin)).toBe(false);
  }
  expect(shouldCache(req("/app.js?v=abc"), html(), origin, ["/app.js?v=abc"])).toBe(true);
  expect(shouldCache(req("/app.js?v=other"), html(), origin, ["/app.js?v=abc"])).toBe(false);
  expect(shouldCache(new Request("https://other.test/one/"), html(), origin)).toBe(false);
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) expect(shouldCache(req("/one/", method), html(), origin)).toBe(false);
  for (const status of [201, 204, 301, 401, 403, 404, 500]) expect(shouldCache(req("/one/"), new Response(null, { status }), origin)).toBe(false);
});

test("visited editor HTML stays network-first and is available offline with its shell", async () => {
  const f = fixture();
  f.network(async () => html('<script src="/app.js?v=abc"></script>editor old'));
  await f.sw.install();
  await f.sw.handle(req('/edit/one/'));
  f.network(async () => html('<script src="/app.js?v=abc"></script>editor new'));
  const background: Promise<unknown>[] = [];
  expect(await (await f.sw.handle(req('/edit/one/'), (work: Promise<unknown>) => background.push(work))).text()).toContain('editor new');
  await Promise.all(background);
  f.offline();
  const cached = await f.sw.handle(req('/edit/one/'));
  expect(cached.status).toBe(200);
  expect(cached.headers.get('x-acard-offline')).toBe('1');
  expect(cached.headers.get('x-acard-swr')).toBeNull();
  expect(await cached.text()).toContain('editor new');
  await f.caches.delete(cacheName('shell'));
  expect((await f.sw.handle(req('/edit/one/'))).status).toBe(503);
});

test("editor startup requires its cached recent-cache script before offline navigation", async () => {
  const f = fixture();
  f.network(async () => html('<link rel="preload" as="script" href="/lazy/recent-cache.js?v=abc">'));
  await f.sw.handle(req("/edit/one/"));
  f.offline();
  expect((await f.sw.handle(req("/edit/one/"))).status).toBe(503);
  const shell = await f.caches.open(cacheName("shell"));
  await shell.put(origin + "/lazy/recent-cache.js?v=abc", html("script"));
  expect((await f.sw.handle(req("/edit/one/"))).status).toBe(200);
});

test("successful page saves retain the visited editor shell for offline reload", async () => {
  const f = fixture();
  await f.sw.handle(req("/edit/one/"));
  await f.sw.handle(req("/one/"));
  await f.sw.handle(req("/api/page/one", "PUT"));
  f.offline();
  expect((await f.sw.handle(req("/edit/one/"))).status).toBe(200);
  expect((await f.sw.handle(req("/one/"))).status).toBe(503);
});

test("injected nested scripts are cached at their exact versions for editor startup", async () => {
  const caches = new MemoryCaches();
  let online = true;
  const asset = "/_site/beta.js?v=fixture";
  const sw = createOfflineWorker({ caches, origin, report: () => {}, fetch: async (request: Request) => {
    if (!online) throw new TypeError("offline");
    return html(new URL(request.url).pathname.startsWith("/edit/") ? '<script src="' + asset + '"></script>' : "script");
  } }, { version: "test", shell: [], lazy: [asset] });
  await sw.handle(req("/edit/one/"));
  await sw.handle(req(asset));
  online = false;
  expect((await sw.handle(req("/edit/one/"))).status).toBe(200);
  expect((await sw.handle(req(asset))).status).toBe(200);
  expect((await sw.handle(req("/_site/beta.js?v=other"))).status).toBe(503);
});

test("cached editor navigation refuses cookie loss and an account switch", async () => {
  const caches = new MemoryCaches();
  let cookieId: string | null = id, online = true;
  const sw = createOfflineWorker({ caches, origin, cookieId: () => cookieId, report: () => {}, fetch: async () => {
    if (!online) throw new TypeError("offline");
    return html("member editor");
  } }, { version: "test", shell: [] });
  await sw.handle(req("/edit/one/"), undefined, "tab");
  online = false;
  expect((await sw.handle(req("/edit/one/"), undefined, "tab")).status).toBe(200);
  cookieId = null;
  expect((await sw.handle(req("/edit/one/"), undefined, "tab")).status).toBe(503);
  cookieId = "bbbbbbbbbbbbbbbb";
  expect((await sw.handle(req("/edit/one/"), undefined, "tab")).status).toBe(503);
  expect(await caches.has(cacheName("pages"))).toBe(false);
});

test("lazy assets are cached on demand only at their exact build version", async () => {
  const caches = new MemoryCaches();
  const requested: string[] = [];
  let online = true;
  const sw = createOfflineWorker({ caches, origin, report: () => {}, fetch: async (request: Request) => {
    requested.push(request.url);
    if (!online) throw new TypeError('offline');
    return html('lazy code');
  } }, { version: 'test', shell: [], lazy: ['/lazy/recent-cache.js?v=abc'] });
  await sw.install();
  expect(requested).toEqual([]);
  await sw.handle(req('/lazy/recent-cache.js?v=abc'));
  online = false;
  expect((await sw.handle(req('/lazy/recent-cache.js?v=abc'))).status).toBe(200);
  expect((await sw.handle(req('/lazy/recent-cache.js?v=other'))).status).toBe(503);
  await sw.wipe();
  expect((await sw.handle(req('/lazy/recent-cache.js?v=abc'))).status).toBe(503);
});

test("install precaches exact versioned shell assets only", async () => {
  const f = fixture();
  await f.sw.install();
  f.offline();
  expect((await f.sw.handle(req("/app.js?v=abc"))).status).toBe(200);
  expect((await f.sw.handle(req("/unknown/"))).status).toBe(503);
  expect(await f.caches.keys()).toEqual([cacheName("shell")]);
});

test("failed install never stores an unauthorized shell response, and still installs", async () => {
  const f = fixture();
  f.network(async () => new Response("denied", { status: 401 }));
  await f.sw.install();
  expect(await f.caches.keys()).toEqual([]);
});

test("a shell file this account cannot read (member 404) is skipped, the rest is precached", async () => {
  const caches = new MemoryCaches();
  const sw = createOfflineWorker({ caches, origin, report: () => {}, fetch: async (r: Request) => new URL(r.url).pathname.startsWith("/img/") ? new Response("no", { status: 404 }) : html() }, { version: "test", shell: ["/app.js?v=abc", "/img/avatars/owner-96.webp?v=x"] });
  await sw.install();
  expect((await (await caches.open(cacheName("shell"))).keys()).map((r) => new URL(r.url).pathname)).toEqual(["/app.js"]);
});

// A CacheStorage that never answers: what a broken profile looks like to the worker.
class HungCaches extends MemoryCaches {
  hang = false;
  never = () => new Promise<never>(() => {});
  override async open(name: string) { if (this.hang) return this.never(); return super.open(name); }
  override async keys() { if (this.hang) return this.never(); return super.keys(); }
  override async has(name: string) { if (this.hang) return this.never(); return super.has(name); }
}

test("a hung cache never holds a page, a tree read, a sign-in or a logout longer than the cache step limit", async () => {
  const caches = new HungCaches();
  let body = "page";
  const pending: Promise<unknown>[] = [];
  const sw = createOfflineWorker({ caches, origin, report: () => {}, fetch: async () => new Response(body, { status: 200, headers: { "content-type": "text/html", "x-acard-id": id } }) }, { version: "test", shell: [] });
  await sw.handle(req("/api/tree"), (p: Promise<unknown>) => pending.push(p));
  caches.hang = true;
  const started = Date.now();
  expect(await (await sw.handle(req("/one/"), (p: Promise<unknown>) => pending.push(p))).text()).toBe("page");
  expect(Date.now() - started).toBeLessThan(4500);
  body = "tree";
  expect(await (await sw.handle(req("/api/tree"), (p: Promise<unknown>) => pending.push(p))).text()).toBe("tree");
  expect((await sw.handle(req("/api/auth/login", "POST"))).status).toBe(200);
  expect((await sw.handle(req("/__logout", "POST"))).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(20000);
}, 25000);

test("offline, a cached page whose scripts are not cached is not shown (no half-loaded shell)", async () => {
  const f = fixture();
  const page = '<script src="/app.js?v=abc"></script><script src="/gone.js?v=old"></script><main id="main">old</main>';
  f.network(async () => new Response(page, { headers: { "content-type": "text/html", "x-acard-id": id } }));
  await f.sw.install();
  await f.sw.handle(req("/one/"));
  f.offline();
  expect((await f.sw.handle(req("/one/"))).status).toBe(503);
  expect(shellRefs(page)).toEqual(["/app.js?v=abc", "/gone.js?v=old"]);
});

test("offline, a cached page whose scripts are all cached is shown", async () => {
  const f = fixture();
  f.network(async () => new Response('<script src="/app.js?v=abc"></script><main id="main">kept</main>', { headers: { "content-type": "text/html", "x-acard-id": id } }));
  await f.sw.install();
  await f.sw.handle(req("/one/"));
  f.offline();
  const r = await f.sw.handle(req("/one/"));
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("kept");
});

test("?sw=off wipes every cache, unregisters the worker and loads from the network", async () => {
  const caches = new MemoryCaches();
  let unregistered = 0;
  const sw = createOfflineWorker({ caches, origin, report: () => {}, unregister: async () => { unregistered++; }, fetch: async () => html("fresh") }, { version: "test", shell: ["/app.js?v=abc"] });
  await sw.install();
  await sw.handle(req("/one/"));
  await (await caches.open("acard-shell-old")).put(req("/x"), html());
  const r = await sw.handle(req("/one/?sw=off"));
  expect(await r.text()).toContain("fresh");
  expect(unregistered).toBe(1);
  expect(await caches.keys()).toEqual([]);
});

test("activate deletes caches of older worker versions only", async () => {
  const f = fixture();
  for (const name of ["acard-shell-old", "acard-pages-old", "acard-lru-old", "acard-recent-cache"]) await f.caches.open(name);
  await f.sw.install();
  await f.sw.activate();
  expect((await f.caches.keys()).sort()).toEqual([cacheName("shell")]);
});

test("network first updates content and offline HTML carries a status banner", async () => {
  const f = fixture();
  await f.sw.handle(req("/one/"));
  f.network(async () => html("new revision"));
  await f.sw.handle(req("/one/"));
  f.offline();
  const response = await f.sw.handle(req("/one/"));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-acard-offline")).toBe("1");
  const body = await response.text();
  expect(body).toContain("new revision");
  expect(body).toContain('id="acard-offline"');
});

test("API cache fallback preserves JSON and tree does not consume page slots", async () => {
  const f = fixture();
  f.network(async () => Response.json({ page: { title: "saved" } }, { headers: { "x-acard-id": id } }));
  await f.sw.handle(req("/api/page/one"));
  await f.sw.handle(req("/api/tree"));
  f.offline();
  expect(await (await f.sw.handle(req("/api/page/one"))).json()).toEqual({ page: { title: "saved" } });
  expect((await f.sw.handle(req("/api/tree"))).status).toBe(200);
  expect(await (await (await f.caches.open(cacheName("lru"))).match(origin + "/__offline_lru"))?.json()).toEqual(["one"]);
});

test("LRU retains fifty page groups and evicts HTML and API together", async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) {
    await f.sw.handle(req("/p" + i + "/"));
    await f.sw.handle(req("/api/page/p" + i));
  }
  f.offline();
  await f.sw.handle(req("/p0/"));
  f.network(async () => html());
  await f.sw.handle(req("/p50/"));
  f.offline();
  expect((await f.sw.handle(req("/p0/"))).status).toBe(200);
  expect((await f.sw.handle(req("/p1/"))).status).toBe(503);
  expect((await f.sw.handle(req("/api/page/p1"))).status).toBe(503);
  expect((await f.sw.handle(req("/p50/"))).status).toBe(200);
});

test("HTTP errors never become cached successes", async () => {
  for (const status of [401, 403, 404, 500]) {
    const f = fixture();
    await f.sw.handle(req("/one/"));
    f.network(async () => new Response("denied", { status }));
    const response = await f.sw.handle(req("/one/"));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("denied");
  }
});

test("401 evicts all private caches and cannot fall back after restart", async () => {
  const f = fixture();
  await f.sw.handle(req("/one/"));
  await f.sw.handle(req("/api/page/two"));
  f.network(async () => new Response("expired", { status: 401 }));
  expect((await f.sw.handle(req("/one/"))).status).toBe(401);
  f.offline();
  expect((await f.sw.handle(req("/api/page/two"))).status).toBe(503);
  expect(await f.caches.keys()).toEqual([]);
});

test("credentialless manifest failure does not expire an authenticated page cache", async () => {
  const f = fixture();
  await f.sw.handle(req("/one/"));
  f.network(async () => new Response("no cookie", { status: 401 }));
  await f.sw.handle(new Request(origin + "/manifest.webmanifest", { credentials: "omit" }));
  f.offline();
  expect((await f.sw.handle(req("/one/"))).status).toBe(200);
});

test("logout wipes every cache even when the network is offline", async () => {
  const f = fixture();
  await f.sw.install();
  await f.sw.handle(req("/one/"));
  await (await f.caches.open("other-feature")).put(req("/two/"), html());
  f.offline();
  await f.sw.handle(req("/__logout", "POST"));
  expect((await f.sw.handle(req("/one/"))).status).toBe(503);
  expect(await f.caches.keys()).toEqual([]);
});

test("in-flight successes cannot resurrect caches after logout", async () => {
  const f = fixture();
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  f.network(async request => {
    if (new URL(request.url).pathname === "/__logout") return new Response(null, { status: 303 });
    started.resolve();
    return response.promise;
  });
  const pending = f.sw.handle(req("/one/"));
  await started.promise;
  await f.sw.handle(req("/__logout", "POST"));
  response.resolve(html());
  await pending;
  expect(await f.caches.keys()).toEqual([]);
});

test("new login can cache pages again without restoring prior private content", async () => {
  const f = fixture();
  await f.sw.handle(req("/old/"));
  await f.sw.handle(req("/__logout", "POST"));
  await f.sw.handle(req("/__gate", "POST"));
  await f.sw.handle(req("/new/"));
  f.offline();
  expect((await f.sw.handle(req("/old/"))).status).toBe(503);
  expect((await f.sw.handle(req("/new/"))).status).toBe(200);
});

test("navigation login opaque redirect re-enables caching after logout", async () => {
  const f = fixture();
  await f.sw.handle(req("/__logout", "POST"));
  const redirect = new Response(null, { status: 303 });
  Object.defineProperties(redirect, { status: { value: 0 }, type: { value: "opaqueredirect" } });
  f.network(async () => redirect);
  await f.sw.handle(req("/__gate", "POST"));
  f.network(async () => html());
  await f.sw.handle(req("/new/"));
  f.offline();
  expect((await f.sw.handle(req("/new/"))).status).toBe(200);
});
