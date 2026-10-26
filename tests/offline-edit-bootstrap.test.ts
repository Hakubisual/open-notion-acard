import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const cacheSource = await Bun.file(new URL("../assets/features/lazy/recent-cache.js", import.meta.url)).text();
const queueSource = await Bun.file(new URL("../assets/features/save-queue.js", import.meta.url)).text();
const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb";
const snapshot = () => ({ page: { slug: "one", kind: "note", title: "Original", updated: 10 }, blocks: [{ id: "b1", type: "paragraph", text: "original" }] });
const record = () => ({ version: 1, identity: A, epoch: "first", key: "/page/one", snapshot: snapshot() });
const offline = () => Object.assign(Error("offline"), { acardFailure: "offline-cache", acardIdentity: A });

function cacheFixture(value: any = record()) {
  const initialized = Promise.withResolvers<void>(), unlocked = Promise.withResolvers<void>(), painted = Promise.withResolvers<void>();
  const listeners: Record<string, Function> = {}, stored = new Map<string, string>();
  stored.set("/__recent-cache", JSON.stringify([{ key: "/page/one", value }]));
  let epoch = "first", queueCurrent = true, refreshed = 0;
  const doc = { inert: false, replaceChildren() {} };
  const document = { cookie: "acard_id=" + A, querySelector: () => ({ content: A }), getElementById: () => doc, documentElement: { dataset: {} as any } };
  const editor: any = { slug: "one", coreEditing: true, state: {}, setSave() {}, provide() {}, api: async () => ({ pages: [] }),
    saveQueue: { ready: initialized.promise, isCurrent: () => queueCurrent, refreshStatus() { refreshed++; unlocked.resolve(); } } };
  const operations: Promise<any>[] = [];
  const context: any = { Response, Promise, document, AcardEditor: editor, localStorage: { getItem: () => epoch },
    caches: { keys: async () => ["acard-recent-cache-" + A], delete: async () => true, open: async () => ({
      match: async (key: string) => stored.has(key) ? new Response(stored.get(key)) : undefined,
      put: async (key: string, response: Response) => { stored.set(key, await response.text()); }
    }) }, navigator: { onLine: false, locks: { request: (_: string, fn: Function) => { const work = fn(); operations.push(work); return work; } } },
    setTimeout: () => 1, location: { replace() {} }, addEventListener: (event: string, fn: Function) => { listeners[event] = fn; } };
  context.window = context;
  runInNewContext(cacheSource, context);
  return { editor, document, doc, initialized, unlocked, painted, stored, operations, listeners, context,
    setEpoch: (value: string) => { epoch = value; }, invalidateQueue: () => { queueCurrent = false; }, refreshed: () => refreshed,
    load: (server: Promise<any>, preview: Function = () => {}) => context.AcardRecentCache.load(server, (data: any) => { preview(data); painted.resolve(); }, () => {}) };
}

test("offline admission freezes the exact cached baseline and waits for queue initialization", async () => {
  const f = cacheFixture();
  const result = await f.load(Promise.reject(offline()), (data: any) => { data.blocks[0].text = "render normalization"; });
  expect(result).toEqual(snapshot());
  expect(f.editor.base).toEqual({ title: "Original", blocks: snapshot().blocks, updated: 10 });
  expect(f.editor.state.baseUpdated).toBe(10);
  expect(f.editor.state.offlineBase).toBe(true);
  expect(f.doc.inert).toBe(true);
  result.blocks[0].text = "new typing";
  expect(f.editor.base.blocks[0].text).toBe("original");
  f.initialized.resolve(); await f.unlocked.promise;
  expect(f.doc.inert).toBe(false);
  expect(f.document.documentElement.dataset.recentCache).toBe("offline-editable");
  expect(f.refreshed()).toBe(1);
});

test("flag-off cached pages remain read-only during offline startup", async () => {
  const f = cacheFixture(); f.editor.coreEditing = false;
  await expect(f.load(Promise.reject(offline()))).rejects.toThrow();
  expect(f.doc.inert).toBe(true);
  expect(f.editor.base).toBeUndefined();
});

test("offline bootstrap does not rewrite its cached snapshot as fresh server data", async () => {
  const f = cacheFixture(), before = record();
  await f.load(Promise.reject(offline()));
  await Promise.all(f.operations);
  expect(JSON.parse(f.stored.get("/__recent-cache")!).find((entry: any) => entry.key === "/page/one").value).toEqual(before);
});

test("successful authority persists provenance and wins over a newer cached revision", async () => {
  const newer = record(); newer.snapshot.page.updated = 20;
  const f = cacheFixture(newer), server = Promise.withResolvers<any>();
  const loading = f.load(server.promise);
  await f.painted.promise;
  const authoritative = snapshot(); authoritative.page.updated = 11;
  server.resolve(authoritative);
  expect(await loading).toEqual(authoritative);
  await Promise.all(f.operations);
  expect(JSON.parse(f.stored.get("/__recent-cache")!).find((entry: any) => entry.key === "/page/one").value).toEqual({ ...record(), snapshot: authoritative });
  expect(f.editor.state.offlineBase).toBeUndefined();
  expect(f.doc.inert).toBe(false);
});

