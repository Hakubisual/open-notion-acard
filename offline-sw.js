// Native CacheStorage policy. Kept outside client bundles and emitted as /sw.js.
export function route(request, origin) {
  const url = new URL(request.url);
  if (url.origin !== origin || request.method !== "GET") return null;
  // The reader's explicit refresh (?acard-revalidate=<now>) is a one-off network read; routing it would store one more
  // HTML copy per click under a unique key that the slug LRU never evicts.
  if (url.searchParams.has("acard-revalidate")) return null;
  const path = url.pathname;
  if (/^\/(?:__gate|__logout|api\/agents|mcp|sse|oauth|[ps](?:\/|$))/.test(path)) return null;
  const key = origin + path + url.search;
  if (path === "/api/tree" || path === "/api/folders/tree") return { kind: "tree", key };
  const api = /^\/api\/page\/([^/]+)$/.exec(path);
  if (api) return { kind: "page", slug: api[1], key };
  const edit = /^\/edit\/([^/.]+)\/$/.exec(path);
  if (edit) return { kind: "editor", slug: edit[1], key };
  if (path === "/") return { kind: "html", slug: "index", key };
  const page = /^\/([^/.]+)\/$/.exec(path);
  if (page && !/^(api|edit|print|media|agents)$/.test(page[1])) {
    return { kind: "html", slug: page[1], key };
  }
  return null;
}

export function shouldCache(request, response, origin, shell = []) {
  if (request.method !== "GET" || response.status !== 200 || response.redirected) return false;
  const url = new URL(request.url);
  const id = response.headers.get("x-acard-id");
  return url.origin === origin && ((member(id) && !!route(request, origin)) || shell.includes(url.pathname + url.search));
}

