// Single place that decides which data a request may touch.
// Owner workspace = the original D1 + KV + build assets. Any other signed-in account gets an env whose
// DB is its own Durable Object SQLite and whose MEDIA keys are prefixed, so app code cannot reach owner data.

export const OWNER_WS = "owner";

type Kv = {
  putStream?(key: string, body: ReadableStream, metadata: Record<string, unknown>): Promise<unknown>;
  r2Object?(key: string, options?: unknown): Promise<unknown>;
  r2Head?(key: string): Promise<unknown>;
  get(key: string, options?: unknown): Promise<unknown>;
  getWithMetadata(key: string, options?: unknown): Promise<{ value: unknown; metadata: unknown }>;
  put(key: string, value: unknown, options?: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};
type PipeItem = { sql: string; params: unknown[]; mode: string } | { batch: { sql: string; params: unknown[] }[] };
type PipeOut = { ok: true; value: any } | { ok: false; error: string };
type StoreStub = {
  exec(sql: string, params: unknown[], mode: string): Promise<any>;
  batch(list: { sql: string; params: unknown[] }[]): Promise<any[]>;
  pipe(items: PipeItem[]): Promise<PipeOut[]>;
  wipe(): Promise<unknown>;
  stats(): Promise<Record<string, number>>;
  hit(key: string, limit: number, period: number): Promise<boolean>;
};
type StoreNamespace = { idFromName(name: string): unknown; get(id: unknown): StoreStub };
type Assets = { fetch(request: Request): Promise<Response> };

export type TenancyEnv = {
  readonly DB?: unknown;
  readonly MEDIA?: Kv;
  readonly ASSETS: Assets;
  readonly WORKSPACE?: StoreNamespace;
  readonly OWNER_USER_ID?: string;
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_ANON_KEY?: string;
  readonly ACARD_LIVE_TRACK?: <T>(ws: string, db: T) => T;
  // Per-request count and time of the member store's pipe() calls (gate/agent-entry.ts Server-Timing).
  readonly ACARD_DB_TIMING?: { n: number; ms: number; first: number };
};

export function workspaceIdFor(userId: string, env: TenancyEnv): string {
  if (env.OWNER_USER_ID && userId === env.OWNER_USER_ID) return OWNER_WS;
  const hex = userId.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("bad user id");
  return hex;
}

export function storeFor(env: TenancyEnv, ws: string): StoreStub {
  if (!env.WORKSPACE) throw new Error("workspace store is not bound");
  if (ws === OWNER_WS || !/^[0-9a-f]{32}$/.test(ws)) throw new Error("not a member workspace");
  return env.WORKSPACE.get(env.WORKSPACE.idFromName("ws:" + ws));
}

// Every call to the workspace store is a network round trip (5-60+ ms depending on where the Worker and the store run),
// so a request costs (round trips x that delay). The adapter keeps that number small:
// - statements started in the same tick (Promise.all) travel in one pipe() call;
// - schema setup (CREATE ... IF NOT EXISTS, ALTER ... ADD COLUMN) is answered at once and sent ahead of the next real
//   statement for this store, so a fresh isolate no longer pays ~30 serial round trips before its first read.
const DDL = /^\s*(?:create\s+(?:unique\s+)?(?:virtual\s+)?(?:table|index|trigger)\s+if\s+not\s+exists|drop\s+(?:trigger|index)\s+if\s+exists|alter\s+table\s+\S+\s+add\s+column)\b/i;
const DONE = { results: [], success: true, meta: { changes: 0 } };
const pendingDdl = new Map<string, PipeItem[]>();
const ddlInFlight = new Map<string, Promise<unknown>>();

export function d1Adapter(stub: StoreStub, key: string, timing?: { n: number; ms: number; first: number }) {
  let queue: { item: PipeItem; resolve(value: any): void; reject(error: unknown): void }[] = [];
  const flush = async () => {
    const t0 = Date.now();
    const measured = () => { if (!timing) return; const spent = Date.now() - t0; if (timing.n === 0) timing.first = spent; timing.n += 1; timing.ms += spent; };
    const taken = queue;
    queue = [];
    const ddl = pendingDdl.get(key) ?? [];
    pendingDdl.delete(key);
    // A read must not overtake the call that creates its tables.
    const before = ddlInFlight.get(key);
    if (before) await before;
    const sent = stub.pipe([...ddl, ...taken.map((t) => t.item)]);
    if (ddl.length) {
      const settled = sent.then(() => undefined, () => undefined);
      ddlInFlight.set(key, settled);
      void settled.then(() => { if (ddlInFlight.get(key) === settled) ddlInFlight.delete(key); });
    }
    let out: PipeOut[];
    try {
      out = await sent;
    } catch (error) {
      measured();
      if (ddl.length) pendingDdl.set(key, [...ddl, ...(pendingDdl.get(key) ?? [])]);
      for (const t of taken) t.reject(error);
      return;
    }
    measured();
    out.slice(0, ddl.length).forEach((r) => {
      if (!r.ok && !/duplicate column/i.test(r.error)) console.error("acard workspace schema step failed", key, r.error);
    });
    out.slice(ddl.length).forEach((r, i) => (r.ok ? taken[i].resolve(r.value) : taken[i].reject(new Error(r.error))));
  };
  const send = (item: PipeItem) => new Promise<any>((resolve, reject) => {
    if (!queue.length) queueMicrotask(() => void flush());
    queue.push({ item, resolve, reject });
  });
  const defer = (item: PipeItem) => { pendingDdl.set(key, [...(pendingDdl.get(key) ?? []), item]); };
  const exec = (sql: string, params: unknown[], mode: string) => {
    if (DDL.test(sql)) { defer({ sql, params, mode }); return Promise.resolve(mode === "first" ? null : DONE); }
    return send({ sql, params, mode });
  };
  const statement = (sql: string, params: unknown[] = []): any => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: () => exec(sql, params, "run"),
    all: () => exec(sql, params, "all"),
    first: async (column?: string) => {
      const row = await exec(sql, params, "first");
      return column ? (row ? row[column] ?? null : null) : row;
    },
  });
  return {
    acardKey: key,
    prepare: (sql: string) => statement(sql),
    batch: (list: { sql: string; params: unknown[] }[]) => {
      const batch = list.map((item) => ({ sql: item.sql, params: item.params }));
      if (batch.length && batch.every((item) => DDL.test(item.sql))) { defer({ batch }); return Promise.resolve(batch.map(() => DONE)); }
      return send({ batch });
    },
  };
}

