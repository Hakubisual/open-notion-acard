import { afterEach, expect, test } from "bun:test";
import { injectAppBeta } from "../gate/hosted-access";
import { accountApi } from "../gate/account";
import { setup } from "./db-harness";

const WS = "0123456789abcdef0123456789abcdef";
function kv() {
  const map = new Map<string, string>();
  return { map, get: async (k: string) => map.get(k) ?? null, put: async (k: string, v: string) => { map.set(k, v); }, delete: async (k: string) => { map.delete(k); }, list: async () => ({ keys: [] }) };
}
function harness(flag: string | undefined, marked: boolean) {
  const h = setup();
  const outbox = kv();
  if (marked) outbox.map.set("guide-new:" + WS, "1");
  Object.assign(h.env, { OUTBOX: outbox, ACARD_WORKSPACE: WS, ...(flag === undefined ? {} : { ACARD_GUIDE: flag }) });
  return { ...h, outbox };
}
const post = (h: ReturnType<typeof harness>, body: unknown) => h.call("POST", "/api/guide", body);

test("a workspace marked at its first onboarding finish gets the guide once; unmarked workspaces never do", async () => {
  const fresh = harness("on", true);
  const first = await fresh.call("GET", "/api/guide");
  expect(first.data).toMatchObject({ enabled: true, active: true, count: 0, required: 4, done: false });
  expect(fresh.outbox.map.has("guide-new:" + WS)).toBe(false);
  expect((await fresh.call("GET", "/api/guide")).data.active).toBe(true);

  const existing = harness("on", false);
  expect((await existing.call("GET", "/api/guide")).data).toEqual({ enabled: true, active: false });
  expect((await post(existing, { action: "skip" })).status).toBe(409);
});

test("steps count only real events; skip pauses without losing progress; resume and hide; four steps finish it", async () => {
  const h = harness("on", true);
  await h.call("GET", "/api/guide");
  expect((await post(h, { action: "step", step: "page" })).status).toBe(400);
  expect((await post(h, { action: "nope" })).status).toBe(400);
  let s = (await post(h, { action: "step", step: "slash" })).data;
  expect(s.steps).toMatchObject({ slash: true, page: false });
  s = (await post(h, { action: "skip" })).data;
  expect(s).toMatchObject({ active: true, skipped: true, count: 1 });
  s = (await post(h, { action: "resume" })).data;
  expect(s.skipped).toBe(false);
  s = (await post(h, { action: "hide" })).data;
  expect(s).toMatchObject({ active: false, hidden: true });
  s = (await post(h, { action: "resume" })).data;
  expect(s.active).toBe(true);

  const made = await h.call("POST", "/api/pages", { title: "내 첫 페이지" });
  expect(made.status).toBeLessThan(300);
  await post(h, { action: "step", step: "search" });
  s = (await post(h, { action: "step", step: "share" })).data;
  expect(s).toMatchObject({ count: 4, done: true, celebrate: true, skipped: false });
  s = (await post(h, { action: "celebrated" })).data;
  expect(s.celebrate).toBe(false);
  expect((await h.call("GET", "/api/guide")).data.done).toBe(true);
});

test("restart gives anyone (also members without a mark) a fresh guide", async () => {
  const h = harness("on", false);
  const s = (await post(h, { action: "restart" })).data;
  expect(s).toMatchObject({ active: true, count: 0, done: false });
});

test("the kill switch: any ACARD_GUIDE other than on turns the API off, even with saved state", async () => {
  const h = harness("on", true);
  await h.call("GET", "/api/guide");
  delete (h.env as any).ACARD_GUIDE;
  expect((await h.call("GET", "/api/guide")).data).toEqual({ enabled: false, active: false });
  (h.env as any).ACARD_GUIDE = "off";
  expect((await post(h, { action: "restart" })).data).toEqual({ enabled: false, active: false });
});