const identity = value => typeof value === "string" && /^(?:g-)?[0-9a-f]{16}$/.test(value) ? value : null;
const member = value => identity(value) && !value.startsWith("g-");
function swr(response, state) {
  const headers = new Headers(response.headers);
  headers.set("x-acard-swr", state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const message = "오프라인이에요. 저장해 둔 페이지만 볼 수 있어요.";
function missing(request) {
  const html = request.mode === "navigate" || request.headers.get("accept")?.includes("text/html");
  return new Response(html
    ? '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>오프라인 · Acard</title><style>html{color-scheme:light dark}body{margin:0;font:16px/1.85 system-ui,sans-serif;background:light-dark(#fff,#191e26);color:light-dark(#202733,#edf2f9)}main{max-width:480px;margin:20vh auto;padding:24px}h1{font-size:28px;line-height:1.25}p{color:light-dark(#606c7c,#a4afbf)}</style><main><h1>오프라인이에요.</h1><p>저장해 둔 페이지만 볼 수 있어요.</p></main></html>'
    : JSON.stringify({ error: message }), {
    status: 503, headers: { "content-type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function cachedResponse(response, kind) {
  const headers = new Headers(response.headers);
  headers.set("x-acard-offline", "1");
  headers.set("cache-control", "no-store");
  if (kind !== "html") return new Response(response.body, { headers });
  headers.delete("content-length");
  headers.delete("content-encoding");
  const banner = '<aside id="acard-offline" role="status" style="padding:12px 16px;margin:0 0 16px;border-radius:12px;background:var(--mint,var(--bg-soft));color:var(--fg);font:14px/1.5 system-ui,sans-serif">오프라인 · 저장된 페이지예요</aside>';
  const html = (await response.text()).replace(/(<main\b[^>]*>)/i, "$1" + banner);
  return new Response(html, { headers });
}

// A broken or locked CacheStorage must never hold a page, a sign-in or a save: every cache step gives up after this long.
export const CACHE_STEP_MS = 2000;
export function bounded(work, fallback, ms = CACHE_STEP_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(work).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Top-level scripts and styles a cached HTML page needs (the precached shell; lazy chunks load on demand). Offline, a page is shown only when all of them are cached,
// so an old shell never loads with its scripts missing.
export function shellRefs(html) {
  return [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["'](\/[\w./-]+\.(?:js|css)\?v=[^"']+)["']/gi)].map(m => m[1]);
}

async function syncImported(response) {
  const count = value => typeof value === "number" ? value : Infinity;
  const result = await response.clone().json();
  return count(result.imported) > 0 || count(result.updated) > 0
    || (result.databases != null && (count(result.databases.imported) > 0 || count(result.databases.rows) > 0));
}

export function createOfflineWorker(platform, config) {
  const { caches, origin } = platform;
  const assets = config.shell.concat(config.lazy || []);
  const nameFor = (kind, id) => "acard-" + kind + "-" + config.version + "-" + id;
  const orderKey = origin + "/__offline_lru";
  const clients = new Map();
  let current = null, generation = 0, pending = Promise.resolve();
  // CacheStorage read/modify/write is not atomic. Serialize mutations and fence
  // network responses started before logout/401 so they cannot refill the cache.
  // A step that never settles is dropped after CACHE_STEP_MS so the chain behind it keeps moving.
  function serial(work) {
    const result = pending.then(work);
    pending = bounded(result.catch(error => platform.report(error)), undefined);
    return result;
  }
  const later = (waitUntil, work) => { const run = bounded(work, undefined); if (waitUntil) waitUntil(run); return run; };
  function wipe() {
    generation++;
    current = null;
    clients.clear();
    return serial(async () => {
      for (const name of await caches.keys()) await caches.delete(name);
    });
  }
  function identify(value, clientId = "") {
    const id = identity(value);
    if (id && id === current) { clients.set(clientId, id); return Promise.resolve(); }
    generation++;
    current = id;
    clients.clear();
    clients.set(clientId, id);
    return serial(async () => {
      for (const name of await caches.keys()) if (!id || !name.endsWith("-" + id)) await caches.delete(name);
    });
  }
  const owns = (id, epoch, clientId) => !!id && current === id && epoch === generation && clients.get(clientId) === id;
  async function observe(response, request, epoch, clientId) {
    // A late response from before a logout/account switch cannot change the current identity either.
    if (epoch !== generation) return false;
    const url = new URL(request.url), path = url.pathname;
    // The reader's ?acard-revalidate refresh is not routed (never cached) but is still a private page read.
    const reader = route(request, origin) || url.searchParams.has("acard-revalidate");
    const privateRequest = reader || /^\/(?:api|edit)\//.test(path) || request.mode === "navigate" || assets.includes(path + url.search);
    // Credentialless manifest/icon failures do not describe the member session.
    if (response.status === 401 && privateRequest && request.credentials !== "omit") {
      await bounded(wipe(), undefined);
      tell({ type: "acard-auth" });
      return false;
    }
    const id = identity(response.headers.get("x-acard-id"));
    if (id || reader) await bounded(identify(id, clientId), undefined);
    return true;
  }
  async function touch(cache, info, id) {
    if (!info.slug) return;
    const meta = await caches.open(nameFor("lru", id));
    const stored = await meta.match(orderKey);
    const order = stored ? await stored.json() : [];
    const next = order.filter(slug => slug !== info.slug).concat(info.slug);
    const expired = next.splice(0, Math.max(0, next.length - 50));
    for (const key of await cache.keys()) {
      if (expired.includes(route(key, origin)?.slug)) await cache.delete(key);
    }
    await meta.put(orderKey, new Response(JSON.stringify(next)));
  }
  const tell = (message, id) => { try { platform.notify?.(message, id); } catch (error) { platform.report(error); } };
  // Stale-while-revalidate: a cached page or tree answers at once, the network refresh runs behind it and the
  // page hears "acard-fresh" only when the body actually changed. Logout/401 fences it like the network-first path.
  async function revalidate(request, info, cached, epoch, id, clientId) {
    tell({ type: "acard-sync", on: true, url: request.url }, id);
    try {
      const response = await platform.fetch(request);
      if (!(await observe(response, request, epoch, clientId))) return;
      if (!owns(id, epoch, clientId)) { tell({ type: "acard-auth" }); return; }
      if (!shouldCache(request, response, origin, assets)) {
        await serial(async () => {
          if (owns(id, epoch, clientId) && await caches.has(nameFor("pages", id))) await (await caches.open(nameFor("pages", id))).delete(info.key);
        });
        if (info.kind === "html") tell({ type: "acard-fresh", kind: info.kind, url: request.url, etag: response.headers.get("etag") }, id);
        return;
      }
      const body = await response.clone().text();
      if (!owns(id, epoch, clientId)) return;
      await serial(async () => {
        if (!owns(id, epoch, clientId)) return;
        const cache = await caches.open(nameFor("pages", id));
        await cache.put(info.key, response);
        await touch(cache, info, id);
      });
      if (owns(id, epoch, clientId) && body !== cached) tell({ type: "acard-fresh", kind: info.kind, url: request.url, etag: response.headers.get("etag") }, id);
    } catch { /* offline: the cached copy stays */ }
    finally { tell({ type: "acard-sync", on: false, url: request.url }, id); }
  }
  async function handle(request, waitUntil, clientId = "", resultingClientId = "") {
    const url = new URL(request.url);
    if (url.origin !== origin) return platform.fetch(request);
    // Kill switch: any page opened with ?sw=off clears every cache and removes this worker, then loads from the network.
    if (url.searchParams.get("sw") === "off" && request.method === "GET") {
      await bounded(wipe(), undefined);
      await bounded(platform.unregister?.(), undefined);
      return platform.fetch(request);
    }
    if (/^\/(?:api\/auth\/|s\/|__logout(?:\/|$))/.test(url.pathname) || (url.pathname === "/__gate" && request.method === "POST")) {
      // Wipe before the transition, including GET OAuth/confirm callbacks and guest entry/exit.
      await bounded(wipe(), undefined);
      const epoch = generation;
      try {
        const response = await platform.fetch(request);
        await observe(response, request, epoch, resultingClientId || clientId);
        return response;
      } catch { return missing(request); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      // A write makes cached reader HTML and the tree stale (titles, sidebar); drop them before the next read so a
      // reload after the write never shows the old copy. Page JSON is network-first and keeps its offline copy.
      const epoch = generation;
      const response = await platform.fetch(request);
      if (!(await observe(response, request, epoch, clientId))) return response;
      // Telemetry posts (Cloudflare RUM, beta events) fire on every load and change no content.
      let contentWrite = /^\/(?:api|edit)\//.test(url.pathname) && !/^\/api\/(?:beta|agent)\//.test(url.pathname);
      // The editor posts /api/sync on every open and for members it imports nothing: only a sync that reports an import
      // changes content. The answer is read from a clone; an unreadable or incomplete one counts as a write.
      if (response.ok && contentWrite && url.pathname === "/api/sync") contentWrite = await bounded(syncImported(response), true);
      // A refresh started before this write would put the old tree back (folder fold lost on reload, #14): fence it.
      if (response.ok && contentWrite) generation++;
      if (response.ok && contentWrite) {
        const pagesName = nameFor("pages", current);
        await bounded(serial(async () => {
          if (!(await caches.has(pagesName))) return;
          const cache = await caches.open(pagesName);
          const pageSave = /^(PUT|PATCH)$/.test(request.method) && /^\/api\/page\/[^/]+(?:\/blocks)?$/.test(url.pathname);
          for (const key of await cache.keys()) {
            const kind = route(key, origin)?.kind;
            if (kind !== "page" && !(pageSave && kind === "editor")) await cache.delete(key);
          }
        }), undefined);
      }
      return response;
    }
    const info = route(request, origin);
    const shell = request.method === "GET" && assets.includes(url.pathname + url.search);
    // The readable acard_id cookie names the session the browser will actually send. If it differs from the identity
    // this worker remembers (a session changed by a route the worker never saw), switch to it before touching a cache.
    // undefined = the platform cannot read cookies; null = no identity cookie, so nothing private is served from cache.
    const cookieId = info || shell ? await bounded(Promise.resolve(platform.cookieId?.()), undefined) : undefined;
    if (cookieId !== undefined && identity(cookieId) && cookieId !== clients.get(clientId)) await bounded(identify(cookieId, clientId), undefined);
    const epoch = generation;
    const id = clients.get(clientId);
    const cookieOk = cookieId === undefined || cookieId === id;
    const pagesName = nameFor("pages", id), shellName = nameFor("shell", id);
    async function readCached() {
      if (!cookieOk || !owns(id, epoch, clientId) || (info && !member(id))) return null;
      const name = shell ? shellName : pagesName;
      if (!(await caches.has(name))) return null;
      const cache = await caches.open(name);
      const hit = await cache.match(info ? info.key : request);
      if (!hit || (info && hit.headers.get("x-acard-id") !== id)) return null;
      if (info?.kind === "html" || info?.kind === "editor") {
        const refs = shellRefs(await hit.clone().text());
        const assets = refs.length && await caches.has(shellName) ? await caches.open(shellName) : null;
        for (const ref of refs) if (!assets || !(await assets.match(origin + ref))) return null;
      }
      if (!owns(id, epoch, clientId)) return null;
      if (info) await touch(cache, info, id);
      return owns(id, epoch, clientId) ? hit : null;
    }
    // Only a known member client can use SWR. Page JSON and editor documents stay network-first.
    if (info && info.kind !== "page" && info.kind !== "editor" && waitUntil && member(id)) {
      const hit = await bounded(serial(readCached), null);
      if (hit) {
        const text = await hit.clone().text();
        if (!owns(id, epoch, clientId)) return handle(request, waitUntil, clientId, resultingClientId);
        if (resultingClientId) clients.set(resultingClientId, id);
        waitUntil(revalidate(request, info, text, epoch, id, clientId));
        return swr(hit, "hit");
      }
    }
    let response;
    try { response = await platform.fetch(request); }
    catch {
      if (!info && !shell) return missing(request);
      return bounded(serial(async () => {
        const cached = await readCached();
        if (!cached) return missing(request);
        if (resultingClientId) clients.set(resultingClientId, id);
        const fallback = await cachedResponse(cached, info?.kind);
        return info?.kind === "html" ? swr(fallback, "hit") : fallback;
      }), missing(request));
    }
    const observed = await observe(response, request, epoch, clientId);
    const nextId = clients.get(clientId), nextEpoch = generation;
    if (observed && resultingClientId) clients.set(resultingClientId, nextId);
    if (observed && owns(nextId, nextEpoch, clientId) && shouldCache(request, response, origin, assets)) {
      // The page gets its response now; the offline copy is written behind it.
      const copy = response.clone();
      const stored = later(waitUntil, serial(async () => {
        if (!owns(nextId, nextEpoch, clientId)) return;
        const cache = await caches.open(nameFor(shell ? "shell" : "pages", nextId));
        await cache.put(info ? info.key : request, copy);
        if (info) await touch(cache, info, nextId);
      }));
      if (!waitUntil) await stored;
    }
    return info?.kind === "html" ? swr(response, "miss") : response;
  }
  return {
    handle, wipe, identify: (id, clientId) => bounded(identify(id, clientId), undefined),
    identity: clientId => clients.get(clientId),
    async install() {
      // Precache the shell files this account can read (members get 404 for owner-only images). A file that fails is skipped:
      // an install that throws leaves whatever older worker the browser has in control for good.
      // HTML and private API data are not precached.
      const epoch = generation;
      const entries = (await Promise.all(config.shell.map(async path => {
        const request = new Request(origin + path, { cache: "reload", credentials: "same-origin" });
        try {
          const response = await platform.fetch(request);
          return identity(response.headers.get("x-acard-id")) && shouldCache(request, response, origin, config.shell) ? [request, response] : null;
        } catch { return null; }
      }))).filter(Boolean);
      if (!entries.length || epoch !== generation) return;
      const id = identity(entries[0][1].headers.get("x-acard-id"));
      await bounded(identify(id), undefined);
      const nextEpoch = generation;
      await bounded(serial(async () => {
        if (!owns(id, nextEpoch, "")) return;
        const cache = await caches.open(nameFor("shell", id));
        for (const [request, response] of entries) if (response.headers.get("x-acard-id") === id) await cache.put(request, response);
      }), undefined, 10000);
    },
    async activate() {
      await bounded((async () => {
        for (const name of await caches.keys()) {
          if (name === "acard-recent-cache" || (/^acard-(shell|pages|lru)-/.test(name) && !["shell", "pages", "lru"].some(kind => name.startsWith("acard-" + kind + "-" + config.version + "-") && identity(name.slice(("acard-" + kind + "-" + config.version + "-").length))))) await caches.delete(name);
        }
      })(), undefined);
    },
  };
}
