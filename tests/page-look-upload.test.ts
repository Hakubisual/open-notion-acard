import { describe, expect, test } from "bun:test";
import { coverHtml, pageIconHtml } from "../block-html.js";
import { hybridMedia, migrateMediaPage } from "../gate/media-store";
import { setup, cookie } from "./db-harness";

function png(width: number, height: number) {
  const bytes = new Uint8Array(33), v = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  v.setUint32(8, 13); bytes.set(new TextEncoder().encode("IHDR"), 12);
  v.setUint32(16, width); v.setUint32(20, height);
  return bytes;
}
const AVIF = Uint8Array.from([0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

function memoryR2() {
  const objects = new Map<string, { bytes: ArrayBuffer; meta: string; type: string }>();
  const view = (key: string, o: { bytes: ArrayBuffer; meta: string }) => ({ key, size: o.bytes.byteLength, customMetadata: { meta: o.meta }, arrayBuffer: async () => o.bytes, text: async () => new TextDecoder().decode(o.bytes) });
  return {
    objects,
    get: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    head: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    put: async (key: string, value: ArrayBuffer, options: any) => { objects.set(key, { bytes: value, meta: options.customMetadata.meta, type: options.httpMetadata.contentType }); },
    delete: async (key: string) => { objects.delete(key); },
    list: async (options: any = {}) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(options.prefix ?? "")).map((key) => ({ key, size: objects.get(key)!.bytes.byteLength })), truncated: false }),
  };
}

function memoryKv() {
  const values = new Map<string, { value: any; metadata: any }>();
  return {
    values,
    get: async (key: string) => values.get(key)?.value ?? null,
    getWithMetadata: async (key: string) => values.get(key) ?? { value: null, metadata: null },
    put: async (key: string, value: any, options: any = {}) => { values.set(key, { value, metadata: options.metadata ?? null }); },
    delete: async (key: string) => { values.delete(key); },
    list: async (options: any = {}) => ({ keys: [...values.keys()].filter((k) => k.startsWith(options.prefix ?? "")).map((name) => ({ name })), list_complete: true }),
  };
}

function memoryLedger() {
  const state = { used: 0, alerted: 0 };
  return {
    state,
    mediaUsage: async (delta: number, cap: number) => {
      if (delta > 0 && state.used + delta > cap) return { ok: false, used: state.used, alerted: state.alerted };
      state.used = Math.max(0, state.used + delta);
      return { ok: true, used: state.used, alerted: state.alerted };
    },
    mediaMarkAlerted: async (level: number) => { if (state.alerted >= level) return false; state.alerted = level; return true; },
  };
}

async function harness(member = false) {
  const h = setup();
  await h.call("POST", "/api/pages", { slug: "look" });
  const kv = memoryKv(), r2 = memoryR2(), ledger = memoryLedger();
  h.env.MEDIA = hybridMedia(kv as any, r2 as any);
  h.env.WORKSPACE = { idFromName: (name: string) => name, get: () => ledger };
  if (member) h.env.ACARD_WORKSPACE = "0123456789abcdef0123456789abcdef";
  const auth = await cookie();
  const request = (path: string, init: RequestInit = {}) => h.worker.fetch(new Request("https://notes.test" + path, { ...init, headers: { cookie: auth, ...init.headers } }), h.env);
  const upload = (bytes: Uint8Array, name: string, type: string, kind = "cover") => {
    const data = new FormData();
    data.set("file", new File([new Uint8Array(bytes).buffer as ArrayBuffer], name, { type })); data.set("page", "look");
    return request("/api/upload?kind=" + kind, { method: "POST", body: data });
  };
  return { ...h, kv, r2, ledger, request, upload };
}

