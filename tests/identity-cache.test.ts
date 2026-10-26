import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createOfflineWorker } from "../offline-sw.js";
import { redirect, withCookies } from "../gate/account";
import { ACCESS_COOKIE } from "../gate/tenancy";

const origin = "https://notes.test", A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb";
const req = (path: string, method = "GET") => new Request(origin + path, { method });
class Cache {
  entries = new Map<string, Response>();
  key(input: Request | string) { return typeof input === "string" ? input : input.url; }
  async put(input: Request | string, response: Response) { this.entries.set(this.key(input), response.clone()); }
  async match(input: Request | string) { return this.entries.get(this.key(input))?.clone(); }
  async delete(input: Request | string) { return this.entries.delete(this.key(input)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}
class Caches {
  stores = new Map<string, Cache>();
  async open(name: string) { let c = this.stores.get(name); if (!c) { c = new Cache(); this.stores.set(name, c); } return c; }
  async has(name: string) { return this.stores.has(name); }
  async keys() { return [...this.stores.keys()]; }
  async delete(name: string) { return this.stores.delete(name); }
}
function fixture(caches = new Caches(), cookie?: () => string | null | undefined) {
  let id: string | null = A, body = "A private", status = 200, offline = false;
  let network: ((r: Request) => Promise<Response>) | null = null;
  const pending: Promise<unknown>[] = [], messages: any[] = [];
  const sw = createOfflineWorker({ caches, origin, cookieId: cookie, report: (error: unknown) => { throw error; }, notify: (m: unknown) => messages.push(m), fetch: async (r: Request) => {
    if (network) return network(r);
    if (offline) throw new TypeError("offline");
    return new Response(body, { status, headers: id ? { "x-acard-id": id, etag: '"' + body + '"' } : {} });
  } }, { version: "test", shell: [] });
  return { sw, caches, messages, handle: (r: Request, client = "tab") => sw.handle(r, (p: Promise<unknown>) => pending.push(p), client),
    settle: () => Promise.all(pending.splice(0)), set(next: { id?: string | null; body?: string; status?: number; offline?: boolean }) {
      if ("id" in next) id = next.id!;
      if (next.body !== undefined) body = next.body;
      if (next.status !== undefined) status = next.status;
      if (next.offline !== undefined) offline = next.offline;
    }, network(fn: (r: Request) => Promise<Response>) { network = fn; } };
}

test("an identity change wipes old SW and recent caches, and A's entry never answers B", async () => {
  const f = fixture();
  await f.handle(req("/one/"), "A-tab"); await f.settle();
  await f.caches.open("acard-recent-cache-" + A);
  await f.sw.identify(B, "B-tab");
  expect(await f.caches.keys()).toEqual([]);
  f.set({ offline: true });
  expect((await f.handle(req("/one/"), "B-tab")).status).toBe(503);
  expect((await f.handle(req("/one/"), "A-tab")).status).toBe(503);
});

test("network identity on an uncached API changes the account and deletes other namespaces", async () => {
  const f = fixture();
  await f.handle(req("/one/")); await f.settle();
  f.set({ id: B, body: "B private" });
  await f.handle(req("/api/me"));
  expect(f.sw.identity("tab")).toBe(B);
  expect(await f.caches.keys()).toEqual([]);
  await f.handle(req("/one/")); await f.settle();
  expect((await f.caches.keys()).every(name => name.endsWith("-" + B))).toBe(true);
  f.set({ offline: true });
  expect(await (await f.handle(req("/one/"))).text()).toBe("B private");
  await f.settle();
});

test("401 on writes as well as reads wipes and fences private cache fallback", async () => {
  for (const [path, method] of [["/api/page/one", "GET"], ["/api/page/one", "PUT"]]) {
    const f = fixture();
    await f.handle(req("/one/")); await f.settle();
    f.set({ status: 401 });
    expect((await f.handle(req(path, method))).status).toBe(401);
    expect(await f.caches.keys()).toEqual([]);
    f.set({ offline: true });
    expect((await f.handle(req("/one/"))).status).toBe(503);
  }
});

test("guests and anonymous clients never cache HTML, trees or edit-base JSON", async () => {
  for (const id of ["g-" + A, null]) {
    const f = fixture();
    await f.handle(req("/one/")); await f.settle();
    f.set({ id, body: "guest" });
    await f.sw.identify(id, "tab");
    for (const path of ["/one/", "/", "/api/page/one", "/api/tree"]) {
      expect(await (await f.handle(req(path))).text()).toBe("guest");
      await f.settle();
    }
    expect(await f.caches.keys()).toEqual([]);
    f.set({ offline: true });
    for (const path of ["/one/", "/api/page/one"]) expect((await f.handle(req(path))).status).toBe(503);
  }
});

test("query variants do not overwrite the base reader, page JSON or tree key", async () => {
  for (const path of ["/one/", "/api/page/one", "/api/tree"]) {
    const f = fixture();
    await f.handle(req(path)); await f.settle();
    f.set({ body: "variant" });
    await f.handle(req(path + "?view=board")); await f.settle();
    f.set({ offline: true });
    expect(await (await f.handle(req(path))).text()).toBe("A private");
    expect(await (await f.handle(req(path + "?view=board"))).text()).toBe("variant");
    await f.settle();
  }
});

test("a restarted worker requires the requesting client's posted identity before offline reuse", async () => {
  const f = fixture();
  await f.handle(req("/one/")); await f.settle();
  const restarted = fixture(f.caches);
  restarted.set({ offline: true });
  expect((await restarted.handle(req("/one/"))).status).toBe(503);
  await restarted.sw.identify(A, "tab");
  expect(await (await restarted.handle(req("/one/"))).text()).toBe("A private");
  expect((await restarted.handle(req("/one/"), "unknown-tab")).status).toBe(503);
  await restarted.settle();
});

test("GET auth callbacks, guest entry/exit and logout wipe even without network", async () => {
  for (const [path, method] of [["/api/auth/confirm?token_hash=x", "GET"], ["/api/auth/callback?code=x", "GET"], ["/s/o/i/token", "GET"], ["/s/o/logout", "POST"], ["/__logout", "POST"]]) {
    const f = fixture();
    await f.handle(req("/one/")); await f.settle();
    f.set({ offline: true });
    await f.handle(req(path, method));
    expect(await f.caches.keys()).toEqual([]);
    expect((await f.handle(req("/one/"))).status).toBe(503);
  }
});

test("an in-flight old identity response cannot restore its identity after a switch", async () => {
  const f = fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  await f.sw.identify(A, "tab");
  f.network(async () => { started.resolve(); return response.promise; });
  const run = f.handle(req("/api/page/one"));
  await started.promise;
  await f.sw.identify(B, "other");
  response.resolve(new Response("A", { headers: { "x-acard-id": A } }));
  await run; await f.settle();
  expect(f.sw.identity("other")).toBe(B);
  expect(f.sw.identity("tab")).toBeUndefined();
  expect(await f.caches.keys()).toEqual([]);
});

test("reader navigation responds before its network gate, while editor and page JSON wait", async () => {
  for (const path of ["/", "/one/", "/edit/one/", "/api/page/one"]) {
    const f = fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
    await f.handle(req(path)); await f.settle();
    f.network(async () => { started.resolve(); return response.promise; });
    let answered = false;
    const run = f.handle(new Request(origin + path, { headers: { "x-acard-nav": "1" } })).then(r => { answered = true; return r; });
    await started.promise;
    if (path === "/" || path === "/one/") {
      const hit = await run;
      expect(hit.headers.get("x-acard-swr")).toBe("hit");
      expect(await hit.text()).toBe("A private");
    } else expect(answered).toBe(false);
    response.resolve(new Response("fresh", { headers: { "x-acard-id": A } }));
    if (path.startsWith("/edit/") || path.startsWith("/api/")) expect(await (await run).text()).toBe("fresh");
    await f.settle();
  }
});

test("page JSON offline fallback is explicitly marked as an invalid edit base", async () => {
  const f = fixture();
  await f.handle(req("/api/page/one")); await f.settle();
  f.set({ offline: true });
  expect((await f.handle(req("/api/page/one"))).headers.get("x-acard-offline")).toBe("1");
});

test("account cookie transitions clear HTTP cache, not pending drafts", () => {
  for (const response of [redirect("/", [ACCESS_COOKIE + "=new"]), withCookies(Response.json({ ok: true }), [ACCESS_COOKIE + "=; Max-Age=0"])]) {
    expect(response.headers.get("clear-site-data")).toBe('"cache"');
  }
  expect(redirect("/").headers.has("clear-site-data")).toBe(false);
});

test("controlling page posts the meta identity on load and controller replacement", async () => {
  const source = await Bun.file(new URL("../assets/features/offline-sw.shared.js", import.meta.url)).text();
  const messages: unknown[] = [], events = new Map<string, () => void>();
  let id = A;
  const context = { window: { AcardReader: {}, addEventListener() {} }, document: { querySelector: () => ({ content: id }), addEventListener() {} }, navigator: { serviceWorker: {
    controller: { postMessage: (m: unknown) => messages.push(m) }, addEventListener: (name: string, fn: () => void) => events.set(name, fn), register: async () => ({}),
  } }, localStorage: { getItem: () => id, setItem() {}, removeItem() {} } };
  runInNewContext(source, context);
  expect(messages).toEqual([{ type: "acard-id", id: A }]);
  id = B; events.get("controllerchange")!();
  expect(messages[1]).toEqual({ type: "acard-id", id: B });
});

test("guest invite documents and logout redirects clear browser caches", async () => {
  const source = await Bun.file(new URL("../features/share.js", import.meta.url)).text();
  let feature: any;
  runInNewContext(source, { Response, registerFeature: (value: unknown) => { feature = value; }, escapeHtml: (value: string) => value });
  const share = feature.publicRoutes[1];
  for (const [path, method] of [["/s/i/" + "a".repeat(43), "GET"], ["/s/logout", "POST"]]) {
    const response = await share({ path, method, request: req(path, method), db: {}, env: {} });
    expect(response.headers.get("clear-site-data")).toBe('"cache"');
    expect(response.status).toBe(method === "GET" ? 200 : 303);
  }
});

test("recent editor previews are identity scoped and guest or missing identities never persist", async () => {
  const source = await Bun.file(new URL("../assets/features/lazy/recent-cache.js", import.meta.url)).text();
  const caches = new Caches();
  const stored = (value: string) => new Response(JSON.stringify([{ key: "/page/one", value: { title: value } }]));
  await (await caches.open("acard-recent-cache-" + A)).put("/__recent-cache", stored("A private"));
  for (const id of [B, "g-" + A, null]) {
    const server = Promise.withResolvers<any>(), cached = Promise.withResolvers<void>();
    const preview: unknown[] = [], locks: Promise<unknown>[] = [];
    const doc = { inert: false, replaceChildren() {} }, listeners = new Map();
    const editor = { slug: "one", state: {}, setSave() {}, provide() {}, api: async () => ({ pages: [] }) };
    const document = { cookie: id ? "acard_id=" + id : "", querySelector: () => id ? { content: id } : null, getElementById: () => doc, documentElement: { dataset: {} } };
    const context: any = { Response, Promise, document, caches, localStorage: { getItem: () => "epoch" }, navigator: { locks: { request: (_name: string, fn: () => Promise<unknown>) => {
      const work = fn(); locks.push(work); work.then(() => cached.resolve()); return work;
    } } }, setTimeout: () => 1, location: { replace() {} }, AcardEditor: editor, addEventListener: (name: string, fn: unknown) => listeners.set(name, fn) };
    context.window = context;
    runInNewContext(source, context);
    const load = context.AcardRecentCache.load(server.promise, (value: unknown) => preview.push(value), () => {});
    if (id === B) await cached.promise;
    server.resolve({ title: "fresh" });
    await load;
    await Promise.all(locks);
    expect(preview).toEqual([]);
    const keys = await caches.keys();
    expect(keys).not.toContain("acard-recent-cache-" + A);
    expect(keys.every(name => name === "acard-recent-cache-" + B)).toBe(true);
  }
});

test("a session changed behind the worker's back (cookie replaced) never gets the old account's cached page", async () => {
  let cookie: string | null = A;
  const f = fixture(new Caches(), () => cookie);
  await f.handle(req("/one/")); await f.settle();
  expect((await f.handle(req("/one/"))).headers.get("x-acard-swr")).toBe("hit");
  // B's session cookies arrive without the worker seeing any auth route; the server answers for B.
  cookie = B; f.set({ id: B, body: "B private" });
  const res = await f.handle(req("/one/"));
  expect(await res.text()).toBe("B private");
  expect(res.headers.get("x-acard-swr")).not.toBe("hit");
  expect((await f.caches.keys()).some(name => name.endsWith("-" + A))).toBe(false);
});

test("no identity cookie (signed out elsewhere) means no cached private page, even offline", async () => {
  let cookie: string | null = A;
  const f = fixture(new Caches(), () => cookie);
  await f.handle(req("/one/")); await f.settle();
  cookie = null; f.set({ offline: true });
  expect((await f.handle(req("/one/"))).status).toBe(503);
});
