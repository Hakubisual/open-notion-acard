// Local side of the account connection, web publish and cloud backup (docs/local-first.md 5-8장).
// Connect = OAuth 2.1 authorization code + PKCE with a loopback redirect (RFC 8252) to /__local/cloud/callback.
// The token lives in <data>/cloud-token.json and never appears in responses or logs; /status answers connected/email only.
import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { subtree } from "../gate/archive";
import { exportLocal, restoreLocal, type LocalArchiveEnv } from "./archive";

type Token = { access_token: string; refresh_token?: string; expires_at: number; client_id: string; email?: string | null };
type Pending = { verifier: string; state: string; clientId: string; redirect: string; at: number };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class CloudClient {
  private pending = new Map<string, Pending>();
  constructor(private readonly cloud: string, private readonly dataDir: string, private readonly port: () => number) {}

  private get file() { return join(this.dataDir, "cloud-token.json"); }
  get enabled() { return Boolean(this.cloud); }

  private read(): Token | null {
    if (!existsSync(this.file)) return null;
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Token; } catch { return null; }
  }
  private write(token: Token) {
    writeFileSync(this.file, JSON.stringify(token));
    try { chmodSync(this.file, 0o600); } catch {}
  }
  disconnect() { rmSync(this.file, { force: true }); }

  async start(): Promise<string> {
    const redirect = "http://127.0.0.1:" + this.port() + "/__local/cloud/callback";
    const reg = await fetch(this.cloud + "/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Acard 로컬판", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!reg.ok) throw new Error("연결 준비에 실패했어요 (" + reg.status + ").");
    const clientId = String(((await reg.json()) as { client_id: string }).client_id);
    const verifier = random(48);
    const state = random(24);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    for (const [key, p] of this.pending) if (Date.now() - p.at > 15 * 60_000) this.pending.delete(key);
    this.pending.set(state, { verifier, state, clientId, redirect, at: Date.now() });
    return this.cloud + "/oauth/authorize?" + new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "read write offline_access", state,
      code_challenge: challenge, code_challenge_method: "S256", resource: this.cloud + "/api/v1",
    });
  }

  async finish(url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending) throw new Error("연결 요청이 만료됐어요. 다시 연결해 주세요.");
    if (url.searchParams.get("error")) throw new Error("연결을 취소했어요.");
    const code = url.searchParams.get("code") ?? "";
    const res = await fetch(this.cloud + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: pending.redirect, client_id: pending.clientId, code_verifier: pending.verifier, resource: this.cloud + "/api/v1" }),
    });
    if (!res.ok) throw new Error("토큰을 받지 못했어요 (" + res.status + ").");
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    this.write({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000, client_id: pending.clientId });
    const me = await this.call("/api/v1/cloud/me").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { email?: string } | null;
    const saved = this.read();
    if (saved) this.write({ ...saved, email: me?.email ?? null });
  }

  private async refresh(token: Token): Promise<Token | null> {
    if (!token.refresh_token) return null;
    const res = await fetch(this.cloud + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: token.client_id, resource: this.cloud + "/api/v1" }),
    }).catch(() => null);
    if (!res?.ok) return null;
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const next = { ...token, access_token: data.access_token, refresh_token: data.refresh_token ?? token.refresh_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
    this.write(next);
    return next;
  }

  async call(path: string, init: RequestInit = {}): Promise<Response> {
    let token = this.read();
    if (!token) return json({ error: "not_connected" }, 401);
    if (token.expires_at - 60_000 < Date.now()) token = (await this.refresh(token)) ?? token;
    const send = (t: Token) => fetch(this.cloud + path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: "Bearer " + t.access_token } });
    let res = await send(token);
    if (res.status === 401) {
      const fresh = await this.refresh(token);
      if (fresh) res = await send(fresh);
    }
    return res;
  }

  status() {
    const token = this.read();
    return { enabled: this.enabled, cloud: this.cloud || null, connected: Boolean(token), email: token?.email ?? null };
  }
}

const relay = async (res: Response) => new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function cloudRoute(request: Request, url: URL, client: CloudClient, env: LocalArchiveEnv, dataDir: string, ready: () => Promise<void>): Promise<Response> {
  const path = url.pathname.slice("/__local/cloud".length);
  const method = request.method.toUpperCase();
  if (path === "/status" && method === "GET") {
    const base = client.status();
    if (!base.connected) return json(base);
    const me = await client.call("/api/v1/cloud/me").catch(() => null);
    if (me && me.status === 401) return json({ ...base, connected: false, expired: true });
    return json({ ...base, account: me && me.ok ? await me.json() : null, reachable: Boolean(me && me.ok) });
  }
  if (!client.enabled) return json({ error: "이 설치본은 클라우드 기능이 꺼져 있어요 (ACARD_CLOUD_URL)." }, 404);
  try {
    if (path === "/connect" && method === "POST") return json({ authorizeUrl: await client.start() });
    if (path === "/callback" && method === "GET") {
      await client.finish(url);
      return new Response(null, { status: 303, headers: { location: "/__local/cloud?connected=1" } });
    }
    if (path === "/disconnect" && method === "POST") { client.disconnect(); return json({ ok: true }); }
    if (path === "/publish" && method === "POST") {
      await ready();
      const body = (await request.json().catch(() => ({}))) as { slug?: string };
      const slug = String(body.slug ?? "");
      const pages = await subtree(env.DB, [slug]);
      if (!pages.length) return json({ error: "게시할 페이지를 찾지 못했어요." }, 404);
      const zip = await exportLocal(env, [slug, ...pages.filter((p) => p !== slug)]);
      return relay(await client.call("/api/v1/cloud/publish", { method: "POST", headers: { "content-type": "application/zip" }, body: zip as BodyInit }));
    }
    if (path === "/publications" && method === "GET") return relay(await client.call("/api/v1/cloud/publish"));
    if (path === "/checkout" && method === "POST") return relay(await client.call("/api/v1/cloud/checkout"));
    const one = /^\/publish\/([^/]+)$/.exec(path);
    if (one && method === "DELETE") return relay(await client.call("/api/v1/cloud/publish/" + one[1], { method: "DELETE" }));
    if (path === "/backups" && method === "GET") return relay(await client.call("/api/v1/cloud/backups"));
    if (path === "/backups" && method === "POST") {
      await ready();
      return relay(await client.call("/api/v1/cloud/backups", { method: "POST", headers: { "content-type": "application/zip" }, body: (await exportLocal(env)) as BodyInit }));
    }
    if ((path === "/restore" || path === "/import-cloud") && method === "POST") {
      await ready();
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      const source = path === "/restore" ? "/api/v1/cloud/backups/" + encodeURIComponent(String(body.name ?? "")) : "/api/v1/cloud/export";
      const res = await client.call(source);
      if (!res.ok) return relay(res);
      return json({ ok: true, ...(await restoreLocal(env, dataDir, new Uint8Array(await res.arrayBuffer()))) });
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    const message = String((error as Error).message || error);
    if (path === "/callback") return new Response('<!doctype html><meta charset="utf-8"><title>Acard</title><body style="font-family:system-ui,sans-serif;padding:40px"><h1>연결하지 못했어요</h1><p>' + message.replace(/[<>&]/g, "") + '</p><p><a href="/__local/cloud">돌아가기</a></p>', { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    const status = (error as { status?: number }).status;
    return json({ error: message }, typeof status === "number" ? status : 502);
  }
}
