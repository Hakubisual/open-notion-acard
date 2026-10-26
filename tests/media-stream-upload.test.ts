import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { hybridMedia } from "../gate/media-store";
import { byteRange, streamMime } from "../gate/_worker.js";
import { setup, cookie } from "./db-harness";

class FakeDurableObject { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } }
class FakeWorkerEntrypoint { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } }
mock.module("cloudflare:workers", () => ({ DurableObject: FakeDurableObject, WorkerEntrypoint: FakeWorkerEntrypoint }));
const { WorkspaceStore } = await import("../workers/acard-workspace/index.js");

// Cloudflare's FixedLengthStream: the readable side errors when the bytes written are not exactly the declared length.
class TestFixedLengthStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  constructor(length: number) {
    let seen = 0;
    const pass = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { seen += chunk.byteLength; if (seen > length) throw new Error("too many bytes"); controller.enqueue(chunk); },
      flush() { if (seen !== length) throw new Error("stream ended short"); },
    });
    this.readable = pass.readable;
    this.writable = pass.writable;
  }
}
(globalThis as any).FixedLengthStream = TestFixedLengthStream;

function sqlStorage(sqlite: Database) {
  return {
    sql: {
      exec: (sql: string, ...params: unknown[]) => {
        const rows = sqlite.query(sql).all(...(params as any[])) as any[];
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
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
    list: async () => ({ keys: [], list_complete: true }),
  };
}

// R2 that reads a stream body to its end (an erroring stream fails the put and stores nothing) and serves ranges.
function memoryR2() {
  const objects = new Map<string, { bytes: Uint8Array; meta: string; type: string }>();
  const view = (key: string, o: { bytes: Uint8Array; meta: string }, part = o.bytes) => ({
    key, size: o.bytes.byteLength, customMetadata: { meta: o.meta }, httpEtag: '"e-' + key.length + '"',
    body: new Response(part as BodyInit).body, arrayBuffer: async () => part.slice().buffer, text: async () => new TextDecoder().decode(part),
  });
  return {
    objects,
    get: async (key: string, options: any = {}) => {
      const o = objects.get(key);
      if (!o) return null;
      const r = options.range;
      return view(key, o, r ? o.bytes.subarray(r.offset, r.offset + r.length) : o.bytes);
    },
    head: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    put: async (key: string, value: any, options: any) => {
      const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(value);
      objects.set(key, { bytes, meta: options.customMetadata.meta, type: options.httpMetadata.contentType });
      return { httpEtag: '"e-' + key.length + '"', size: bytes.byteLength };
    },
    delete: async (key: string) => { objects.delete(key); },
    list: async () => ({ objects: [], truncated: false }),
  };
}

function mp4(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  for (let i = 16; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

async function harness() {
  const h = setup();
  await h.call("POST", "/api/pages", { slug: "clips" });
  const kv = memoryKv(), r2 = memoryR2();
  const ledger = new (WorkspaceStore as any)({ storage: sqlStorage(new Database(":memory:")) }, {});
  h.env.MEDIA = hybridMedia(kv as any, r2 as any);
  h.env.WORKSPACE = { idFromName: (name: string) => name, get: () => ledger };
  const auth = await cookie();
  const request = (path: string, init: RequestInit = {}) => h.worker.fetch(new Request("https://notes.test" + path, { ...init, headers: { cookie: auth, ...(init.headers as any) } }), h.env) as Promise<Response>;
  const stream = (body: BodyInit | ReadableStream, size: number, type = "video/mp4", name = "clip.mp4") =>
    request("/api/upload?stream=1&page=clips&name=" + encodeURIComponent(name), { method: "POST", body: body as any, headers: { "content-type": type, "content-length": String(size) }, duplex: "half" } as any);
  const state = async () => ({ used: Number((await ledger.mediaUsage(0, Infinity)).used), leases: (await ledger.mediaSweep(0)).open });
  return { ...h, kv, r2, ledger, request, stream, state };
}

describe("streamed upload (POST /api/upload?stream=1)", () => {
  test("a 6 MB mp4 goes to R2 whole, its row is written and the ledger counts it once with no lease left", async () => {
    const h = await harness();
    const bytes = mp4(6 * 1024 * 1024);
    const res = await h.stream(bytes, bytes.byteLength);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, mime: "video/mp4", size: bytes.byteLength, name: "clip.mp4" });
    expect(h.r2.objects.get("media/" + body.id)!.bytes).toEqual(bytes);
    expect(h.sqlite.query("SELECT bytes, mime FROM media WHERE id = ?").get(body.id)).toEqual({ bytes: bytes.byteLength, mime: "video/mp4" });
    expect(await h.state()).toEqual({ used: bytes.byteLength, leases: 0 });
  });

  test("bytes that are not the declared type are refused with 415, nothing is stored and the ledger is back to 0", async () => {
    const h = await harness();
    const exe = new Uint8Array(5 * 1024 * 1024); exe.set([0x4d, 0x5a, 0x90, 0]);
    const res = await h.stream(exe, exe.byteLength, "video/mp4", "clip.mp4");
    expect(res.status).toBe(415);
    expect(h.r2.objects.size).toBe(0);
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM media").get()).toEqual({ n: 0 });
    expect(await h.state()).toEqual({ used: 0, leases: 0 });
  });

  test("a body that breaks off mid-way stores nothing and gives every reserved byte back exactly once", async () => {
    const h = await harness();
    const head = mp4(1024 * 1024);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(head); },
      pull(controller) { controller.error(new Error("network gone")); },
    });
    const res = await h.stream(broken, 20 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(h.r2.objects.size).toBe(0);
    expect(await h.state()).toEqual({ used: 0, leases: 0 });
  });

  test("a body shorter than its content-length is not stored", async () => {
    const h = await harness();
    const bytes = mp4(5 * 1024 * 1024);
    const res = await h.stream(new Response(bytes).body!, bytes.byteLength + 1000);
    expect(res.status).toBe(400);
    expect(h.r2.objects.size).toBe(0);
    expect(await h.state()).toEqual({ used: 0, leases: 0 });
  });

  test("over 50 MB is refused with 413 before anything is reserved; no content-length is 411", async () => {
    const h = await harness();
    const res = await h.stream(mp4(16), 50 * 1024 * 1024 + 1);
    expect(res.status).toBe(413);
    expect((await res.json() as any).error).toContain("50MB");
    expect(await h.state()).toEqual({ used: 0, leases: 0 });
  });

  test("a full global ledger refuses the upload and holds no lease", async () => {
    const h = await harness();
    await h.ledger.mediaSetUsage(100 * 1000 * 1000 * 1000);
    const bytes = mp4(5 * 1024 * 1024);
    const res = await h.stream(bytes, bytes.byteLength);
    expect(res.status).toBe(507);
    expect(h.r2.objects.size).toBe(0);
    expect((await h.ledger.mediaSweep(0)).open).toBe(0);
  });

  test("/api/media-usage tells the editor the 50 MB file limit", async () => {
    const h = await harness();
    const usage = await (await h.request("/api/media-usage")).json() as any;
    expect(usage.uploadLimit).toBe(50 * 1024 * 1024);
  });
});

