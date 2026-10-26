// Acard local mode (Windows build). Runs the same core worker as the hosted site (.build/acard-core.js, made by build.ts)
// inside Bun. The workspace store, media KV and static assets are local shims with the same contracts as the
// Cloudflare bindings (workers/acard-workspace WorkspaceStore, KV, ASSETS). Only local/main.ts imports this
// file, so the cloud build never includes it.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, normalize, resolve as resolvePath, sep } from "node:path";
import core, { acardHost } from "../.build/acard-core.js";
import { workspaceEnv } from "../gate/tenancy";
import { isLang, localizeJson, type Lang } from "../gate/i18n";
import { licenseRoute } from "./edition";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAcardMcpServer, OperationFailure, type AgentOperation } from "../agents/mcp-tools";
import { archiveRoute } from "./archive";
import { CloudClient, cloudRoute } from "./cloud";
import { cloudPage } from "./cloud-page";
import { CLOUD_URL } from "./cloud-host";
import { startAutoBackup } from "./auto-backup";
import { startSync } from "./sync";
import { openapiSpec, agentsMd, llmsTxt } from "../agent-docs.js";
import { agentTokens, liteAgentsMd, LITE_AGENT, liteMcp, liteRoute, liteShell, skillPage, skillRoute } from "./lite";

// The local half of the live feed the app already listens to (assets/features/lazy/live.js, /api/live on notes.example.com):
// hello with the last id and anything missed, then change notices. Sync uses it so pages that arrive from another PC
// show up in the sidebar and an open page without a reload.
function liveFeed() {
  let id = 0;
  const backlog: { id: number; t: number; kinds: string[]; slugs: string[]; src: string }[] = [];
  return {
    backlog,
    next(kinds: string[], slugs: string[]) {
      const event = { id: ++id, t: Date.now(), kinds, slugs, src: "sync" };
      backlog.push(event);
      if (backlog.length > 100) backlog.shift();
      return event;
    },
    hello(since: number) {
      const missed = backlog.filter((e) => e.id > since);
      const reset = since > 0 && since < id && (!backlog.length || backlog[0].id > since + 1);
      return JSON.stringify({ type: "hello", id, missed: reset ? [] : missed, reset });
    },
  };
}

const LOCAL_WS = "00000000000000000000000000000001";
const CLOUD_ONLY = "This feature needs the hosted service and is not available on a self-hosted server.";

// host: listen address (default 127.0.0.1). allowedHosts: extra Host names (LAN IP, DNS name) or "*".
// password: when set, every page needs a login (/__local/login). Required whenever host is not loopback.
// lang: UI language for app pages (en / ko / zh). Unset keeps the Korean source copy.
// lite: the desktop app's light local mode (local/lite.ts): plain markdown pages, agents only with <data>/agent-token.
export type LocalOptions = { dataDir: string; appDir: string; port: number; host?: string; allowedHosts?: string[]; password?: string; lang?: string; cloudUrl?: string; localApi?: boolean; agentToken?: string; lite?: boolean };

function clean(params: unknown[] = []) {
  return params.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v)) as any[];
}