export function prefixedKv(kv: Kv, prefix: string): Kv {
  return {
    ...(kv.putStream ? { putStream: (key: string, body: ReadableStream, metadata: Record<string, unknown>) => kv.putStream!(prefix + key, body, metadata) } : {}),
    ...(kv.r2Object ? { r2Object: (key: string, options?: unknown) => kv.r2Object!(prefix + key, options) } : {}),
    ...(kv.r2Head ? { r2Head: (key: string) => kv.r2Head!(prefix + key) } : {}),
    get: (key, options) => kv.get(prefix + key, options),
    getWithMetadata: (key, options) => kv.getWithMetadata(prefix + key, options),
    put: (key, value, options) => kv.put(prefix + key, value, options),
    delete: (key) => kv.delete(prefix + key),
    list: async (options = {}) => {
      const result = await kv.list({ ...options, prefix: prefix + (options.prefix ?? "") });
      return { ...result, keys: result.keys.map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) })) };
    },
  };
}

// Build output also contains the owner's notes (page HTML, seeds, search index, covers, avatars).
// Other workspaces only get the app shell files. The font files under /fonts/ are app shell too: the local server
// (desktop app, self-host edition) reads every asset through here, and style.css loads /fonts/pretendard-core.woff2 (#145).
const MEMBER_ASSET = /^\/(?:[\w.-]+\.(?:css|js|svg|png|ico|webmanifest)|templates-seed\.json|editor\.html|agents\.html|acard-cli\.tgz|lazy\/[\w.-]+\.(?:css|js)|fonts\/(?:lib\/[a-z]+|fonts|serif)\.css|fonts\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.woff2|_site\/[\w.-]+)$/;
const OWNER_ONLY_ROOT = new Set(["/notes-seed.json", "/db-seed.json", "/search-index.json", "/index.html", "/404.html"]);

export function memberAssetAllowed(pathname: string): boolean {
  return !OWNER_ONLY_ROOT.has(pathname) && MEMBER_ASSET.test(pathname);
}

export function memberAssets(assets: Assets): Assets {
  return {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (!memberAssetAllowed(path)) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
      return assets.fetch(request);
    },
  };
}

export function mediaPrefix(ws: string): string {
  return "ws/" + ws + "/";
}

export function workspaceEnv<E extends TenancyEnv>(env: E, ws: string): E {
  if (ws === OWNER_WS) return { ...env, ACARD_SESSION: "owner", ACARD_WORKSPACE: OWNER_WS };
  return {
    ...env,
    DB: env.ACARD_LIVE_TRACK ? env.ACARD_LIVE_TRACK(ws, d1Adapter(storeFor(env, ws), "ws:" + ws, env.ACARD_DB_TIMING)) : d1Adapter(storeFor(env, ws), "ws:" + ws, env.ACARD_DB_TIMING),
    MEDIA: env.MEDIA ? prefixedKv(env.MEDIA, mediaPrefix(ws)) : undefined,
    ASSETS: memberAssets(env.ASSETS),
    ACARD_SESSION: "member",
    ACARD_WORKSPACE: ws,
    ACARD_SHARE_PREFIX: "/p/m" + ws + "/",
  };
}