describe("media lease ledger (acard-workspace global:media)", () => {
  const fresh = () => new (WorkspaceStore as any)({ storage: sqlStorage(new Database(":memory:")) }, {});
  test("reserve then commit counts the bytes once; a repeated reserve or commit adds nothing", async () => {
    const ledger = fresh();
    expect((await ledger.mediaReserve("w:a", 1000, Infinity, 60_000)).ok).toBe(true);
    expect((await ledger.mediaReserve("w:a", 1000, Infinity, 60_000)).used).toBe(1000);
    await ledger.mediaCommit("w:a", 1000);
    expect((await ledger.mediaUsage(0, Infinity)).used).toBe(1000);
    expect((await ledger.mediaRelease("w:a")).released).toBe(0);
    expect((await ledger.mediaUsage(0, Infinity)).used).toBe(1000);
  });

  test("release gives the bytes back once; a second release gives nothing", async () => {
    const ledger = fresh();
    await ledger.mediaReserve("w:b", 700, Infinity, 60_000);
    expect((await ledger.mediaRelease("w:b")).released).toBe(700);
    expect((await ledger.mediaRelease("w:b")).released).toBe(0);
    expect((await ledger.mediaUsage(0, Infinity)).used).toBe(0);
  });

  test("an abandoned lease (tab closed mid-upload) is released by the sweep once it expires, and only then", async () => {
    const ledger = fresh();
    await ledger.mediaReserve("w:c", 40_000_000, Infinity, 60_000);
    expect((await ledger.mediaSweep(Date.now())).released).toBe(0);
    expect((await ledger.mediaSweep(Date.now() + 60_001)).released).toBe(40_000_000);
    expect((await ledger.mediaUsage(0, Infinity)).used).toBe(0);
    expect((await ledger.mediaSweep(Date.now() + 120_000)).released).toBe(0);
  });

  test("a commit that arrives after its lease was swept counts the stored bytes again, so the total matches R2", async () => {
    const ledger = fresh();
    await ledger.mediaReserve("w:d", 500, Infinity, 60_000);
    await ledger.mediaSweep(Date.now() + 60_001);
    expect((await ledger.mediaCommit("w:d", 500)).recounted).toBe(true);
    expect((await ledger.mediaUsage(0, Infinity)).used).toBe(500);
  });

  test("the cap counts held leases: a reserve past it is refused and holds nothing", async () => {
    const ledger = fresh();
    await ledger.mediaReserve("w:e", 800, 1000, 60_000);
    expect((await ledger.mediaReserve("w:f", 300, 1000, 60_000)).ok).toBe(false);
    expect((await ledger.mediaSweep(0)).open).toBe(1);
    expect((await ledger.mediaUsage(0, Infinity)).used).toBe(800);
  });
});

describe("Range on /media/<id> (video seeking)", () => {
  test("a streamed R2 original answers bytes=a-b with 206 and the exact slice; no Range is the whole file", async () => {
    const h = await harness();
    const bytes = mp4(6 * 1024 * 1024);
    const up = await (await h.stream(bytes, bytes.byteLength)).json() as any;
    const part = await h.request(up.url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/" + bytes.byteLength);
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200));
    const tail = await h.request(up.url, { headers: { range: "bytes=-10" } });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(bytes.byteLength - 10));
    const whole = await h.request(up.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect((await whole.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    const bad = await h.request(up.url, { headers: { range: "bytes=" + bytes.byteLength + "-" } });
    expect(bad.status).toBe(416);
  });

  test("byteRange and streamMime parse what browsers send", () => {
    expect(byteRange("bytes=0-", 10)).toEqual({ offset: 0, length: 10 });
    expect(byteRange("bytes=5-100", 10)).toEqual({ offset: 5, length: 5 });
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(byteRange("bytes=10-", 10)).toBe("bad");
    const qt = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]);
    expect(streamMime("video/mp4", qt.buffer)).toBe("video/quicktime");
    expect(streamMime("audio/mpeg", Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBe("audio/mpeg");
    expect(streamMime("video/mp4", Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBeNull();
    expect(streamMime("text/plain", new Uint8Array(16).buffer)).toBeNull();
  });
});
