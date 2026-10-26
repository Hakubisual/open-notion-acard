import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const queueSource = readFileSync(new URL("../assets/features/save-queue.js", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const lazySource = readFileSync(new URL("../assets/features/lazy/changed-blocks.js", import.meta.url), "utf8");
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function localStore() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (i: number) => [...values.keys()][i],
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function queueApi() {
  const context: any = { Promise, Map, Date, JSON, Math, Response, setTimeout, clearTimeout };
  runInNewContext(queueSource, context);
  return context.AcardSaveQueue;
}
const draft = (text = "draft", base_updated = 10) => ({ title: "Title", blocks: [{ id: "b1", type: "paragraph", text }], base_updated });

test("journal partitions identities, preserves the original base, and quarantines legacy drafts", async () => {
  const api = queueApi(), local = localStore(), sent: any[] = [];
  local.setItem("acard-save-queue:page", JSON.stringify({ slug: "page", payload: draft("legacy"), sequence: 1 }));
  const make = (identity: string) => api.create({ identity, storage: api.storage(local, null, identity),
    send: async (_: string, payload: any) => { sent.push(payload); return new Response("{}", { status: 409 }); } });
  const a = make("member-a"); await a.ready; a.enqueue("page", draft("A"));
  expect(JSON.parse(local.getItem("acard-save-queue:member-a:page")!)).toMatchObject({ acard_id: "member-a", base_updated: 10, payload: draft("A") });
  const b = make("member-b"); await b.ready; await b.flush(true);
  expect(b.entries()).toEqual([]); expect(sent).toEqual([]);
  b.enqueue("page", draft("B", 20)); await b.flush(true);
  expect(sent).toEqual([draft("B", 20)]);
  const restored = make("member-a"); await restored.ready; await restored.flush(true);
  expect(sent[1]).toEqual(draft("A"));
  expect(restored.get("page").blocked).toBe(409);
  restored.enqueue("page", draft("A, still editing")); await restored.flush(true);
  expect(sent).toHaveLength(2);
  expect(local.values.size).toBe(3);
});

test("IndexedDB names are identity scoped and persisted entries include identity and base", async () => {
  const api = queueApi(), opened: string[] = [], stored: any[] = [];
  const indexed = { open(name: string) {
    opened.push(name);
    const request: any = {};
    const db = { objectStoreNames: { contains: () => true }, close() {}, transaction() {
      const tx: any = { objectStore: () => ({
        getAll() { const read: any = {}; queueMicrotask(() => { read.result = stored; read.onsuccess(); }); return read; },
        put(entry: any) { stored.push(entry); queueMicrotask(() => tx.oncomplete()); }
      }) }; return tx;
    } };
    queueMicrotask(() => { request.result = db; request.onsuccess(); }); return request;
  } };
  const storage = api.storage(null, indexed, "member-a");
  const q = api.create({ identity: "member-a", storage, send: async () => new Response("{}", { status: 409 }) });
  await q.ready; q.enqueue("page", draft()); await q.attempt("page", true);
  expect(opened).toEqual(["acard-save-queue:member-a"]);
  expect(stored[0]).toMatchObject({ acard_id: "member-a", base_updated: 10, payload: draft() });
});

test("missing identity never reads or persists private drafts", async () => {
  const api = queueApi(), local = localStore(); let opened = false, read = false, written = false;
  const store = api.storage(local, { open() { opened = true; } }, "");
  expect(await store.read()).toEqual([]); await store.write({ slug: "page", payload: draft() });
  const q = api.create({ storage: { read() { read = true; return []; }, write() { written = true; } }, send: async () => new Response("{}") });
  await q.ready; q.enqueue("page", draft());
  expect([opened, read, written, local.length]).toEqual([false, false, false, 0]);
});

test("foreign entries are ignored even if returned by the current identity store", async () => {
  const api = queueApi(); let sent = false;
  const q = api.create({ identity: "member-b", storage: { read: () => [{ slug: "page", acard_id: "member-a", payload: draft(), base_updated: 10, sequence: 1 }], write() {} },
    send: async () => { sent = true; return new Response("{}"); } });
  await q.ready; await q.flush(true); expect(q.entries()).toEqual([]); expect(sent).toBe(false);
});

test("only an acknowledged in-flight save rebases newer typing", async () => {
  const api = queueApi(), started = deferred(), response = deferred<Response>(), sent: any[] = [];
  const q = api.create({ identity: "member-a", storage: { read: () => [], write() {} }, send: async (_: string, payload: any) => {
    sent.push(payload); started.resolve(null); return response.promise;
  } });
  await q.ready; q.enqueue("page", draft("first")); const saving = q.attempt("page", true); await started.promise;
  q.enqueue("page", draft("second")); response.resolve(new Response(JSON.stringify({ updated: 11 }))); await saving;
  expect(q.get("page").payload).toEqual(draft("second", 11));
  expect(q.get("page").base_updated).toBe(11);
  expect(sent).toEqual([draft("first")]);
});

test("late shared recovery cannot replace or rebase this tab's in-flight draft", async () => {
  const api = queueApi(), recovered = deferred<any[]>(), started = deferred(), response = deferred<Response>();
  const local = localStore(), store = api.storage(local, null, "member-a"), sent: any[] = [];
  const foreign = { slug: "page", acard_id: "member-a", base_updated: 10, payload: draft("BASE_PRIMED"), sequence: 999999, attempts: 0, nextAt: 0 };
  const q = api.create({ identity: "member-a", now: () => 100, storage: { read: () => recovered.promise, write: store.write },
    send: async (_: string, payload: any) => { sent.push(payload); started.resolve(null); return response.promise; } });
  q.enqueue("page", draft("NEWER_X")); const saving = q.attempt("page", true); await started.promise;
  recovered.resolve([foreign]); await q.ready;
  response.resolve(Response.json({ updated: 11 })); await saving; await q.flush(true);
  expect(sent).toEqual([draft("NEWER_X")]);
  expect(q.entries()).toEqual([]);
  expect(JSON.parse(local.getItem("acard-save-queue:member-a:page")!).payload).toBeNull();
  const restored = api.create({ identity: "member-a", storage: store, send: async () => { throw Error("acknowledged draft replayed"); } });
  await restored.ready; expect(restored.entries()).toEqual([]);
});

test("a conflict arriving during newer typing blocks and preserves that newer draft", async () => {
  const api = queueApi(), started = deferred(), response = deferred<Response>(); let calls = 0;
  const q = api.create({ identity: "member-a", storage: { read: () => [], write() {} }, send: async () => { calls++; started.resolve(null); return response.promise; } });
  await q.ready; q.enqueue("page", draft("first")); const saving = q.attempt("page", true); await started.promise;
  q.enqueue("page", draft("second")); response.resolve(new Response("{}", { status: 409 })); await saving; await q.flush(true);
  expect(q.get("page").payload).toEqual(draft("second")); expect(q.get("page").blocked).toBe(409); expect(calls).toBe(1);
});

test("stale replay cannot adopt a newer GET baseline or call PUT", async () => {
  let feature: any, writes = 0;
  const editor = { api: async () => ({ page: { title: "remote", updated: 11 }, blocks: [] }), provide: (_: string, value: any) => { feature = value; } };
  runInNewContext(lazySource, { window: { AcardEditor: editor }, Response, fetch: () => { writes++; } });
  expect((await feature.send("page", draft(), () => { writes++; })).status).toBe(409);
  expect(writes).toBe(0);
});

test("the first delta reuses the editor's loaded baseline without GET", async () => {
  let feature: any, reads = 0; const sent: any[] = [];
  const editor = { slug: "page", base: { title: "Title", blocks: draft("before").blocks, updated: 10 },
    api: async () => { reads++; throw Error("unexpected GET"); }, provide: (_: string, value: any) => { feature = value; } };
  runInNewContext(lazySource, { window: { AcardEditor: editor }, Response, fetch: async (_: string, options: any) => {
    sent.push(JSON.parse(options.body)); return Response.json({ updated: 11 });
  } });
  expect((await feature.send("page", draft("after"))).status).toBe(200);
  expect(reads).toBe(0); expect(sent[0]).toMatchObject({ base_updated: 10, upserts: [{ id: "b1", text: "after" }] });
});

function section(start: string, end: string) {
  const from = editorSource.indexOf(start), to = editorSource.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("Missing editor section");
  return editorSource.slice(from, to);
}
test("offline page responses are rejected instead of becoming an edit base", async () => {
  const apiResponse = new Function(section("  function apiResponse", "  var lazyPending") + "return apiResponse;")();
  await expect(apiResponse(new Response(JSON.stringify({ page: { updated: 10 } }), { headers: { "x-acard-offline": "1" } }))).rejects.toThrow();
  expect(await apiResponse(new Response(JSON.stringify({ page: { updated: 11 } })))).toEqual({ page: { updated: 11 } });
});

function startup(kind = "note", create = true) {
  const created = deferred(), ready = deferred(), events: Record<string, Function> = {}, requests: string[] = [], loads: any[] = [];
  const node = () => ({ value: "", style: {}, hidden: false, parentNode: { insertBefore() {} }, removeAttribute() {}, focus() {}, classList: { remove() {} } });
  const els: any = { title: node(), blocks: node(), meta: node() };
  const state: any = { title: "", blocks: [], dirty: false };
  const database = { database: { slug: "db", title: "DB" }, properties: [], rows: [], views: [], templates: [] };
  const page = { page: { title: "Server", kind, updated: 10, source: "editor" }, blocks: [], database, ...(kind === "db_row" ? { dbRow: "row-1" } : {}) };
  const context: any = { state, els, transaction: null, slug: "page", URLSearchParams, location: { search: create ? "?create" : "", pathname: "/edit/page/", hash: "", replace() {} },
    history: { state: null, replaceState() {} }, document: { getElementById: node, createElement: node, addEventListener: (name: string, fn: Function) => { events[name] = fn; } },
    window: { AcardEditor: {}, DoriSite: { name: "Test" }, DoriDB: { load: (...args: any[]) => { loads.push(args); }, loadRow: (...args: any[]) => { loads.push(args); } }, mountEditorPages() {}, mountEditorFormat() {} },
    api: async (path: string) => { requests.push(path); if (path === "/pages") return created.promise; if (path === "/page/page") return page; return null; },
    render() {}, loadTree() {}, loadBacklinks() {}, setSave() {}, scheduleSave() {}, save() {}, snapshot: () => "snapshot", newBlock: () => ({ id: "new" }),
    lazy: async () => { throw Error("no cache"); }, emitFeature: (event: string) => { if (event === "ready") ready.resolve(null); } };
  const tail = editorSource.slice(editorSource.indexOf("  var previewHash;"), editorSource.lastIndexOf("})();"));
  runInNewContext(tail, context); events.DOMContentLoaded();
  return { state, ready, created, requests, loads, page, context };
}

test("create consumes POST bootstrap without GET and preserves typing before creation", async () => {
  const f = startup();
  f.state.title = "Typed while creating"; f.state.blocks = draft("early body").blocks; f.state.dirty = true;
  f.created.resolve({ slug: "page", updated: 10, page: f.page }); await f.ready.promise;
  expect(f.requests.filter(path => path === "/page/page")).toEqual([]);
  expect(f.state.title).toBe("Typed while creating"); expect(f.state.blocks).toEqual(draft("early body").blocks);
  expect(f.state.baseUpdated).toBe(10); expect(f.context.window.AcardEditor.base.title).toBe("Server");
  const sent: any[] = [];
  f.context.window.AcardEditor.transport = async (_: string, payload: any) => { sent.push(payload); return new Response(JSON.stringify({ updated: 11 })); };
  f.context.apiResponse = (r: Response) => r.json(); f.context.emitFeature = () => {};
  f.context.snapshot = () => JSON.stringify({ title: f.state.title, blocks: f.state.blocks });
  runInNewContext(section("  function save()", "  function uid()"), f.context);
  await f.context.save();
  expect(sent).toEqual([{ title: "Typed while creating", blocks: draft("early body").blocks, base_updated: 10 }]);
  expect(f.state.baseUpdated).toBe(11); expect(f.state.dirty).toBe(false);
});

test("database editor and row editor pass their page payload to DoriDB", async () => {
  for (const kind of ["db", "db_row"]) {
    const f = startup(kind, false); await f.ready.promise;
    expect(f.loads).toHaveLength(1);
    if (kind === "db") {
      expect(f.loads[0][1].initial).toBe(f.page.database); expect(f.loads[0][1].mountId).toBe("db-root");
    } else expect(f.loads[0]).toEqual(["db", "row-1", "db-row-props", { initial: f.page.database }]);
  }
});

for (const finishBeforeAck of [true, false]) test(`two tabs sharing the journal never restore startup over NEWER_X (${finishBeforeAck ? "in flight" : "acknowledged"})`, async () => {
  const localStorage = localStore(), requests: any[] = [];
  let writer = 0;
  let server = { page: { title: "Title", kind: "note", updated: 10, source: "editor" }, blocks: draft("original").blocks };
  function tab(preview = false) {
    const ready = deferred(), previewed = deferred(), finishLoad = deferred(), sending = deferred(), acknowledge = deferred();
    const events: Record<string, Function> = {}, listeners: Record<string, Function[]> = {};
    const timers = new Map<number, Function>(); let timer = 0;
    const node = () => ({ value: "", style: {}, dataset: {}, hidden: false, removeAttribute() {}, focus() {} });
    const els: any = { title: node(), blocks: node(), meta: node(), save: node() };
    const state: any = { title: "", blocks: [], dirty: false, saving: false, baseUpdated: null };
    const initial = structuredClone(server);
    const editor: any = { slug: "page", writerId: "tab-" + (++writer), state, render() {},
      on: (name: string, fn: Function) => { (listeners[name] ||= []).push(fn); },
      setSave: (text: string) => { els.save.dataset.text = text; },
      provide: (_: string, value: any) => { editor.transport = value.send; },
      api: async () => structuredClone(server) };
    const context: any = { state, els, slug: "page", URLSearchParams, Response, CustomEvent,
      location: { search: "", pathname: "/edit/page/", hash: "" },
      document: { cookie: "acard_id=member-a", querySelector: () => ({ content: "member-a" }), getElementById: () => els.save,
        addEventListener: (name: string, fn: Function) => { events[name] = fn; } },
      window: { AcardEditor: editor, localStorage, addEventListener() {}, dispatchEvent() {}, DoriSite: { name: "Test" }, mountEditorPages() {}, mountEditorFormat() {} },
      navigator: { onLine: true }, MutationObserver: class { observe() {} },
      setTimeout: (fn: Function) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id),
      api: async (path: string) => path === "/page/page" ? initial : null,
      apiResponse: (r: Response) => { if (!r.ok) throw Error(String(r.status)); return r.json(); },
      render() {}, loadTree() {}, loadBacklinks() {}, renderTree() {}, paintTocs() {}, setSave: editor.setSave,
      snapshot: () => JSON.stringify({ title: state.title, blocks: state.blocks }), newBlock: () => ({ id: "new" }),
      lazy: async () => ({ load: async (page: Promise<any>, show: Function) => {
        const data = await page;
        if (preview) {
          const cached = structuredClone(data); cached.page.updated--;
          show(cached); previewed.resolve(null); await finishLoad.promise;
        }
        return data;
      } }),
      emitFeature: (name: string, value: any) => {
        (listeners[name] || []).forEach(fn => fn(value));
        if (name === "ready") ready.resolve(null);
      },
      fetch: async (_: string, options: any) => {
        const body = JSON.parse(options.body); requests.push(body);
        if (body.base_updated !== server.page.updated) return Response.json({ error: "conflict" }, { status: 409 });
        server = { page: { ...server.page, updated: server.page.updated + 1 }, blocks: body.upserts.map(({ ord, ...block }: any) => block) };
        if (preview && body.upserts[0]?.text === "NEWER_X") { sending.resolve(null); await acknowledge.promise; }
        return Response.json({ updated: server.page.updated });
      }
    };
    runInNewContext(lazySource + queueSource + section("  var saveTimer =", "  function uid()") +
      editorSource.slice(editorSource.indexOf("  var previewHash;"), editorSource.lastIndexOf("})();")), context);
    events.DOMContentLoaded();
    return { state, ready, previewed, finishLoad, sending, acknowledge,
      journal: () => JSON.parse(localStorage.getItem("acard-save-queue:member-a:writer:" + JSON.stringify([editor.writerId, "page", ""]))!),
      edit: (text: string) => {
        state.blocks[0].text = text; context.scheduleSave();
        return context.save();
      } };
  }
  const one = tab(); await one.ready.promise; await one.edit("BASE_PRIMED");
  expect(one.journal().payload).toBeNull();
  const two = tab(true); await two.previewed.promise;
  const saving = two.edit("NEWER_X"); await two.sending.promise;
  if (finishBeforeAck) {
    two.finishLoad.resolve(null); await two.ready.promise;
    two.acknowledge.resolve(null); await saving;
  } else {
    two.acknowledge.resolve(null); await saving;
    expect(two.state.dirty).toBe(false);
    two.finishLoad.resolve(null); await two.ready.promise;
  }
  expect(requests.map(body => ({ base: body.base_updated, text: body.upserts[0]?.text }))).toEqual([
    { base: 10, text: "BASE_PRIMED" }, { base: 11, text: "NEWER_X" }
  ]);
  expect(server.blocks[0].text).toBe("NEWER_X");
  expect(two.state.blocks[0].text).toBe("NEWER_X");
  expect(two.journal().payload).toBeNull();
  expect(one.journal().payload).toBeNull();
});

test("API classifies transport and offline failures without admitting HTTP or abort failures", async () => {
  const make = (net: Function) => new Function("net", section("  function api(path", "  var lazyPending") + "return api;")(net);
  await expect(make(() => Promise.reject(new TypeError("network")))("/page/a")).rejects.toMatchObject({ acardFailure: "network" });
  const abort = new DOMException("cancelled", "AbortError");
  await expect(make(() => Promise.reject(abort))("/page/a")).rejects.toBe(abort);
  expect("acardFailure" in abort).toBe(false);
  for (const status of [401, 403, 404, 500, 503]) {
    await expect(make(() => Promise.resolve(Response.json({ error: "denied" }, { status })))("/page/a")).rejects.toMatchObject({ acardFailure: "http", status });
  }
  await expect(make(() => Promise.resolve(Response.json({}, { headers: { "x-acard-offline": "1", "x-acard-id": "member-a" } })))("/page/a")).rejects.toMatchObject({ acardFailure: "offline-cache", acardIdentity: "member-a" });
  expect(await make(() => Promise.resolve(new Response("invalid JSON")))("/page/a")).toEqual({});
});

test("delta transport rechecks identity after asynchronous baseline loading", async () => {
  const baseline = deferred(), started = deferred();
  let current = true, writes = 0;
  const editor: any = { slug: "page", saveQueue: { isCurrent: () => current },
    api: () => { started.resolve(null); return baseline.promise; },
    provide: (_: string, value: any) => { editor.delta = value; } };
  runInNewContext(lazySource, { window: { AcardEditor: editor }, Response, fetch: () => { writes++; return Response.json({ updated: 11 }); } });
  const sending = editor.delta.send("page", draft("new"));
  const outcome = sending.then(() => null, (error: Error) => error.message);
  await started.promise;
  current = false;
  baseline.resolve({ page: { title: "Title", updated: 10 }, blocks: draft("old").blocks });
  expect(await outcome).toBe("Draft identity unavailable");
  expect(writes).toBe(0);
});

test("explicit foreign draft recovery journals a new writer and retains the source revision", async () => {
  const api = queueApi(), local = localStore();
  const source = api.create({ identity: "member-a", writerId: "old", storage: api.storage(local, null, "member-a"), send: async () => Response.json({}) });
  await source.ready;
  source.enqueue("page", draft("offline typing", 12));
  const target = api.create({ identity: "member-a", writerId: "new", storage: api.storage(local, null, "member-a"), send: async () => Response.json({}) });
  await target.ready;
  const candidates = await target.recoveryDrafts();
  const restored = await target.restoreDraft(candidates[0]);
  expect(restored).toMatchObject({ writerId: "new", base_updated: 12, payload: draft("offline typing", 12) });
  expect(target.suspended()).toBe(true);
  expect((await target.recoveryDrafts())[0].payload).toEqual(draft("offline typing", 12));
  expect(JSON.parse(local.getItem('acard-save-queue:member-a:writer:["new","page",""]')!).payload).toEqual(draft("offline typing", 12));
});

test("draft recovery does not complete before durable storage and rejects a failed write", async () => {
  const api = queueApi(), write = deferred();
  const source = { slug: "page", acard_id: "member-a", writerId: "old", sequence: 1, base_updated: 12, payload: draft("recover", 12) };
  let finishWrite: (error: Error) => void = () => {};
  const persisted = new Promise((_, reject) => { finishWrite = reject; });
  const target = api.create({ identity: "member-a", writerId: "new", storage: {
    read: () => [source], write: () => { write.resolve(null); return persisted; }
  }, send: async () => Response.json({}) });
  await target.ready;
  let completed = false;
  const outcome = target.restoreDraft(source).then(() => { completed = true; return null; }, (error: Error) => error.message);
  await write.promise;
  expect(completed).toBe(false);
  expect(target.suspended()).toBe(true);
  finishWrite(Error("storage unavailable"));
  expect(await outcome).toBe("storage unavailable");
  expect(completed).toBe(false);
  expect((await target.recoveryDrafts())[0].payload).toEqual(draft("recover", 12));
});

test("typing during recovery persistence prevents replacement with the older recovered draft", async () => {
  const api = queueApi(), writing = deferred(), durable = deferred();
  const source = { slug: "page", acard_id: "member-a", writerId: "old", sequence: 1, base_updated: 12, payload: draft("recover", 12) };
  let writes = 0;
  const target = api.create({ identity: "member-a", writerId: "new", storage: {
    read: () => [source], write: () => { if (++writes === 1) { writing.resolve(null); return durable.promise; } }
  }, send: async () => Response.json({}) });
  await target.ready;
  const outcome = target.restoreDraft(source).then(() => null, (error: Error) => error.message);
  await writing.promise;
  target.enqueue("page", draft("new typing", 12));
  durable.resolve(null);
  expect(await outcome).toBe("Draft changed while recovering");
  expect(target.get("page").payload).toEqual(draft("new typing", 12));
  expect((await target.recoveryDrafts())[0].payload).toEqual(draft("recover", 12));
});

for (const revision of [12, 13]) test(`recovered draft keeps its revision when reconnect baseline is ${revision}`, async () => {
  const sent: unknown[] = [];
  const editor: any = { slug: "page", state: { recoveredDraft: true }, base: { title: "Title", blocks: draft("cached", 10).blocks, updated: 10 },
    api: async () => ({ page: { title: "Title", updated: revision }, blocks: draft("server").blocks }),
    provide: (_: string, value: any) => { editor.delta = value; } };
  runInNewContext(lazySource, { window: { AcardEditor: editor }, Response, fetch: async (_: string, options: { body: string }) => {
    sent.push(JSON.parse(options.body)); return Response.json({ updated: 14 });
  } });
  const response = await editor.delta.send("page", draft("recovered", 12));
  expect(response.status).toBe(revision === 12 ? 200 : 409);
  if (revision === 12) expect(sent[0]).toMatchObject({ base_updated: 12, upserts: [{ text: "recovered" }] });
  else expect(sent).toEqual([]);
});

test("beforeunload is attached only while dirty", () => {
  const listeners = new Map<string, Function>();
  const context: any = { window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
    beforeUnload() {} };
  runInNewContext(section("  var state =", "  var els ="), context);
  expect(listeners.size).toBe(0); context.state.dirty = true; expect(listeners.has("beforeunload")).toBe(true);
  context.state.dirty = false; expect(listeners.size).toBe(0);
});

test("save retains the unload guard until acknowledgement and freezes the submitted draft", async () => {
  const started = deferred(), response = deferred<Response>(), submitted: any[] = [];
  const state: any = { title: "Title", blocks: draft("first").blocks, baseUpdated: 10, dirty: true };
  const context: any = { state, transaction: null, slug: "page", created: Promise.resolve(), setSave() {}, loadBacklinks() {}, emitFeature() {},
    snapshot: () => JSON.stringify({ title: state.title, blocks: state.blocks }), apiResponse: (r: Response) => r.json(),
    window: { AcardEditor: { transport: async (_: string, payload: any) => {
      submitted.push(payload); started.resolve(null);
      return submitted.length === 1 ? response.promise : Response.json({ updated: 12 });
    } } } };
  runInNewContext(section("  function save()", "  function uid()"), context);
  const saving = context.save(); await started.promise;
  expect(state.dirty).toBe(true); state.blocks[0].text = "second";
  response.resolve(Response.json({ updated: 11 })); await saving;
  expect(submitted).toEqual([draft("first"), draft("second", 11)]);
  expect(state.dirty).toBe(false); expect(state.baseUpdated).toBe(12);
});

test("full-save transport refuses a missing base and includes it in every PUT", async () => {
  const calls: any[] = [];
  const transport = new Function("net", "Response", "return " + section("    transport: function", "    insertBlocksAfter").trim().slice("transport: ".length).replace(/,$/, ""))(
    async (_: string, options: any) => { calls.push(options); return Response.json({ updated: 11 }); }, Response);
  expect((await transport("page", { title: "bad", blocks: [] })).status).toBe(428);
  expect(calls).toEqual([]);
  await transport("page", draft()); expect(calls[0].method).toBe("PUT"); expect(JSON.parse(calls[0].body)).toEqual(draft());
});

test("upload sends page, preserves image dimensions in the draft, and renders intrinsic attributes", async () => {
  const requests: any[] = [], nodes: any[] = [];
  const node = (tag: string) => { const value: any = { tag, style: {}, dataset: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }; nodes.push(value); return value; };
  const context: any = { slug: "page", FormData, created: Promise.resolve(), render() {}, setSave() {}, scheduleSave() {},
    downscaleImage: (file: File) => Promise.resolve(file), document: { createElement: node },
    net: async (_: string, options: any) => { requests.push(options); return new Response(JSON.stringify({ url: "/media/photo", name: "photo.png", size: 12, width: 640, height: 480 })); } };
  const imageEditor = {
    slug: "page", lazy: async () => context.imageTools, provide: (_name: string, value: unknown) => { context.imageTools = value; },
    render() {}, setSave() {}, scheduleSave() {}
  };
  context.URL = URL;
  context.Image = class { width = 640; height = 480; onload = () => {}; set src(_value: string) { queueMicrotask(() => this.onload()); } };
  context.window = { AcardEditor: imageEditor, AcardEditorProvider: { fetch: context.net } };
  context.lazy = imageEditor.lazy;
  context.featureError = (error: Error) => { throw error; };
  runInNewContext(readFileSync(new URL("../assets/features/lazy/image-tools.js", import.meta.url), "utf8"), context);
  runInNewContext(section("  function uploadInto", "  function focusedIndex") + section("  function mediaBlock", "  function embedSizer"), context);
  const block: any = { type: "image", meta: { width: 70 } };
  await context.uploadInto(block, new File(["image"], "photo.png", { type: "image/png" }));
  expect(requests[0].body.get("page")).toBe("page"); expect(requests[0].body.get("file").name).toBe("photo.png");
  expect(block.meta).toMatchObject({ iw: 640, ih: 480, width: 70, src: "/media/photo" });
  context.mediaBlock(block, 0);
  expect(nodes.find(node => node.tag === "img")).toMatchObject({ width: 640, height: 480, decoding: "async" });
  expect(nodes.find(node => node.tag === "img").style.height).toBe("auto");
});

test("a 409 shows the conflict notice and retains the journal after another edit", async () => {
  const localStorage = localStore(), handlers: Record<string, Function> = {}, status: any = { textContent: "", dataset: {} };
  let calls = 0;
  const editor: any = { slug: "page", writerId: "conflict", state: { title: "Title", blocks: draft().blocks, baseUpdated: 10, dirty: true },
    on: (name: string, fn: Function) => { handlers[name] = fn; }, setSave: (text: string) => { status.dataset.text = status.textContent = text; },
    transport: async () => { calls++; return new Response("{}", { status: 409 }); } };
  runInNewContext(queueSource, { window: { AcardEditor: editor, localStorage, addEventListener() {} }, Response,
    document: { cookie: "acard_id=member-a", querySelector: () => ({ content: "member-a" }), getElementById: () => status, addEventListener() {} },
    navigator: { onLine: true }, MutationObserver: class { observe() {} }, setTimeout() {}, clearTimeout() {} });
  await handlers.ready();
  await editor.transport("page", draft());
  expect(status.textContent).toContain("충돌");
  expect(JSON.parse(localStorage.getItem('acard-save-queue:member-a:writer:["conflict","page",""]')!).payload).toEqual(draft());
  handlers.change(draft("new typing"));
  await editor.transport("page", draft("new typing"));
  expect(calls).toBe(1); expect(status.textContent).toContain("충돌");
});