export const MEMBER_SHARE = /^\/p\/m([0-9a-f]{32})(\/[A-Za-z0-9_-]{43}(?:\/media\/[0-9a-f]{16}(?:\/(?:480|960|1440)\.(?:avif|webp))?|(?:\/[^/]+)?(?:\/frame\/[^/]+)?\/?)?)$/;

export async function wipeWorkspace(env: TenancyEnv, ws: string): Promise<{ media: number }> {
  if (ws === OWNER_WS) throw new Error("refusing to wipe the owner workspace");
  await storeFor(env, ws).wipe();
  let media = 0;
  if (env.MEDIA) {
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix: mediaPrefix(ws), cursor });
      for (const key of page.keys) { await env.MEDIA.delete(key.name); media += 1; }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  return { media };
}

const MEMBER_TOKEN = /^acard_m([0-9a-f]{32})_([A-Za-z0-9_-]{20,})$/;

export function memberToken(ws: string, raw: string): string {
  if (!raw.startsWith("acard_")) throw new Error("unexpected token shape");
  return "acard_m" + ws + "_" + raw.slice("acard_".length);
}

export function parseToken(raw: string): { ws: string; token: string } {
  const match = MEMBER_TOKEN.exec(raw);
  return match ? { ws: match[1], token: "acard_" + match[2] } : { ws: OWNER_WS, token: raw };
}

export function oauthUserId(ws: string): string {
  return ws === OWNER_WS ? "owner" : "ws-" + ws;
}

export function workspaceFromOauthUser(userId: string | undefined): string | null {
  if (userId === "owner") return OWNER_WS;
  const match = /^ws-([0-9a-f]{32})$/.exec(userId ?? "");
  return match ? match[1] : null;
}

const jwksCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

function b64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

async function jwks(supabaseUrl: string, force = false): Promise<Map<string, CryptoKey>> {
  const cached = jwksCache.get(supabaseUrl);
  if (cached && !force && Date.now() - cached.at < 10 * 60 * 1000) return cached.keys;
  const res = await fetch(supabaseUrl + "/auth/v1/.well-known/jwks.json");
  if (!res.ok) throw new Error("jwks " + res.status);
  const body = (await res.json()) as { keys: (JsonWebKey & { kid: string; alg?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
  }
  jwksCache.set(supabaseUrl, { at: Date.now(), keys });
  return keys;
}

export type JwtUser = { sub: string; email?: string; exp: number; user_metadata?: Record<string, unknown> };

export async function verifyJwt(token: string, supabaseUrl: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<JwtUser | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: { sub?: string; email?: string; exp?: number; iss?: string; aud?: string | string[]; role?: string; user_metadata?: Record<string, unknown> };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || !header.kid) return null;
  let keys = await jwks(supabaseUrl);
  if (!keys.has(header.kid)) keys = await jwks(supabaseUrl, true);
  const key = keys.get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== supabaseUrl + "/auth/v1" || !aud.includes("authenticated") || payload.role !== "authenticated") return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds || typeof payload.sub !== "string") return null;
  return { sub: payload.sub, email: payload.email, exp: payload.exp, user_metadata: payload.user_metadata ?? {} };
}

export const ACCESS_COOKIE = "acard_at";
export const REFRESH_COOKIE = "acard_rt";

export function readCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      try { out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim()); } catch { continue; }
    }
  }
  return out;
}

export const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export function sessionCookies(session: { access_token: string; refresh_token: string; expires_in: number }): string[] {
  return [setCookie(ACCESS_COOKIE, session.access_token, session.expires_in), setCookie(REFRESH_COOKIE, session.refresh_token, 60 * 60 * 24 * 30)];
}

export const clearSessionCookies = () => [setCookie(ACCESS_COOKIE, "", 0), setCookie(REFRESH_COOKIE, "", 0), "acard_id=; Path=/; Secure; SameSite=Lax; Max-Age=0"];

export type Session = { user: JwtUser; token: string; set: string[] };

export async function readSession(request: Request, env: TenancyEnv): Promise<Session | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const jar = readCookies(request);
  if (jar[ACCESS_COOKIE]) {
    const user = await verifyJwt(jar[ACCESS_COOKIE], env.SUPABASE_URL).catch(() => null);
    if (user) return { user, token: jar[ACCESS_COOKIE], set: [] };
  }
  if (jar[REFRESH_COOKIE]) {
    const res = await fetch(env.SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: jar[REFRESH_COOKIE] }),
    });
    if (res.ok) {
      const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
      const user = await verifyJwt(data.access_token, env.SUPABASE_URL).catch(() => null);
      if (user) return { user, token: data.access_token, set: sessionCookies(data) };
    }
  }
  return null;
}