for (const failure of [Error("offline"), Object.assign(Error("network"), { acardFailure: "http", status: 401 }),
  ...[403, 404, 500, 503].map(status => Object.assign(Error(String(status)), { acardFailure: "http", status })),
  new SyntaxError("bad JSON"), Object.assign(Error("foreign"), { acardFailure: "offline-cache", acardIdentity: B })]) {
  test(`a received or unclassified failure cannot authorize offline editing: ${failure.message}`, async () => {
    const f = cacheFixture();
    await expect(f.load(Promise.reject(failure))).rejects.toBe(failure);
    expect(f.doc.inert).toBe(true);
    expect(f.editor.base).toBeUndefined();
  });
}

test("classified fetch failure additionally requires browser offline state", async () => {
  const failure = Object.assign(Error("fetch"), { acardFailure: "network" });
  const offlineTab = cacheFixture();
  expect(await offlineTab.load(Promise.reject(failure))).toEqual(snapshot());
  const onlineTab = cacheFixture(); onlineTab.context.navigator.onLine = true;
  await expect(onlineTab.load(Promise.reject(failure))).rejects.toBe(failure);
});

for (const [name, change] of [
  ["legacy", (_: any) => snapshot()], ["foreign identity", (r: any) => ({ ...r, identity: B })],
  ["old epoch", (r: any) => ({ ...r, epoch: "old" })], ["wrong key", (r: any) => ({ ...r, key: "/page/two" })],
  ["wrong page", (r: any) => { r.snapshot.page.slug = "two"; return r; }],
  ["invalid revision", (r: any) => { r.snapshot.page.updated = -1; return r; }],
  ["database", (r: any) => { r.snapshot.page.kind = "db"; return r; }],
  ["duplicate blocks", (r: any) => { r.snapshot.blocks.push(r.snapshot.blocks[0]); return r; }],
] as const) test(`provenance admission rejects ${name}`, async () => {
  const f = cacheFixture(change(record()));
  await expect(f.load(Promise.reject(offline()))).rejects.toThrow();
  expect(f.doc.inert).toBe(true); expect(f.editor.base).toBeUndefined();
});

for (const cookie of ["", "acard_id=" + B]) test(`cookie fence rejects cached admission: ${cookie || "missing"}`, async () => {
  const f = cacheFixture(); f.document.cookie = cookie;
  await expect(f.load(Promise.reject(offline()))).rejects.toThrow();
  expect(f.editor.base).toBeUndefined();
});

for (const change of ["epoch", "cookie", "queue"] as const) test(`invalidation during queue initialization never unlocks: ${change}`, async () => {
  const f = cacheFixture(); await f.load(Promise.reject(offline()));
  if (change === "epoch") f.setEpoch("second");
  if (change === "cookie") f.document.cookie = "acard_id=" + B;
  if (change === "queue") f.invalidateQueue();
  f.initialized.resolve(); await f.initialized.promise;
  expect(f.doc.inert).toBe(true); expect(f.refreshed()).toBe(0);
});

function queueApi() {
  const context: any = { Response, Promise, Map, Date, JSON, Math, setTimeout, clearTimeout };
  runInNewContext(queueSource, context);
  return context.AcardSaveQueue;
}
const draft = () => ({ title: "Draft", blocks: snapshot().blocks, base_updated: 10 });

test("identity invalidation fences a send waiting for durability and cannot resume", async () => {
  const durable = Promise.withResolvers<void>(), rows: any[] = [];
  let valid = true, sent = 0;
  const q = queueApi().create({ identity: A, isCurrent: () => valid,
    storage: { read: () => [], write: (entry: any) => { rows.push(entry); return durable.promise; } }, send: async () => { sent++; return Response.json({ updated: 11 }); } });
  await q.ready; q.enqueue("one", draft());
  const saving = q.attempt("one", true);
  valid = false; durable.resolve(); await saving;
  valid = true; q.resume(); await q.flush(true);
  expect(sent).toBe(0); expect(rows).toHaveLength(1); expect(q.get("one").payload).toEqual(draft());
});

test("late successful response cannot rebase or tombstone an invalidated identity draft", async () => {
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  let valid = true, acknowledged = 0;
  const rows: any[] = [];
  const q = queueApi().create({ identity: A, isCurrent: () => valid,
    storage: { read: () => [], write: (entry: any) => { rows.push(entry); } }, saved: () => { acknowledged++; },
    send: () => { started.resolve(); return response.promise; } });
  await q.ready; q.enqueue("one", draft());
  const saving = q.attempt("one", true); await started.promise;
  valid = false; response.resolve(Response.json({ updated: 11 }));
  expect(await saving).toBeNull();
  expect(acknowledged).toBe(0); expect(rows).toHaveLength(1); expect(q.get("one").base_updated).toBe(10);
});

