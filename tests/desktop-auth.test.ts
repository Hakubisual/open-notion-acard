import { afterEach, beforeAll, expect, test } from "bun:test";
import { accountApi, signupNext } from "../gate/account";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const SUPA = "https://desktop-auth.supa.test";
const email = "desktop@test.dev";
const verifier = "v".repeat(43);
const challengeOf = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("base64url");
let browserToken: string;
let jwk: JsonWebKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const head = Buffer.from(JSON.stringify({ alg: "ES256", kid: "desktop" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: "11111111-1111-4111-8111-111111111111", email, exp: Math.floor(Date.now() / 1000) + 600, iss: SUPA + "/auth/v1", aud: "authenticated", role: "authenticated" })).toString("base64url");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(head + "." + body));
  browserToken = head + "." + body + "." + Buffer.from(signature).toString("base64url");
});

function fixture() {
  const values = new Map<string, string>();
  const puts: { key: string; options: unknown }[] = [];
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const env = {
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    OUTBOX: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string, options?: unknown) => { values.set(key, value); puts.push({ key, options }); },
      delete: async (key: string) => { values.delete(key); },
      list: async () => ({ keys: [] }),
    },
  };
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SUPA + "/auth/v1/.well-known/jwks.json") return Response.json({ keys: [{ ...jwk, kid: "desktop", alg: "ES256" }] });
    calls.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    if (url === SUPA + "/auth/v1/admin/generate_link") return Response.json({ hashed_token: "one-use-hash", email });
    if (url === SUPA + "/auth/v1/verify") return Response.json({ access_token: "app-at", refresh_token: "app-rt", expires_in: 3600 });
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
  const call = (path: string, body?: unknown, cookie = "", extra = {}) => {
    const url = new URL(path, "https://notes.example.com");
    return accountApi(new Request(url, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ...extra } as any, url);
  };
  return { values, puts, calls, call };
}

test("desktop start validates challenge and provider and sets a short secure cookie", async () => {
  const f = fixture();
  const challenge = await challengeOf(verifier);
  for (const provider of ["google", "email"]) {
    const res = await f.call(`/api/auth/desktop/start?challenge=${challenge}&provider=${provider}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe((provider === "google" ? "/api/auth/google" : "/login") + "?next=%2Fapi%2Fauth%2Fdesktop%2Fhandoff");
    expect(res.headers.get("set-cookie")).toBe(`acard_dsk=${challenge}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  }
  for (const query of ["", "challenge=bad&provider=email", `challenge=${challenge}&provider=other`, `challenge=${"a".repeat(44)}&provider=google`]) expect((await f.call("/api/auth/desktop/start?" + query)).status).toBe(400);
  expect(signupNext("/api/auth/desktop/handoff")).toBe("/api/auth/desktop/handoff");
  expect(signupNext("/desktop/start")).toBe("/desktop/start");
  expect(signupNext("//evil.test")).toBeNull();
});

test("handoff requires a signed-in browser and an app challenge cookie", async () => {
  const f = fixture();
  const loggedOut = await f.call("/api/auth/desktop/handoff");
  expect(loggedOut.headers.get("location")).toBe("/login?next=%2Fapi%2Fauth%2Fdesktop%2Fhandoff");
  for (const cookie of ["", "; acard_dsk=invalid"]) {
    const res = await f.call("/api/auth/desktop/handoff", undefined, "acard_at=" + browserToken + cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).not.toContain("acard://auth/done");
  }
  expect(f.values.size).toBe(0);
  expect(f.calls).toHaveLength(0);
});

test("an email confirmation link keeps the desktop handoff destination", async () => {
  const f = fixture();
  globalThis.fetch = Object.assign(async () => Response.json({ access_token: "confirmed-at", refresh_token: "confirmed-rt", expires_in: 3600 }), { preconnect: realFetch.preconnect });
  const confirmed = await f.call("/api/auth/confirm?type=signup&token_hash=hash&next=%2Fapi%2Fauth%2Fdesktop%2Fhandoff");
  expect(confirmed.headers.get("location")).toBe("/api/auth/desktop/handoff");
});

test("handoff stores a fresh magic-link hash under the challenge, not browser tokens", async () => {
  const f = fixture();
  const challenge = await challengeOf(verifier);
  const res = await f.call("/api/auth/desktop/handoff", undefined, `acard_at=${browserToken}; acard_rt=browser-rt; acard_dsk=${challenge}`);
  expect(res.status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].body).toEqual({ type: "magiclink", email });
  expect(f.calls[0].headers.get("authorization")).toBe("Bearer service");
  expect(f.puts).toEqual([{ key: "desktop-auth:" + challenge, options: { expirationTtl: 300 } }]);
  expect(JSON.parse(f.values.get("desktop-auth:" + challenge)!)).toEqual({ token_hash: "one-use-hash", email });
  expect(res.headers.get("set-cookie")).toContain("acard_dsk=;");
  const html = await res.text();
  expect(html).toContain(email);
  expect(html).toContain('href="acard://auth/done"');
  expect(html).not.toContain("one-use-hash");
  expect(html).not.toContain("browser-rt");
});

