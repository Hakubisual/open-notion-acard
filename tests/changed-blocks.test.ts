import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { assembleWorkerSource } from "./assemble-worker";

const source = assembleWorkerSource();
let sqlite: Database, worker: any, env: any, cookie: string;
let beforeBatch: (() => void) | undefined;
const block = (id: string, text = id) => ({ id, type: "paragraph", text, checked: false, indent: 0 });
beforeEach(async () => {
  sqlite = new Database(":memory:");
  beforeBatch = undefined;
  const statement = (sql: string, params: any[] = []) => ({
    bind: (...values: any[]) => statement(sql, values),
    execute: () => ({ success: true, meta: { changes: sqlite.query(sql).run(...params).changes } }),
    run: async () => statement(sql, params).execute(),
    all: async () => ({ results: sqlite.query(sql).all(...params) }),
    first: async () => sqlite.query(sql).get(...params) ?? null,
  });
  env = { GATE_PASSWORD: "test-pw", GATE_SECRET: "test-secret",
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    DB: { prepare: statement, batch: async (items: ReturnType<typeof statement>[]) => {
      const run = beforeBatch; beforeBatch = undefined; run?.();
      return sqlite.transaction(() => items.map(item => item.execute()))();
    } },
  };
  worker = new Function(source)();
  const login = await worker.fetch(new Request("https://notes.test/__gate", { method: "POST", body: new URLSearchParams({ pw: "test-pw" }) }), env);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const created = await call("/api/pages", "POST", { slug: "delta", title: "Delta" });
  expect(created.status).toBe(200);
  expect((await call("/api/page/delta", "PUT", { title: "Delta", base_updated: (await created.json()).updated, blocks: Array.from({ length: 300 }, (_, i) => block("b" + i)) })).status).toBe(200);
  sqlite.exec("CREATE TABLE block_writes (id TEXT, operation TEXT); CREATE TRIGGER track_update AFTER UPDATE ON blocks BEGIN INSERT INTO block_writes VALUES (new.id, 'update'); END; CREATE TRIGGER track_insert AFTER INSERT ON blocks BEGIN INSERT INTO block_writes VALUES (new.id, 'insert'); END; CREATE TRIGGER track_delete AFTER DELETE ON blocks BEGIN INSERT INTO block_writes VALUES (old.id, 'delete'); END");
});
afterEach(() => sqlite.close());
function call(path: string, method = "GET", body?: unknown) {
  return worker.fetch(new Request("https://notes.test" + path, { method, headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }), env) as Promise<Response>;
}
async function current() { return (await call("/api/page/delta")).json() as Promise<any>; }
async function patch(body: any) {
  return call("/api/page/delta/blocks", "PATCH", { base_updated: (await current()).page.updated, upserts: [], deletes: [], ...body });
}

test("one-letter edit in 300 blocks touches one row and refreshes search", async () => {
  const before = await current();
  const response = await patch({ upserts: [{ ...block("b140", "b140x quasar"), ord: 140 }] });
  expect(response.status).toBe(200);
  const result = await response.json() as any;
  expect(result.updated).toBeGreaterThan(before.page.updated);
  expect(typeof result.hash).toBe("string");
  expect(sqlite.query("SELECT * FROM block_writes").all()).toEqual([{ id: "b140", operation: "update" }]);
  expect((await current()).blocks.filter((b: any, i: number) => b.text !== before.blocks[i].text).map((b: any) => b.id)).toEqual(["b140"]);
  expect((sqlite.query("SELECT body FROM page_fts WHERE slug = 'delta'").get() as any).body).toContain("quasar");
  const found = await (await call("/api/search?q=quasar")).json() as any;
  expect(found.results.map((row: any) => row.slug)).toEqual(["delta"]);
});

test("delete, insertion and reorder preserve untouched block content and links", async () => {
  await call("/api/page/delta", "PUT", { title: "Delta", base_updated: (await current()).page.updated, blocks: [block("a", "[[keep]] [[gone]]"), block("b", "[[keep]]"), block("c")] });
  sqlite.exec("DELETE FROM block_writes");
  expect((await patch({ deletes: ["a"], upserts: [{ ...block("d", "[[new]]"), ord: 1 }], order: ["c", "d", "b"] })).status).toBe(200);
  expect((await current()).blocks).toEqual([block("c"), block("d", "[[new]]"), block("b", "[[keep]]")]);
  expect(sqlite.query("SELECT dst FROM links WHERE src = 'delta' ORDER BY dst").all()).toEqual([{ dst: "keep" }, { dst: "new" }]);
  expect(sqlite.query("SELECT * FROM block_writes WHERE operation = 'delete'").all()).toEqual([{ id: "a", operation: "delete" }]);
});

