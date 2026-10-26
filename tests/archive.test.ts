// The one backup archive (gate/archive.ts) through the real local server: a page with a child page and an uploaded
// image goes out as a zip and comes back into a fresh data folder; secrets stay out; broken or hostile zips are refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive, readZip, writeZip, ArchiveError } from "../gate/archive";

const APP = join(import.meta.dir, "..", "dist");
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const dirs: string[] = [];
const servers: ReturnType<typeof Bun.spawn>[] = [];

// One server process per data folder, like the desktop app: the core keeps per-process schema state per workspace key.
async function boot(port: number) {
  const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "acard-archive-"));
  dirs.push(dataDir);
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "local", "main.ts")], {
    env: { ...process.env, ACARD_DATA_DIR: dataDir, ACARD_APP_DIR: APP, ACARD_PORT: String(port) }, stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  servers.push(child);
  const reader = child.stdout.getReader();
  for (let seen = ""; !seen.includes("READY");) {
    const { value, done } = await reader.read();
    if (done) throw new Error("local server exited before READY: " + seen);
    seen += new TextDecoder().decode(value);
  }
  const base = "http://127.0.0.1:" + port;
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { origin: base, ...(init.headers as Record<string, string>) } });
  return { dataDir, base, call };
}

async function page(call: (path: string, init?: RequestInit) => Promise<Response>, title: string, parent: string | null, blocks: unknown[]) {
  const made = await (await call("/api/pages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, parent }) })).json() as { slug: string };
  const current = await (await call("/api/page/" + encodeURIComponent(made.slug))).json() as { page: { updated: number } };
  const saved = await call("/api/page/" + encodeURIComponent(made.slug), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, blocks, base_updated: current.page.updated }) });
  expect(saved.status).toBe(200);
  return made.slug;
}

let zip: Uint8Array;
let parentSlug = "";
let childSlug = "";
let mediaId = "";

beforeAll(async () => {
  const a = await boot(47911);
  const form = new FormData();
  form.set("file", new File([PNG], "dot.png", { type: "image/png" }));
  const up = await (await a.call("/api/upload", { method: "POST", body: form })).json() as { id: string; url: string };
  mediaId = up.id;
  parentSlug = await page(a.call, "아카이브 부모", null, [{ id: "p1", type: "paragraph", text: "부모 본문 **굵게**" }, { id: "i1", type: "image", text: "", meta: { src: up.url } }]);
  childSlug = await page(a.call, "아카이브 자식", parentSlug, [{ id: "c1", type: "to_do", text: "자식 할 일", checked: true }]);
  const res = await a.call("/__local/archive/export");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  zip = new Uint8Array(await res.arrayBuffer());
});