test("redeem is pending until handoff and ignores a wrong verifier", async () => {
  const f = fixture();
  const pending = await f.call("/api/auth/desktop/redeem", { verifier });
  expect(pending.status).toBe(202);
  expect(await pending.json()).toEqual({ pending: true });
  f.values.set("desktop-auth:" + await challengeOf(verifier), JSON.stringify({ token_hash: "one-use-hash", email }));
  const wrong = await f.call("/api/auth/desktop/redeem", { verifier: "w".repeat(43) });
  expect(wrong.status).toBe(202);
  expect(await wrong.json()).toEqual({ pending: true });
  expect(f.values.size).toBe(1);
  expect(f.calls).toHaveLength(0);
});

test("redeem sets independent session cookies and consumes the handoff once", async () => {
  const f = fixture();
  const key = "desktop-auth:" + await challengeOf(verifier);
  f.values.set(key, JSON.stringify({ token_hash: "one-use-hash", email }));
  const res = await f.call("/api/auth/desktop/redeem", { verifier });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers.getSetCookie()).toEqual([
    "acard_at=app-at; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600",
    "acard_rt=app-rt; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000",
  ]);
  expect(f.calls[0].body).toEqual({ type: "magiclink", token_hash: "one-use-hash" });
  expect(f.values.has(key)).toBe(false);
  const again = await f.call("/api/auth/desktop/redeem", { verifier });
  expect(again.status).toBe(202);
  expect(await again.json()).toEqual({ pending: true });
  expect(f.calls).toHaveLength(1);
});

test("redeem rejects malformed verifiers and uses a polling-sized rate limit", async () => {
  const f = fixture();
  for (const body of [{}, { verifier: 12 }, { verifier: "x".repeat(42) }, { verifier: "x".repeat(129) }, { verifier: "/".repeat(43) }]) expect((await f.call("/api/auth/desktop/redeem", body)).status).toBe(400);
  let hit: unknown[] = [];
  const res = await f.call("/api/auth/desktop/redeem", { verifier }, "", { WORKSPACE: { idFromName: (v: string) => v, get: () => ({ hit: async (...args: unknown[]) => { hit = args; return false; } }) } });
  expect(hit).toEqual(["desktop-redeem:local", 60, 60]);
  expect(res.status).toBe(429);
  expect(f.calls).toHaveLength(0);
});

test("a consumed or expired upstream token never sets app cookies", async () => {
  const f = fixture();
  const key = "desktop-auth:" + await challengeOf(verifier);
  f.values.set(key, JSON.stringify({ token_hash: "used", email }));
  globalThis.fetch = Object.assign(async () => Response.json({ error: "expired" }, { status: 403 }), { preconnect: realFetch.preconnect });
  const res = await f.call("/api/auth/desktop/redeem", { verifier });
  expect(res.status).toBe(400);
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(f.values.has(key)).toBe(false);
});