test("editTools follows HUMAN_EDIT: on only when the right-click tools and Tab palette are on for everyone (#149)", async () => {
  const h = harness("on", true);
  expect((await h.call("GET", "/api/guide")).data.editTools).toBeNull();
  (h.env as any).HUMAN_EDIT = "flagged";
  expect((await h.call("GET", "/api/guide")).data.editTools).toBeNull();
  (h.env as any).HUMAN_EDIT = "on";
  const s = (await h.call("GET", "/api/guide")).data;
  expect(s.required).toBe(4);
  for (const part of ["오른쪽 클릭(휴대폰은 블록 핸들 길게 누르기) = 블록 도구", "드래그하고 오른쪽 클릭 = 그 부분만 바꾸는 도구", "빈 줄에서 Tab = 기능 찾기"]) expect(s.editTools).toContain(part);
});

test("guests cannot read or change the guide", async () => {
  const h = harness("on", true);
  (h.env as any).ACARD_SESSION = "guest";
  expect((await h.call("GET", "/api/guide")).status).toBe(401);
});

test("a downloaded HTML export gets no app scripts", async () => {
  const download = new Response("<html><body><main>exported</main></body></html>", { headers: { "content-type": "text/html; charset=utf-8", "content-disposition": 'attachment; filename="page.html"' } });
  const out = await injectAppBeta(download, { ACARD_GUIDE: "on" } as any).text();
  expect(out).not.toContain("/_site/beta.js");
  expect(out).not.toContain("/_site/welcome-guide.js");
  expect(out).toContain("exported");
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
async function finish(profile: { onboarded_at: string | null } | null, _flag: string | undefined) {
  const outbox = kv();
  const uid = "01234567-89ab-cdef-0123-456789abcdef";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "ES256", kid: "k1", typ: "JWT" }) + "." + b64({ sub: uid, email: "a@test.dev", exp: Math.floor(Date.now() / 1000) + 600, iss: "https://supa-guide.test/auth/v1", aud: "authenticated", role: "authenticated" });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(unsigned));
  const token = unsigned + "." + Buffer.from(new Uint8Array(sig)).toString("base64url");
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/jwks.json")) return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
    if (url.pathname === "/rest/v1/rpc/handle_status") return Response.json("ok");
    if (url.pathname === "/rest/v1/profiles" && (init?.method ?? "GET") === "GET") return Response.json(profile ? [{ id: uid, display_name: "a", handle: "aaa", ...profile }] : []);
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ id: uid, display_name: "a", handle: "aaa", onboarded_at: "now" }]);
    return Response.json({});
  }) as typeof fetch;
  return { outbox, uid, token };
}

test("onboarding finish marks the workspace only the first time and only while the flag is on", async () => {
  const env: any = { ASSETS: { fetch: async () => new Response(null, { status: 404 }) }, SUPABASE_URL: "https://supa-guide.test", SUPABASE_ANON_KEY: "anon" };
  const cases: [{ onboarded_at: string | null } | null, string | undefined, boolean][] = [
    [{ onboarded_at: null }, "on", true],
    [null, "on", true],
    [{ onboarded_at: "2026-10-01T00:00:00Z" }, "on", false],
    [{ onboarded_at: null }, "off", false],
    [{ onboarded_at: null }, undefined, false],
  ];
  for (const [profile, flag, expected] of cases) {
    const { outbox, token } = await finish(profile, flag);
    const url = new URL("https://notes.example.com/api/profile");
    const body = profile ? { finish: true } : { display_name: "a", handle: "aaa", finish: true, consent: ["terms", "privacy", "overseas"] };
    const res = await accountApi(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { origin: "https://notes.example.com", "content-type": "application/json", cookie: "acard_at=" + token } }), { ...env, OUTBOX: outbox, ...(flag ? { ACARD_GUIDE: flag } : {}) }, url);
    if (res.status === 401) { expect.unreachable("session not accepted: " + (await res.text())); }
    expect([profile, flag, [...outbox.map.keys()].some((k) => k.startsWith("guide-new:"))]).toEqual([profile, flag, expected]);
  }
});