test("base mismatch returns current and leaves content and history untouched", async () => {
  const before = await current();
  const history = sqlite.query("SELECT * FROM editor_history").all();
  const response = await patch({ base_updated: before.page.updated - 1, upserts: [{ ...block("b0", "stale"), ord: 0 }] });
  expect(response.status).toBe(409);
  expect((await response.json() as any).current.blocks).toEqual(before.blocks);
  expect(sqlite.query("SELECT * FROM block_writes").all()).toEqual([]);
  expect(sqlite.query("SELECT * FROM editor_history").all()).toEqual(history);
});

test("transaction rechecks a racing writer before history or block mutations", async () => {
  const base = (await current()).page.updated;
  const history = sqlite.query("SELECT * FROM editor_history").all();
  beforeBatch = () => sqlite.query("UPDATE pages SET updated = ? WHERE slug = 'delta'").run(base + 1);
  const response = await call("/api/page/delta/blocks", "PATCH", { base_updated: base, upserts: [{ ...block("b0", "lost"), ord: 0 }], deletes: [] });
  expect(response.status).toBe(409);
  expect(sqlite.query("SELECT * FROM block_writes").all()).toEqual([]);
  expect(sqlite.query("SELECT * FROM editor_history").all()).toEqual(history);
});

test("failed mutation rolls history and all writes back in the same batch", async () => {
  const before = await current();
  const history = sqlite.query("SELECT * FROM editor_history").all();
  sqlite.exec("CREATE TRIGGER reject_delta BEFORE UPDATE ON blocks WHEN new.text = 'reject' BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
  expect((await patch({ upserts: [{ ...block("b0", "reject"), ord: 0 }] })).status).toBe(500);
  expect(await current()).toEqual(before);
  expect(sqlite.query("SELECT * FROM editor_history").all()).toEqual(history);
});

test("diff history restores raw blocks, title, links and editor settings", async () => {
  await call("/api/page/delta/settings", "PUT", { icon: "star", width: "full" });
  const before = await current();
  expect((await patch({ title: "Changed", upserts: [{ ...block("b0", "new"), ord: 0 }] })).status).toBe(200);
  const history = await (await call("/api/page/delta/history")).json() as any;
  const version = history.versions[0];
  const snapshot = JSON.parse((sqlite.query("SELECT snapshot FROM editor_history WHERE id = ?").get(version.id) as any).snapshot);
  expect(snapshot.blocks).toHaveLength(300);
  expect(snapshot.blocks[0]).toMatchObject({ page: "delta", id: "b0", ord: 0, checked: 0, meta: null });
  expect((await call("/api/page/delta/history/" + version.id + "/restore", "POST")).status).toBe(200);
  const restored = await current();
  expect(restored.blocks).toEqual(before.blocks);
  expect(restored.page.title).toBe(before.page.title);
  expect(restored.settings).toEqual(before.settings);
});

test("invalid order and duplicate IDs fail without mutation; route stays gated", async () => {
  for (const body of [{ order: ["b0"] }, { upserts: [{ ...block("b0"), ord: 1 }] }, { deletes: ["missing"] },
    { upserts: [{ ...block("b0"), ord: 0 }, { ...block("b0"), ord: 0 }] }]) expect((await patch(body)).status).toBe(400);
  expect(sqlite.query("SELECT * FROM block_writes").all()).toEqual([]);
  const response = await worker.fetch(new Request("https://notes.test/api/page/delta/blocks", { method: "PATCH", body: "{}" }), env);
  expect(response.status).toBe(401);
});

const entry = readFileSync(new URL("../assets/features/changed-blocks.js", import.meta.url), "utf8");
const lazy = readFileSync(new URL("../assets/features/lazy/changed-blocks.js", import.meta.url), "utf8");
const queueSource = readFileSync(new URL("../assets/features/save-queue.js", import.meta.url), "utf8");
function client() {
  const requests: { method: string; body?: any }[] = [];
  const listeners = new Map<string, (snapshot: unknown) => void>();
  const editor: any = { api: async (path: string) => { requests.push({ method: "GET" }); return (await call("/api" + path)).json(); },
    transport: async (slug: string, body: any) => { requests.push({ method: "PUT", body }); return call("/api/page/" + slug, "PUT", body); },
    provide: (_: string, api: any) => { editor.feature = api; }, lazy: async () => editor.feature,
    slug: "delta", on: (event: string, listener: (snapshot: unknown) => void) => listeners.set(event, listener),
    emit: (event: string, snapshot: unknown) => listeners.get(event)?.(snapshot) };
  const context: any = { window: { AcardEditor: editor }, Map, Response, JSON, Promise,
    fetch: async (path: string, options: any) => {
      const body = JSON.parse(options.body); requests.push({ method: options.method, body });
      return call(path, options.method, body);
    } };
  runInNewContext(lazy, context); runInNewContext(entry, context);
  return { editor, requests };
}

test("an adopted remote baseline lets the next edit save without restoring old content", async () => {
  const { editor, requests } = client();
  const first = await current();
  await editor.transport("delta", { title: first.page.title, blocks: first.blocks, base_updated: first.page.updated });
  await patch({ upserts: [{ ...block("b0", "remote"), ord: 0 }] });
  const remote = await current();
  editor.emit("remoteAdopted", { title: remote.page.title, blocks: remote.blocks, updated: remote.page.updated });
  remote.blocks[1].text = "local after remote";

  const response = await editor.transport("delta", { title: remote.page.title, blocks: remote.blocks, base_updated: remote.page.updated });

  expect(response.status).toBe(200);
  expect((await current()).blocks.slice(0, 2).map((entry: { text: string }) => entry.text)).toEqual(["remote", "local after remote"]);
  expect(requests.at(-1)?.body.upserts.map((entry: { id: string }) => entry.id)).toEqual(["b1"]);
});

test("client sends one block, then only order, and retains the draft without PUT on 409", async () => {
  const { editor, requests } = client();
  const loaded = await current();
  const payload = { title: loaded.page.title, blocks: loaded.blocks, base_updated: loaded.page.updated };
  payload.blocks[140].text += "x";
  expect((await editor.transport("delta", payload)).status).toBe(200);
  expect(requests.map(r => r.method)).toEqual(["GET", "PATCH"]);
  expect(requests[1].body.upserts).toHaveLength(1);
  expect(requests[1].body.order).toBeUndefined();
  expect(JSON.stringify(requests[1].body).length).toBeLessThan(JSON.stringify(payload).length / 100);
  payload.base_updated = (await current()).page.updated;
  [payload.blocks[0], payload.blocks[1]] = [payload.blocks[1], payload.blocks[0]];
  await editor.transport("delta", payload);
  expect(requests[2].body.upserts).toEqual([]);
  expect(requests[2].body.order).toHaveLength(300);
  payload.base_updated = (await current()).page.updated;
  await patch({ upserts: [{ ...block("b2", "external"), ord: 2 }] });
  payload.blocks[2].text = "local";
  const context: any = { Promise, Map, Date, JSON, Math, Response };
  runInNewContext(queueSource, context);
  const records = new Map();
  const queue = context.AcardSaveQueue.create({ identity: "member-a", storage: { read: () => [], write: (entry: any) => records.set(entry.slug, entry) }, send: editor.transport });
  await queue.ready;
  queue.enqueue("delta", payload);
  expect((await queue.attempt("delta", true)).status).toBe(409);
  expect(requests.map(r => r.method)).toEqual(["GET", "PATCH", "PATCH", "PATCH"]);
  expect(queue.get("delta").blocked).toBe(409);
  expect(records.get("delta").payload.blocks[2].text).toBe("local");
  expect((await current()).blocks[2].text).toBe("external");
});

test("persisted queue keeps full drafts and computes a fresh diff after reload", async () => {
  const context: any = { Promise, Map, Date, JSON, Math, Response };
  runInNewContext(queueSource, context);
  const records = new Map<string, any>();
  const storage = { read: () => [...records.values()], write: (entry: any) => { records.set(entry.slug, structuredClone(entry)); } };
  const loaded = await current();
  const payload = { title: loaded.page.title, blocks: loaded.blocks, base_updated: loaded.page.updated };
  payload.blocks[99].text += "x";
  const offline = context.AcardSaveQueue.create({ identity: "member-a", storage, send: async () => { throw new Error("offline"); } });
  await offline.ready; offline.enqueue("delta", payload);
  await expect(offline.attempt("delta", true)).rejects.toThrow("offline");
  expect(records.get("delta").payload.blocks).toHaveLength(300);
  expect(records.get("delta").payload.base_updated).toBe(loaded.page.updated);
  expect(records.get("delta").acard_id).toBe("member-a");
  const { editor, requests } = client();
  const reloaded = context.AcardSaveQueue.create({ identity: "member-a", storage, send: editor.transport });
  await reloaded.ready; await reloaded.attempt("delta", true);
  expect(requests.map(r => r.method)).toEqual(["GET", "PATCH"]);
  expect(requests[1].body.upserts.map((b: any) => b.id)).toEqual(["b99"]);
  expect(reloaded.entries()).toEqual([]);
});


const col = (id: string, type: string, indent: number, text = "", meta: any = null) => ({ id, type, text, checked: false, indent, meta });
const tree = (blocks: any[]) => blocks.map((b: any) => b.id + ":" + b.type + ":" + b.indent);

test("PUT turns old text-only columns into column blocks and keeps every letter (notion-parity C13)", async () => {
  expect((await call("/api/page/delta", "PUT", { title: "Delta", base_updated: (await current()).page.updated, blocks: [col("k", "columns", 0, "", { columns: [{ text: "a\nb" }, { text: "" }] })] })).status).toBe(200);
  const saved = (await current()).blocks;
  expect(saved.map((b: any) => b.type + ":" + b.indent + ":" + b.text)).toEqual(["columns:0:", "column:1:", "paragraph:2:a", "paragraph:2:b", "column:1:"]);
  expect(saved[0].meta.columns).toBeUndefined();
});

test("PUT moves columns at indent 5 up to 2 and the tree reads back the same (notion-parity C13)", async () => {
  const blocks = [col("p0", "paragraph", 0, "p0"), col("p1", "paragraph", 1, "p1"), col("p2", "paragraph", 2, "p2"), col("p3", "paragraph", 3, "p3"), col("p4", "paragraph", 4, "p4"),
    col("cs", "columns", 5, "", { widths: [0.5, 0.5] }), col("c1", "column", 6), col("a", "paragraph", 6, "a"), col("c2", "column", 6), col("b", "paragraph", 6, "b")];
  // The client sends children at 7 (cut to 6 per block); whole-page rules then lift the branch to 2.
  blocks[7].indent = 7; blocks[9].indent = 7;
  expect((await call("/api/page/delta", "PUT", { title: "Delta", base_updated: (await current()).page.updated, blocks })).status).toBe(200);
  expect(tree((await current()).blocks).slice(5)).toEqual(["cs:columns:2", "c1:column:3", "a:paragraph:4", "c2:column:3", "b:paragraph:4"]);
});

test("PATCH that moves a nested columns branch to another outer column keeps parents and loses no block (notion-parity C13)", async () => {
  const start = [col("o", "columns", 0, "", { widths: [0.5, 0.5] }), col("L", "column", 1), col("n", "columns", 2, "", { widths: [0.5, 0.5] }),
    col("n1", "column", 3), col("x", "paragraph", 4, "x"), col("n2", "column", 3), col("y", "paragraph", 4, "y"), col("R", "column", 1), col("r", "paragraph", 2, "r")];
  expect((await call("/api/page/delta", "PUT", { title: "Delta", base_updated: (await current()).page.updated, blocks: start })).status).toBe(200);
  // What the editor's changed-blocks client sends: the moved branch only gets a new place in order; untouched outer
  // columns and column blocks are not in upserts.
  const order = ["o", "L", "R", "r", "n", "n1", "x", "n2", "y"];
  const response = await patch({ order });
  expect(response.status).toBe(200);
  const saved = (await current()).blocks;
  expect(tree(saved)).toEqual(["o:columns:0", "L:column:1", "R:column:1", "r:paragraph:2", "n:columns:2", "n1:column:3", "x:paragraph:4", "n2:column:3", "y:paragraph:4"]);
  expect(saved).toHaveLength(start.length);
});

test("PATCH that leaves a column without its columns parent lifts its blocks instead of dropping them (notion-parity C13)", async () => {
  expect((await call("/api/page/delta", "PUT", { title: "Delta", base_updated: (await current()).page.updated, blocks: [col("o", "columns", 0, "", { widths: [0.5, 0.5] }), col("L", "column", 1), col("a", "paragraph", 2, "a"), col("R", "column", 1), col("b", "paragraph", 2, "b")] })).status).toBe(200);
  const response = await patch({ deletes: ["o"], order: ["L", "a", "R", "b"] });
  expect(response.status).toBe(200);
  expect((await response.json() as any).reshaped).toBe(true);
  const saved = (await current()).blocks;
  expect(saved.map((b: any) => b.id + ":" + b.indent + ":" + b.text)).toEqual(["a:1:a", "b:1:b"]);
  expect(sqlite.query("SELECT id FROM blocks WHERE page = 'delta' ORDER BY ord").all().map((r: any) => r.id)).toEqual(["a", "b"]);
});