afterAll(async () => {
  for (const s of servers) { s.kill(); await s.exited; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("the export carries rows, the image original and a lossless markdown copy, and no secrets", async () => {
  const files = await readZip(zip);
  const parts = await readArchive(zip);
  expect(parts.manifest.format).toBe("acard-archive");
  expect(parts.tables.get("pages")!.map((r) => r.slug)).toEqual(expect.arrayContaining([parentSlug, childSlug]));
  expect(parts.tables.get("pages")!.find((r) => r.slug === childSlug)!.parent).toBe(parentSlug);
  expect(parts.media.get(mediaId)?.bytes).toEqual(PNG);
  const md = new TextDecoder().decode(files.get("markdown/" + parentSlug + ".md")!);
  expect(md).toContain("acard_meta: 1");
  expect(md).toContain("부모 본문 **굵게**");
  expect(md).toContain("/media/" + mediaId);
  for (const secret of ["agent_tokens", "agent_grants", "share_rules", "share_sessions"]) {
    expect(files.has("data/" + secret + ".json")).toBe(false);
    expect(parts.manifest.skipped).toContain(secret);
  }
});

test("restoring into a fresh data folder brings back the pages, the child link, the checked to-do and the image", async () => {
  const b = await boot(47912);
  await b.call("/api/tree");
  const before = await (await b.call("/api/page/" + encodeURIComponent(parentSlug))).json().catch(() => null) as { page?: unknown } | null;
  expect(before?.page).toBeFalsy();
  const res = await b.call("/__local/archive/import", { method: "POST", body: zip as BodyInit });
  const body = await res.json() as { ok: boolean; media: number; safetyBackup: string; tables: Record<string, number> };
  expect(res.status).toBe(200);
  expect(body.media).toBe(1);
  expect(existsSync(body.safetyBackup)).toBe(true);
  const parent = await (await b.call("/api/page/" + encodeURIComponent(parentSlug))).json() as { page: { title: string }; blocks: { type: string; text: string; meta?: { src?: string } }[] };
  expect(parent.page.title).toBe("아카이브 부모");
  expect(parent.blocks.find((x) => x.type === "image")?.meta?.src).toBe("/media/" + mediaId);
  const child = await (await b.call("/api/page/" + encodeURIComponent(childSlug))).json() as { page: { parent: string }; blocks: { text: string; checked: boolean }[] };
  expect(child.page.parent).toBe(parentSlug);
  expect(child.blocks[0]).toMatchObject({ text: "자식 할 일", checked: true });
  const image = await b.call("/media/" + mediaId);
  expect(image.status).toBe(200);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
  const search = await (await b.call("/api/search?q=" + encodeURIComponent("자식 할 일"))).json() as { results: { slug: string }[] };
  expect(search.results.map((r) => r.slug)).toContain(childSlug);
  const backups = await (await b.call("/__local/archive/backups")).json() as { backups: { name: string }[] };
  expect(backups.backups[0].name).toStartWith("before-restore-");
});

test("broken, foreign and hostile zips are refused before anything changes", async () => {
  const enc = new TextEncoder();
  await expect(readArchive(enc.encode("not a zip"))).rejects.toThrow(ArchiveError);
  await expect(readArchive(await writeZip([{ name: "hello.md", data: enc.encode("# hi") }]))).rejects.toThrow(/manifest/);
  await expect(readZip(await writeZip([{ name: "../evil.txt", data: enc.encode("x") }]))).rejects.toThrow(/경로/);
  const future = await writeZip([{ name: "manifest.json", data: enc.encode(JSON.stringify({ format: "acard-archive", version: 99 })) }]);
  await expect(readArchive(future)).rejects.toThrow(/새 버전/);
  const c = await boot(47913);
  const res = await c.call("/__local/archive/import", { method: "POST", body: enc.encode("not a zip") });
  expect(res.status).toBe(400);
  expect(existsSync(join(c.dataDir, "backups"))).toBe(false);
});

// Fixed bytes, no timestamps: one stored entry (media/), one deflated entry (data/pages.json), so each flip lands in a
// known place. A flip anywhere in a payload or in the central-directory CRC must be refused, never loaded silently.
test("a flipped byte in a stored payload, a deflated payload or the CRC is refused", async () => {
  const enc = new TextEncoder();
  const mediaId = "0123456789abcdef";
  const stored = Uint8Array.from({ length: 200 }, (_, i) => i);
  const pages = enc.encode(JSON.stringify([{ slug: "intact", title: "손상 검사 ".repeat(20) }]));
  const manifest = enc.encode(JSON.stringify({ format: "acard-archive", version: 1, created: 0, source: "test", app: "test", tables: { pages: 1 }, media: [{ id: mediaId, name: "bytes.bin", mime: "application/octet-stream", bytes: stored.length }], skipped: [] }));
  const good = await writeZip([{ name: "manifest.json", data: manifest }, { name: "data/pages.json", data: pages }, { name: "media/" + mediaId, data: stored }]);
  const parts = await readArchive(good);
  expect(parts.media.get(mediaId)!.bytes).toEqual(stored);
  expect(parts.tables.get("pages")![0].slug).toBe("intact");

  const view = new DataView(good.buffer, good.byteOffset, good.byteLength);
  const entry = (name: string) => {
    const eocd = good.length - 22;
    let pos = view.getUint32(eocd + 16, true);
    for (let n = 0; n < view.getUint16(eocd + 10, true); n++) {
      const nameLen = view.getUint16(pos + 28, true);
      if (new TextDecoder().decode(good.subarray(pos + 46, pos + 46 + nameLen)) === name) {
        const offset = view.getUint32(pos + 42, true);
        return { central: pos, method: view.getUint16(pos + 10, true), start: offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true), size: view.getUint32(pos + 20, true) };
      }
      pos += 46 + nameLen + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
    }
    throw new Error("no entry " + name);
  };
  const flipped = (at: number) => { const bad = good.slice(); bad[at] ^= 0xff; return bad; };
  const media = entry("media/" + mediaId);
  const deflated = entry("data/pages.json");
  expect([media.method, deflated.method]).toEqual([0, 8]);

  await expect(readArchive(flipped(media.start + 100))).rejects.toThrow(/손상/);
  await expect(readArchive(flipped(media.start + media.size - 1))).rejects.toThrow(/손상/);
  await expect(readArchive(flipped(deflated.start + (deflated.size >> 1)))).rejects.toThrow(ArchiveError);
  // The first deflate byte breaks the stream itself: still a refusal the import routes answer with 400, not a crash.
  await expect(readArchive(flipped(deflated.start))).rejects.toThrow(ArchiveError);
  await expect(readArchive(flipped(media.central + 16))).rejects.toThrow(/손상/);

  const c = await boot(47914);
  const res = await c.call("/__local/archive/import", { method: "POST", body: flipped(deflated.start) as BodyInit });
  expect(res.status).toBe(400);
  expect(existsSync(join(c.dataDir, "backups"))).toBe(false);
});