test("late storage recovery cannot install records after identity invalidation", async () => {
  const stored = Promise.withResolvers<any[]>(); let valid = true;
  const q = queueApi().create({ identity: A, isCurrent: () => valid, storage: { read: () => stored.promise, write() {} }, send() { throw Error("unexpected send"); } });
  valid = false; stored.resolve([{ slug: "one", acard_id: A, payload: draft(), base_updated: 10, sequence: 1 }]);
  await q.ready;
  expect(q.entries()).toEqual([]); expect(await q.recoveryDrafts()).toEqual([]); expect(q.enqueue("one", draft())).toBeNull();
});

function wiredQueue(failWrite = false) {
  const handlers: Record<string, Function> = {}, values = new Map<string, string>();
  values.set("acard-cache-epoch", "first");
  const journalKey = 'acard-save-queue:' + A + ':writer:["writer","one",""]';
  values.set(journalKey, JSON.stringify({ slug: 'writer:["writer","one",""]', page_slug: "one", acard_id: A, writerId: "writer", payload: draft(), base_updated: 10, sequence: 1 }));
  const status: any = { dataset: {} }, document: any = { cookie: "acard_id=" + A, querySelector: () => ({ content: A }), getElementById: () => status, addEventListener() {} };
  const editor: any = { slug: "one", writerId: "writer", state: { title: "Original", blocks: snapshot().blocks, baseUpdated: 10 }, base: { updated: 10 },
    on: (name: string, fn: Function) => { handlers[name] = fn; }, setSave: (text: string) => { status.dataset.text = text; }, render() {}, transport() { throw Error("unexpected send"); } };
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (failWrite) throw Error("storage denied"); values.set(key, value); } };
  const context: any = { window: { AcardEditor: editor, localStorage, addEventListener: (name: string, fn: Function) => { handlers["window:" + name] = fn; }, dispatchEvent() {} },
    document, navigator: { onLine: false }, Response, CustomEvent, setTimeout: () => 1, clearTimeout() {}, MutationObserver: class { observe() {} } };
  runInNewContext(queueSource, context);
  return { editor, handlers, values, journalKey, document, status };
}

test("public queue ready resolves only after current-writer recovery and dirty state restoration", async () => {
  const f = wiredQueue(); let complete = false;
  f.editor.saveQueue.ready.then(() => { complete = true; });
  expect(complete).toBe(false); expect(f.editor.state.title).toBe("Original");
  await f.handlers.ready(); await f.editor.saveQueue.ready;
  expect(complete).toBe(true); expect(f.editor.state.title).toBe("Draft");
  expect(f.editor.state.dirty).toBe(true); expect(f.editor.state.baseUpdated).toBe(10);
  expect(JSON.parse(f.values.get(f.journalKey)!).payload).toEqual(draft());
});

test("epoch event rejects queue initialization without restoring or deleting the retained draft", async () => {
  const f = wiredQueue();
  const rejected = f.editor.saveQueue.ready.catch((error: Error) => error);
  f.values.set("acard-cache-epoch", "second"); f.handlers["window:storage"]({ key: "acard-cache-epoch" });
  await f.handlers.ready(); expect((await rejected).message).toContain("identity changed");
  expect(f.editor.state.title).toBe("Original"); expect(f.editor.saveQueue.isCurrent()).toBe(false);
  expect(JSON.parse(f.values.get(f.journalKey)!).payload).toEqual(draft());
});

test("cookie disappearance stops browser transport without deleting the original journal", async () => {
  const f = wiredQueue(); await f.handlers.ready();
  f.document.cookie = "";
  expect((await f.editor.transport("one", draft())).status).toBe(401);
  expect(JSON.parse(f.values.get(f.journalKey)!).payload).toEqual(draft());
});

test("queue initialization rejects if preserving a conflicting recovered draft cannot be durable", async () => {
  const f = wiredQueue(true); f.editor.base.updated = 11;
  const rejected = f.editor.saveQueue.ready.catch((error: Error) => error);
  await f.handlers.ready(); expect((await rejected).message).toBeTruthy();
  expect(JSON.parse(f.values.get(f.journalKey)!).payload).toEqual(draft());
  expect(f.editor.state.dirty).toBe(true);
  expect(f.editor.saveQueue.canAdoptRemote()).toBe(false);
});

test("queue initialization failure keeps the offline document locked", async () => {
  const f = cacheFixture(); await f.load(Promise.reject(offline()));
  const shown = Promise.withResolvers<void>();
  f.editor.setSave = () => shown.resolve();
  f.initialized.reject(Error("storage denied")); await shown.promise;
  expect(f.doc.inert).toBe(true); expect(f.refreshed()).toBe(0);
});