describe("icon / cover upload (POST /api/upload?kind=)", () => {
  test("a png goes to R2 and opens from its /media/ address", async () => {
    const h = await harness();
    const res = await h.upload(png(800, 400), "cover.png", "image/png");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.url).toMatch(/^\/media\/[0-9a-f]{16}$/);
    expect(h.r2.objects.has("media/" + body.id)).toBe(true);
    expect(h.kv.values.has("media/" + body.id)).toBe(false);
    const served = await h.request(body.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-acard-store")).toBe("r2");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png(800, 400));
  });

  test("avif is accepted; svg, exe and a png-named exe are refused with 415", async () => {
    const h = await harness();
    expect((await h.upload(AVIF, "a.avif", "image/avif")).status).toBe(200);
    for (const [bytes, name, type] of [[SVG, "x.svg", "image/svg+xml"], [EXE, "x.exe", "application/octet-stream"], [EXE, "x.png", "image/png"]] as const) {
      const res = await h.upload(bytes, name, type, "icon");
      expect({ name, status: res.status }).toEqual({ name, status: 415 });
      expect((await res.json() as any).error).toContain("png, jpg, webp, gif, avif");
    }
    expect(h.r2.objects.size).toBe(1);
  });

  test("a file over 10 MB is refused with 413 and nothing is stored", async () => {
    const h = await harness();
    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(png(4000, 3000));
    const res = await h.upload(big, "big.png", "image/png");
    expect(res.status).toBe(413);
    expect((await res.json() as any).error).toContain("10MB");
    expect(h.r2.objects.size).toBe(0);
    expect(h.ledger.state.used).toBe(0);
  });

  test("a free member workspace stops at 500 MB with a message; usage is reported for settings", async () => {
    const h = await harness(true);
    h.env.ACARD_MEDIA_PLAN = async () => ({ tier: "free", quota: 500 * 1000 * 1000, passUntil: null });
    await h.env.DB.prepare("INSERT INTO media (id, page, name, mime, bytes, created) VALUES ('aaaaaaaaaaaaaaaa', 'look', 'old.png', 'image/png', ?, 1)").bind(500 * 1000 * 1000 - 10).run();
    const res = await h.upload(png(10, 10), "one.png", "image/png");
    expect(res.status).toBe(507);
    expect((await res.json() as any).error).toContain("무료 계정의 파일 저장 공간(500MB)");
    expect(h.r2.objects.size).toBe(0);
    const usage = await (await h.request("/api/media-usage")).json() as any;
    expect(usage).toMatchObject({ used: 500 * 1000 * 1000 - 10, quota: 500 * 1000 * 1000, tier: "free", passUntil: null, fileLimit: 10 * 1024 * 1024 });
  });

  test("the same bytes fit a beta / free-pass account's 10 GB; a failed plan lookup falls back to the global cap only", async () => {
    const h = await harness(true);
    await h.env.DB.prepare("INSERT INTO media (id, page, name, mime, bytes, created) VALUES ('aaaaaaaaaaaaaaaa', 'look', 'old.png', 'image/png', ?, 1)").bind(500 * 1000 * 1000 - 10).run();
    h.env.ACARD_MEDIA_PLAN = async () => ({ tier: "pass", quota: 10 * 1000 * 1000 * 1000, passUntil: "2027-01-24T00:00:00.000Z" });
    expect((await h.upload(png(10, 10), "one.png", "image/png")).status).toBe(200);
    expect(await (await h.request("/api/media-usage")).json()).toMatchObject({ quota: 10 * 1000 * 1000 * 1000, tier: "pass", passUntil: "2027-01-24T00:00:00.000Z" });
    h.env.ACARD_MEDIA_PLAN = async () => { throw new Error("supabase down"); };
    expect((await h.upload(png(10, 10), "two.png", "image/png")).status).toBe(200);
    h.env.ACARD_MEDIA_PLAN = undefined;
    expect((await h.upload(png(10, 10), "three.png", "image/png")).status).toBe(507);
  });

  test("the global ledger refuses past 100 GB, mails once per 10/30/50/80 GB step and counts what it stored", async () => {
    const h = await harness();
    h.ledger.state.used = 10e9 - 20;
    expect((await h.upload(png(10, 10), "a.png", "image/png")).status).toBe(200);
    expect(h.ledger.state.alerted).toBe(1);
    h.ledger.state.used = 79e9;
    expect((await h.upload(png(10, 10), "b.png", "image/png")).status).toBe(200);
    expect(h.ledger.state.alerted).toBe(3);
    h.ledger.state.used = 100e9 - 20;
    expect((await h.upload(png(10, 10), "c.png", "image/png")).status).toBe(507);
    expect(h.ledger.state.alerted).toBe(5);
    h.ledger.state.used = 100e9 - 40;
    expect((await h.upload(png(10, 10), "d.png", "image/png")).status).toBe(200);
    expect(h.ledger.state.used).toBe(100e9 - 40 + 33);
    expect(h.ledger.state.alerted).toBe(5);
  });

  test("deleting a media file frees its bytes in the ledger", async () => {
    const h = await harness();
    const body = await (await h.upload(png(10, 10), "a.png", "image/png")).json() as any;
    expect(h.ledger.state.used).toBe(33);
    expect((await h.request("/api/media/" + body.id, { method: "DELETE" })).status).toBe(200);
    expect(h.ledger.state.used).toBe(0);
    expect(h.r2.objects.size).toBe(0);
  });
});