// Same behaviour as WorkspaceStore (workers/acard-workspace/index.js) minus the cloud write quota.
function workspaceStore(db: Database) {
  const run = (sql: string, params: unknown[], mode: string) => {
    const rows = db.query(sql).all(...clean(params));
    if (mode === "all") return { results: rows, success: true, meta: {} };
    if (mode === "first") return rows[0] ?? null;
    const changes = Number((db.query("SELECT changes() AS c").get() as { c: number }).c);
    return { results: rows, success: true, meta: { changes } };
  };
  const hits = new Map<string, { window: number; n: number }>();
  return {
    exec: async (sql: string, params: unknown[], mode: string) => run(sql, params, mode),
    batch: async (list: { sql: string; params: unknown[] }[]) => db.transaction(() => list.map((item) => run(item.sql, item.params, "run")))(),
    // Several statements in one call (gate/tenancy.ts d1Adapter); each reports its own result like WorkspaceStore.pipe.
    pipe: async (items: { sql?: string; params?: unknown[]; mode?: string; batch?: { sql: string; params: unknown[] }[] }[]) => items.map((item) => {
      try {
        const value = item.batch
          ? db.transaction(() => item.batch!.map((s) => run(s.sql, s.params, "run")))()
          : run(item.sql!, item.params ?? [], item.mode ?? "run");
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
    stats: async () => ({ pages: Number((db.query("SELECT count(*) AS n FROM pages").get() as any)?.n ?? 0) }),
    wipe: async () => ({ ok: false }),
    hit: async (key: string, limit: number, period: number) => {
      const window = Math.floor(Date.now() / (period * 1000));
      const entry = hits.get(key);
      if (!entry || entry.window !== window) hits.set(key, { window, n: 1 });
      else entry.n += 1;
      return (hits.get(key)?.n ?? 0) <= limit;
    },
  };
}

// Workers KV subset the app uses (get with type, getWithMetadata, put with metadata/expirationTtl, delete, list).
function sqliteKv(db: Database) {
  db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, metadata TEXT, expires INTEGER)");
  const live = (row: any) => row && (!row.expires || row.expires > Date.now()) ? row : null;
  const decode = (bytes: Uint8Array, type: string) => {
    if (type === "arrayBuffer") return bytes.slice().buffer;
    if (type === "stream") return new Blob([bytes.slice()]).stream();
    const text = new TextDecoder().decode(bytes);
    return type === "json" ? JSON.parse(text) : text;
  };
  const typeOf = (options: any) => (typeof options === "string" ? options : options?.type) ?? "text";
  const read = (key: string) => live(db.query("SELECT value, metadata, expires FROM kv WHERE key = ?").get(key));
  return {
    async get(key: string, options?: any) {
      const row = read(key);
      return row ? decode(row.value, typeOf(options)) : null;
    },
    async getWithMetadata(key: string, options?: any) {
      const row = read(key);
      return row ? { value: decode(row.value, typeOf(options)), metadata: row.metadata ? JSON.parse(row.metadata) : null } : { value: null, metadata: null };
    },
    async put(key: string, value: any, options?: any) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer())
        : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      const expires = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : options?.expiration ? options.expiration * 1000 : null;
      db.query("INSERT OR REPLACE INTO kv (key, value, metadata, expires) VALUES (?, ?, ?, ?)").run(key, bytes, options?.metadata ? JSON.stringify(options.metadata) : null, expires);
    },
    async delete(key: string) { db.query("DELETE FROM kv WHERE key = ?").run(key); },
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const prefix = options.prefix ?? "";
      const limit = Math.min(options.limit ?? 1000, 1000);
      const after = options.cursor ?? "";
      const rows = db.query("SELECT key FROM kv WHERE key >= ? AND key < ? AND key > ? AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT ?")
        .all(prefix, prefix + "\uffff", after, Date.now(), limit + 1) as { key: string }[];
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      return { keys: page.map((r) => ({ name: r.key })), list_complete: !more, ...(more ? { cursor: page[page.length - 1].key } : {}) };
    },
  };
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", webmanifest: "application/manifest+json", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", txt: "text/plain; charset=utf-8", woff2: "font/woff2", tgz: "application/gzip",
};

// Cloudflare Pages asset rules the app relies on: /x serves x.html, /dir/ serves dir/index.html, unknown -> 404.
function folderAssets(appDir: string) {
  // join() returns native separators, so the root must be normalized too or "C:/app/dist" rejects every file.
  const root = resolvePath(appDir);
  const resolve = async (pathname: string) => {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
    const base = join(root, rel);
    if (base !== root && !base.startsWith(root + sep)) return null;
    for (const candidate of [base, base + ".html", join(base, "index.html")]) {
      const file = Bun.file(candidate);
      if (await file.exists() && !(candidate.endsWith(sep))) return file;
    }
    return null;
  };
  return {
    async fetch(request: Request) {
      const file = await resolve(new URL(request.url).pathname).catch(() => null);
      if (!file) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
      const ext = (file.name ?? "").split(".").pop()!.toLowerCase();
      const body = request.method === "HEAD" ? null : file;
      return new Response(body, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream", etag: '"' + file.size + "-" + file.lastModified + '"' } });
    },
  };
}

export function localEnv({ dataDir, appDir, lang }: LocalOptions) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "acard.sqlite"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  const kvDb = new Database(join(dataDir, "media.sqlite"), { create: true });
  kvDb.run("PRAGMA journal_mode = WAL");
  const store = workspaceStore(db);
  const base = {
    ASSETS: folderAssets(appDir),
    MEDIA: sqliteKv(kvDb),
    WORKSPACE: { idFromName: (name: string) => name, get: () => store },
    AI: { run: async () => { throw new Error(CLOUD_ONLY); } },
    ACARD_LOCAL: "1",
    // Data the app makes on its own (the example pages, the home page title) follows the UI language (issue 147).
    ...(isLang(lang) && lang !== "ko" ? { ACARD_LANG: lang } : {}),
  };
  const env = acardHost.trust(workspaceEnv(base as any, LOCAL_WS));
  return { env, assets: base.ASSETS, close: () => { db.close(); kvDb.close(); } };
}