describe("page settings and rendering", () => {
  test("an emoji icon, a gradient cover and an uploaded cover are saved and read back", async () => {
    const h = await harness();
    const put = (body: unknown) => h.request("/api/page/look/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ icon: "🐶", cover: "g3" })).status).toBe(200);
    let settings = (await (await h.request("/api/page/look/settings")).json() as any).settings;
    expect([settings.icon, settings.cover]).toEqual(["🐶", "g3"]);
    expect((await put({ cover: "/media/0123456789abcdef", icon: "/media/fedcba9876543210" })).status).toBe(200);
    settings = (await (await h.request("/api/page/look/settings")).json() as any).settings;
    expect([settings.icon, settings.cover]).toEqual(["/media/fedcba9876543210", "/media/0123456789abcdef"]);
    expect((await put({ cover: "g9" })).status).toBe(400);
  });

  test("reader cover and icon markup", () => {
    expect(coverHtml({ slug: "x" }, { cover: "g4" })).toContain("pagecover grad brandcover g4");
    const uploaded = coverHtml({ slug: "x" }, { cover: "/media/0123456789abcdef" });
    expect(uploaded).toContain('srcset="/media/0123456789abcdef?w=800 800w, /media/0123456789abcdef?w=1600 1600w"');
    expect(pageIconHtml({ slug: "x", ws: "member" }, { icon: "/media/0123456789abcdef" }, 88)).toContain('<img src="/media/0123456789abcdef"');
    expect(pageIconHtml({ slug: "x", ws: "member" }, { icon: "🐶" }, 88)).toBe('<span class="emoji">🐶</span>');
  });
});

describe("KV -> R2 move", () => {
  test("copies originals only, keeps KV, skips what is already there, and old ids still open", async () => {
    const kv = memoryKv(), r2 = memoryR2();
    await kv.put("media/1111111111111111", png(5, 5).buffer, { metadata: { mime: "image/png", name: "a.png" } });
    await kv.put("ws/0123456789abcdef0123456789abcdef/media/2222222222222222", png(6, 6).buffer, { metadata: { mime: "image/png", name: "b.png" } });
    await kv.put("imginfo/1111111111111111", "{}");
    await kv.put("media/1111111111111111@w400", new ArrayBuffer(3), { metadata: { mime: "image/webp" } });
    const first = await migrateMediaPage(kv as any, r2 as any, undefined, 40);
    expect([first.copied, first.skipped, first.failed]).toEqual([2, 0, []]);
    expect([...r2.objects.keys()].sort()).toEqual(["media/1111111111111111", "ws/0123456789abcdef0123456789abcdef/media/2222222222222222"]);
    expect(kv.values.size).toBe(4);
    const again = await migrateMediaPage(kv as any, r2 as any, undefined, 40);
    expect([again.copied, again.skipped]).toEqual([0, 2]);
    const store = hybridMedia(kv as any, r2 as any);
    const read = await store.getWithMetadata("media/1111111111111111", { type: "arrayBuffer" });
    expect((read.metadata as any).store).toBe("r2");
    expect((read.metadata as any).mime).toBe("image/png");
    expect(await store.get("imginfo/1111111111111111")).toBe("{}");
  });
});