// DNS-rebinding and cross-site protection: only this PC's loopback names (plus configured LAN names), and same-origin writes.
export function guard(request: Request, port: number, extraHosts: string[] = []): Response | null {
  const allowed = new Set(["127.0.0.1:" + port, "localhost:" + port]);
  for (const name of extraHosts) allowed.add((name.includes(":") ? name : name + ":" + port).toLowerCase());
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (extraHosts.includes("*") && host) allowed.add(host);
  if (!allowed.has(host)) return new Response("Address not allowed.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = request.headers.get("origin");
    if (origin && !allowed.has(origin.replace(/^https?:\/\//, "").toLowerCase())) {
      return new Response(JSON.stringify({ error: "Requests from other sites are not accepted." }), { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  }
  return null;
}

// Tokenless agent reads need the same origin protection as writes; guard() keeps its existing method rules.
export function sameOrigin(request: Request, port: number, extraHosts: string[] = []): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const allowed = new Set(["127.0.0.1:" + port, "localhost:" + port]);
  for (const name of extraHosts) allowed.add((name.includes(":") ? name : name + ":" + port).toLowerCase());
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (extraHosts.includes("*") && host) allowed.add(host);
  return /^https?:\/\//.test(origin) && allowed.has(origin.replace(/^https?:\/\//, "").toLowerCase());
}

const AGENT_PATHS = /^(?:\/mcp|\/api\/v1\/.*|\/AGENTS\.md|\/llms\.txt)$/;

// Cloud-only surfaces (accounts, Google login, OAuth/MCP, agent runner) live in gate/agent-entry.ts, which local mode
// does not load. Their paths answer with one clear message instead of a broken page.
const CLOUD_PATHS = /^\/(?:login|signup|forgot|reset|onboarding|oauth\/|mcp|sse|api\/account|api\/agents|settings\/agents|\.well-known\/)/;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

// Local MCP for the user's own agents (Claude Code, Codex ...): http://127.0.0.1:<port>/mcp. The local server has no
// accounts, so this has the same reach as the editor on this PC; LAN agents need their own bearer token.
const LOCAL_AGENT = { name: "Local agent", via: "token" as const, scopes: ["read", "write"] };
async function localMcp(request: Request, env: unknown): Promise<Response> {
  if (request.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  const run = async (operation: AgentOperation, input: Record<string, unknown>) => {
    try {
      return await acardHost.run(env as never, LOCAL_AGENT, operation, input);
    } catch (error) {
      if (acardHost.isAgentError(error)) throw new OperationFailure(error.message, error.status);
      throw error;
    }
  };
  const server = createAcardMcpServer(run, "local", acardHost.mcpTools);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
const SESSION_COOKIE = "acard_session";
const SESSION_DAYS = 30;
const BRAND_FILES = new Set(["/favicon.svg", "/favicon.ico", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png", "/wordmark.svg"]);

// Password login for LAN mode. The cookie is "<expiry>.<hmac(secret, expiry)>"; the secret lives in the data folder,
// so changing the password or deleting session-secret signs everyone out.
export function passwordGate(dataDir: string, password: string) {
  const file = join(dataDir, "session-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"));
  const secret = readFileSync(file, "utf8").trim() + "\0" + password;
  const sign = (expiry: string) => createHmac("sha256", secret).update(expiry).digest("hex");
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const valid = (request: Request) => {
    const raw = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + "="));
    const [expiry, mac] = (raw?.slice(SESSION_COOKIE.length + 1) ?? "").split(".");
    return !!expiry && !!mac && Number(expiry) > Date.now() && same(mac, sign(expiry));
  };
  const secure = (request: Request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const page = (error = "", next = "/") => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in - Acard</title>'
    + '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png">'
    + '<style>body{font-family:system-ui,sans-serif;background:#f6f6f4;display:grid;place-items:center;min-height:100vh;margin:0}form{box-sizing:border-box;background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px #0001;width:min(404px,92vw)}.brand{display:block;height:34px;width:auto;margin:0 0 20px}h1{font-size:20px;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:10px;font-size:15px;border:1px solid #ccc;border-radius:8px}button{margin-top:14px;width:100%;padding:10px;font-size:15px;border:0;border-radius:8px;background:#222;color:#fff;cursor:pointer}p{color:#b00020;font-size:14px}</style>'
    + '<form method="post" action="/__local/login"><img class="brand" src="/wordmark.svg" alt="Acard"><h1>Sign in to your notes</h1>' + (error ? "<p>" + error + "</p>" : "")
    + '<input type="hidden" name="next" value="' + next.replace(/["<>&]/g, "") + '"><input type="password" name="password" placeholder="Server password" autofocus required><button>Sign in</button></form>',
    { status: error ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8" } });
  return async function gate(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/__local/health") return null;
    // The sign-in page shows the logo and favicon before there is a session; these files carry no workspace data.
    if (request.method === "GET" && BRAND_FILES.has(url.pathname)) return null;
    if (url.pathname === "/__local/login") {
      if (request.method !== "POST") return page("", url.searchParams.get("next") || "/");
      const form = await request.formData().catch(() => null);
      const given = String(form?.get("password") ?? "");
      const next = String(form?.get("next") ?? "/");
      const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";
      if (!same(createHmac("sha256", "pw").update(given).digest("hex"), createHmac("sha256", "pw").update(password).digest("hex"))) return page("Wrong password.", target);
      const expiry = String(Date.now() + SESSION_DAYS * 86400_000);
      const cookie = SESSION_COOKIE + "=" + expiry + "." + sign(expiry) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400 + (secure(request) ? "; Secure" : "");
      return new Response(null, { status: 303, headers: { location: target, "set-cookie": cookie } });
    }
    if (url.pathname === "/__local/logout") {
      return new Response(null, { status: 303, headers: { location: "/__local/login", "set-cookie": SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" } });
    }
    if (valid(request)) return null;
    const wantsHtml = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
    return wantsHtml
      ? new Response(null, { status: 303, headers: { location: "/__local/login?next=" + encodeURIComponent(url.pathname + url.search) } })
      : new Response(JSON.stringify({ error: "login required" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
  };
}

const HTML_LANG: Record<Lang, string> = { en: "en", ko: "ko", zh: "zh-CN" };

// The local app's home (acard-next-10 #8). notes.example.com keeps the profile in Supabase; here it is one file in the data folder
// with the home layout and the two local checklist steps (MCP address copied, backup file downloaded). assets/ui/home.js
// draws the local 시작하기 steps when the profile carries "local".
export function localProfile(dataDir: string) {
  const file = join(dataDir, "local-profile.json");
  const read = (): Record<string, any> => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  const write = (patch: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ ...read(), ...patch }));
  return {
    async route(request: Request, url: URL): Promise<Response> {
      if (request.method === "POST") {
        const body = await request.json().catch(() => null);
        const layout = body && body.home_layout;
        if (!body || typeof body !== "object" || ("home_layout" in body && layout !== null && !(layout && Array.isArray(layout.widgets) && layout.widgets.every((w: unknown) => typeof w === "string")))) {
          return Response.json({ error: "요청 형식이 올바르지 않아요." }, { status: 400 });
        }
        write({ ...("home_layout" in body ? { home_layout: layout } : {}), ...(body.step === "mcp" ? { mcpCopied: Date.now() } : {}) });
      } else if (request.method !== "GET") return Response.json({ error: "지원하지 않는 요청이에요." }, { status: 405 });
      const saved = read();
      return Response.json({
        profile: { home_layout: saved.home_layout === undefined ? { widgets: [] } : saved.home_layout },
        local: { mcp: url.origin + "/mcp", mcpCopied: Boolean(saved.mcpCopied), backupDone: Boolean(saved.backupDone) },
      });
    },
    backedUp: () => write({ backupDone: Date.now() }),
  };
}

// The sidebar footer was made for notes.example.com accounts. Locally there is no account: its agent-settings icon opens
// "내 데이터" (backup, notes.example.com connect, local MCP address) and the sign-out button only stays when a LAN password is on.
const SIDE_AGENTS = '<a class="icon" href="/settings/agents/" aria-label="에이전트 연결" title="에이전트 연결">';
const SIDE_LOGOUT = /<form method="POST" action="\/__logout" class="side-logout">[\s\S]*?<\/form>/;
export async function localShell(response: Response, passwordOn: boolean): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const html = (await response.text()).replace(/<html\b/i, '<html data-acard-local');
  if (!html.includes(SIDE_AGENTS)) return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  let out = html.replace(SIDE_AGENTS, '<a class="icon" href="/__local/cloud" aria-label="내 데이터" title="내 데이터">');
  out = passwordOn ? out.replace(SIDE_LOGOUT, '<form method="POST" action="/__local/logout" class="side-logout"><button class="icon" type="submit" aria-label="로그아웃" title="로그아웃">' + (SIDE_LOGOUT.exec(out)?.[0].match(/<svg[\s\S]*<\/svg>/)?.[0] ?? "") + "</button></form>") : out.replace(SIDE_LOGOUT, "");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(out, { status: response.status, statusText: response.statusText, headers });
}

// Same result as gate/i18n.ts injectAppLang (html lang + the app dictionary loader), done on the buffered page:
// a streamed HTMLRewriter body is cut off when Bun.serve sends it.
export async function withLang(response: Response, lang: Lang): Promise<Response> {
  if (lang === "ko" || !(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const html = (await response.text())
    .replace(/<html\b([^>]*?)\blang="[^"]*"/i, '<html$1lang="' + HTML_LANG[lang] + '"')
    .replace(/<head([^>]*)>/i, '<head$1><script>window.ACARD_LANG=' + JSON.stringify(lang) + '</script><script src="/i18n-app.js"></script>');
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-language", HTML_LANG[lang]);
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

// The "내 데이터" page allows inline scripts only; with a language set it also loads the dictionary loader /i18n-app.js.
function withScriptSelf(response: Response): Response {
  const csp = response.headers.get("content-security-policy");
  if (csp) response.headers.set("content-security-policy", csp.replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'"));
  return response;
}

// Light mode routes, answered before the full app's: agent paths need the app's token (and no foreign Origin), page
// addresses get the plain markdown reader, /__local/skill is the AI connection screen. Everything else falls through.
export function liteMode(env: unknown, options: LocalOptions, edited: () => void, changed: (slugs: string[]) => void) {
  const tokens = agentTokens(options.dataDir);
  let lastAgentAt: number | null = null;
  const run = async (operation: string, input: Record<string, unknown>) => {
    try {
      return await acardHost.run(env as never, LITE_AGENT, operation as AgentOperation, input);
    } catch (error) {
      if (acardHost.isAgentError(error)) throw new OperationFailure(error.message, error.status);
      throw error;
    }
  };
  const mcp = liteMcp(run);
  const internal = (path: string, init: RequestInit = {}) => {
    const origin = "http://127.0.0.1:" + options.port;
    return Promise.resolve(core.fetch(new Request(origin + path, { ...init, headers: { origin, "content-type": "application/json" } }), env));
  };
  const deny = (status: number, error: string) => Response.json({ error }, { status });
  return async (request: Request, url: URL): Promise<Response | null> => {
    const method = request.method.toUpperCase();
    if (AGENT_PATHS.test(url.pathname)) {
      if (!sameOrigin(request, options.port, options.allowedHosts)) return deny(403, "Requests from other sites are not accepted.");
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || !tokens.matches(token)) return deny(401, "Acard 앱의 AI 연결 화면에 있는 토큰이 필요해요.");
      if (request.headers.get("x-acard-check") !== "1") lastAgentAt = Date.now();
      if (method === "GET" && (url.pathname === "/AGENTS.md" || url.pathname === "/llms.txt")) return new Response(liteAgentsMd(url.origin), { headers: { "content-type": "text/markdown; charset=utf-8" } });
      if (method === "GET" && url.pathname === "/api/v1/openapi.json") return Response.json(openapiSpec(url.origin));
      const res = url.pathname === "/mcp" ? await mcp(request) : await acardHost.serveV1(request, env as never, LITE_AGENT);
      if (method === "POST" || method === "PUT" || method === "PATCH") { edited(); changed([]); }
      return res;
    }
    // Every other write must come from the app's own pages (a browser always sends Origin on POST/PUT/DELETE), so a
    // program on this PC without the token cannot write through the app's internal API either.
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !request.headers.get("origin")) return deny(401, "Acard 앱의 AI 연결 화면에 있는 토큰이 필요해요.");
    if (url.pathname === "/__local/skill" || url.pathname === "/__local/skill/") return skillPage();
    if (url.pathname.startsWith("/__local/skill/")) return skillRoute(request, url, tokens, () => lastAgentAt);
    if (url.pathname.startsWith("/__local/lite/")) {
      const res = await liteRoute(request, url, internal);
      if (res && method !== "GET" && res.ok) { edited(); changed([]); }
      return res;
    }
    const pageAddress = /^\/(?:edit\/)?(?:[^/.]+\/?)?$/.test(url.pathname) && !url.pathname.startsWith("/__") && !/^\/(?:api|settings|login|signup|oauth|mcp|sse)\b/.test(url.pathname);
    if (method === "GET" && pageAddress) return liteShell();
    return null;
  };
}

export function startServer(given: LocalOptions) {
  // Port 0 lets the OS pick a free port; options.port becomes the bound port right after Bun.serve, before any request.
  const options = { ...given };
  const host = options.host || "127.0.0.1";
  if (!LOOPBACK.has(host) && !options.password) throw new Error("Listening on " + host + " needs a password (ACARD_PASSWORD).");
  // A new data folder starts with the example pages instead of one empty page (the same pair notes.example.com offers).
  const fresh = !existsSync(join(options.dataDir, "acard.sqlite"));
  const { env, assets, close } = localEnv(options);
  const profile = localProfile(options.dataDir);
  const origin = "http://127.0.0.1:" + options.port;
  const seeding = fresh
    ? Promise.resolve(core.fetch(new Request(origin + "/api/templates/welcome", { method: "POST", headers: { origin } }), env))
      .then((res: Response) => { if (res.status !== 303) console.error("acard local example pages were not created", res.status); })
      .catch((error: unknown) => console.error("acard local example pages were not created", error))
    : Promise.resolve();
  // Archive restore writes tables the core creates on its first API call, so make sure that call has happened.
  const ready = async () => { await acardHost.prepare(env); };
  const archiveEnv = { DB: (env as any).DB, MEDIA: (env as any).MEDIA };
  const cloud = new CloudClient(options.cloudUrl ?? CLOUD_URL, options.dataDir, () => options.port);
  const auto = startAutoBackup({ env: archiveEnv, dataDir: options.dataDir, ready, cloud });
  const live = liveFeed();
  let server: ReturnType<typeof Bun.serve<{ since: number }>> | null = null;
  const sync = startSync({ env: archiveEnv, dataDir: options.dataDir, ready, cloud, notify: (slugs) => {
    const event = live.next(["tree", "page"], slugs);
    server?.publish("live", JSON.stringify({ type: "change", ...event }));
  } });
  const gate = options.password ? passwordGate(options.dataDir, options.password) : null;
  const agentDigest = options.agentToken ? createHash("sha256").update(options.agentToken).digest() : null;
  const lang: Lang | null = isLang(options.lang) ? options.lang : null;
  const lite = options.lite ? liteMode(env, options, () => sync.edited(), (slugs) => {
    const event = live.next(["tree", "page"], slugs);
    server?.publish("live", JSON.stringify({ type: "change", ...event }));
  }) : null;
  server = Bun.serve<{ since: number }>({
    hostname: host,
    port: options.port,
    idleTimeout: 120,
    websocket: {
      open(ws) { ws.subscribe("live"); ws.send(live.hello(ws.data.since)); },
      message(ws, message) { if (message === "ping") ws.send("pong"); },
      close(ws) { ws.unsubscribe("live"); },
    },
    async fetch(request, srv) {
      const blocked = guard(request, options.port, options.allowedHosts);
      if (blocked) return blocked;
      await seeding;
      const url = new URL(request.url);
      if (lite) {
        const handled = await lite(request, url);
        if (handled) return handled;
      }
      const agentPath = AGENT_PATHS.test(url.pathname);
      let agentAuthenticated = false;
      if (agentPath) {
        const authorization = request.headers.get("authorization");
        if (agentDigest && authorization !== null) {
          const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
          if (!token || !timingSafeEqual(createHash("sha256").update(token).digest(), agentDigest)) {
            return Response.json({ error: "invalid agent token" }, { status: 401 });
          }
          agentAuthenticated = true;
        }
        if (gate && !agentAuthenticated) {
          return Response.json({ error: agentDigest ? "invalid agent token" : "agent access is off: set ACARD_AGENT_TOKEN on the server" }, { status: 401 });
        }
        if (!agentAuthenticated && options.localApi && !sameOrigin(request, options.port, options.allowedHosts)) {
          return Response.json({ error: "Requests from other sites are not accepted." }, { status: 403 });
        }
      }
      const localApi = agentPath && (agentAuthenticated || options.localApi);
      const locked = gate && !agentAuthenticated ? await gate(request, url) : null;
      if (locked) return locked;
      if (localApi && request.method === "GET") {
        if (url.pathname === "/api/v1/openapi.json") return Response.json(openapiSpec(url.origin));
        if (url.pathname === "/AGENTS.md") return new Response(agentsMd(url.origin), { headers: { "content-type": "text/markdown; charset=utf-8" } });
        if (url.pathname === "/llms.txt") return new Response(llmsTxt(url.origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/api/live" && request.method === "GET") {
        if (srv.upgrade(request, { data: { since: Math.max(0, Number(url.searchParams.get("since")) || 0) } })) return undefined;
        return new Response(JSON.stringify({ error: "websocket only" }), { status: 426, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (url.pathname === "/mcp") { const res = await localMcp(request, env); if (request.method === "POST") sync.edited(); return res; }
      // Settings live on notes.example.com; the local app's own settings are the "내 데이터" screen.
      if (/^\/settings(?:\/agents)?\/?$/.test(url.pathname) && request.method === "GET") return new Response(null, { status: 303, headers: { location: "/__local/cloud" } });
      if (CLOUD_PATHS.test(url.pathname)) {
        const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
        return wantsHtml
          ? new Response('<!doctype html><meta charset="utf-8"><title>Not available</title><body style="font-family:sans-serif;padding:40px"><h1>Hosted-only feature</h1><p>' + CLOUD_ONLY + '</p><p><a href="/">Back to my pages</a></p>', { status: 404, headers: { "content-type": "text/html; charset=utf-8" } })
          : new Response(JSON.stringify({ error: CLOUD_ONLY }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (url.pathname === "/__local/health") return new Response("acard-local ok");
      if (url.pathname.startsWith("/__local/license")) return licenseRoute(request, options.dataDir);
      if (url.pathname === "/__local/archive/auto") {
        const body = request.method === "POST" ? await auto.tick(true).then(() => auto.status()) : auto.status();
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
      if (url.pathname.startsWith("/__local/archive/")) {
        const res = await archiveRoute(request, url, archiveEnv, options.dataDir, ready);
        if (url.pathname === "/__local/archive/export" && res.ok) profile.backedUp();
        return res;
      }
      if (url.pathname === "/api/profile") return profile.route(request, url);
      if (url.pathname === "/__local/cloud" || url.pathname === "/__local/cloud/") return lang ? await withLang(withScriptSelf(cloudPage()), lang) : cloudPage();
      if (url.pathname === "/__local/cloud/sync") {
        const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as { enabled?: boolean; now?: boolean }) : {};
        if (typeof body.enabled === "boolean") await sync.setEnabled(body.enabled);
        else if (body.now) await sync.sync();
        return new Response(JSON.stringify(sync.status()), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
      if (url.pathname.startsWith("/__local/cloud/")) return cloudRoute(request, url, cloud, archiveEnv, options.dataDir, ready);
      // The hosted entry serves the app dictionaries; local mode skips that entry, so answer them here.
      if (/^\/i18n\/app-(?:en|zh)\.json$/.test(url.pathname)) return assets.fetch(request);
      try {
        const raw = localApi && url.pathname.startsWith("/api/v1/")
          ? await acardHost.serveV1(request, env, LOCAL_AGENT)
          : await core.fetch(request, env);
        if (request.method !== "GET" && request.method !== "HEAD" && raw.ok && url.pathname.startsWith("/api/")) sync.edited();
        const response = await localShell(raw, Boolean(gate));
        // API errors with an err.* entry come in the UI language too (the hosted entry does the same per request).
        return lang ? await withLang(raw.ok ? response : await localizeJson(response, lang), lang) : response;
      } catch (error) {
        console.error("acard local request failed", error);
        return new Response("Something went wrong.", { status: 500 });
      }
    },
  });
  options.port = server.port!;
  return { server, sync, close: () => { auto.stop(); sync.stop(); server!.stop(true); close(); } };
}
