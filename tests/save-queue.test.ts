import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const source = await Bun.file(new URL("../assets/features/save-queue.js", import.meta.url)).text();
function setup(send: (slug: string, payload: any) => Promise<Response> = async () => new Response("{}"), timers = { setTimeout, clearTimeout }) {
  const context: any = { Promise, Map, Date, JSON, Math, Response, ...timers };
  runInNewContext(source, context);
  const records = new Map<string, any>();
  const storage = {
    read: () => [...records.values()],
    write: (entry: any) => { records.set(entry.slug, structuredClone(entry)); },
  };
  let clock = 100;
  const options = { identity: "member-a", storage, send, now: () => clock };
  return { api: context.AcardSaveQueue, storage, records, options, tick: (ms: number) => { clock += ms; } };
}
const payload = (text: string) => ({ title: "Queue", blocks: [{ id: "b1", type: "paragraph", text }], base_updated: 10 });

test("retry schedule doubles from one second and caps at thirty seconds", async () => {
  const f = setup(async () => { throw new TypeError("offline"); });
  const q = f.api.create(f.options);
  await q.ready;
  q.enqueue("one", payload("draft"));
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = q.get("one").nextAt;
    await expect(q.attempt("one")).rejects.toThrow("offline");
    expect(q.get("one").nextAt).toBe((before || 100) + delay);
    expect(await q.attempt("one")).toBeNull();
    f.tick(delay);
  }
});

test("latest payload wins per page and sequence survives a persistence round-trip", async () => {
  const f = setup();
  const q = f.api.create(f.options);
  await q.ready;
  const original = payload("first");
  const first = q.enqueue("one", original).sequence;
  original.blocks[0].text = "mutated outside queue";
  expect(q.get("one").payload.blocks[0].text).toBe("first");
  q.enqueue("two", payload("other"));
  q.enqueue("one", payload("latest"));
  expect(q.entries()).toHaveLength(2);
  const restored = f.api.create(f.options);
  await restored.ready;
  expect(restored.get("one").payload).toEqual(payload("latest"));
  expect(restored.enqueue("one", payload("next")).sequence).toBeGreaterThan(first + 2);
});

test("409 and other 4xx stop retries, survive reload, and retain the draft", async () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    let calls = 0;
    const f = setup(async () => { calls++; return new Response("{}", { status }); });
    const q = f.api.create(f.options);
    await q.ready;
    q.enqueue("one", payload("keep"));
    await q.attempt("one");
    const restored = f.api.create(f.options);
    await restored.ready;
    f.tick(60000);
    await restored.flush(true);
    expect(calls).toBe(1);
    expect(restored.get("one").blocked).toBe(status);
    expect(restored.get("one").payload).toEqual(payload("keep"));
  }
});

test("5xx retries, and a success tombstone does not resurrect after reload", async () => {
  let calls = 0;
  const f = setup(async () => new Response("{}", { status: ++calls === 1 ? 503 : 200 }));
  const q = f.api.create(f.options);
  await q.ready;
  q.enqueue("one", payload("keep"));
  await q.attempt("one");
  expect(q.get("one").attempts).toBe(1);
  f.tick(1000);
  await q.attempt("one");
  const restored = f.api.create(f.options);
  await restored.ready;
  expect(restored.entries()).toEqual([]);
});

test("an old in-flight success cannot delete a newer edit", async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => { started = resolve; });
  const f = setup(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const q = f.api.create(f.options);
  await q.ready;
  q.enqueue("one", payload("first"));
  const request = q.attempt("one");
  await signal;
  q.enqueue("one", payload("second"));
  release(new Response("{}"));
  await request;
  expect(q.get("one").payload).toEqual(payload("second"));
  expect(f.records.get("one").payload).toEqual(payload("second"));
});

test("localStorage fallback writes synchronously and round-trips pending pages", async () => {
  const f = setup();
  const values = new Map<string, string>();
  const local = {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i],
    getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value),
  };
  const storage = f.api.storage(local, null, "member-a");
  const q = f.api.create({ ...f.options, storage });
  await q.ready;
  q.enqueue("one", payload("before debounce"));
  expect(values.size).toBe(1);
  const restored = f.api.create({ ...f.options, storage: f.api.storage(local, null, "member-a") });
  await restored.ready;
  expect(restored.get("one").payload).toEqual(payload("before debounce"));
});

test("failed persistence never sends a payload or silently discards it", async () => {
  let sent = false;
  const f = setup(async () => { sent = true; return new Response("{}"); });
  const q = f.api.create({ ...f.options, storage: { read: () => [], write: () => Promise.reject(new Error("full")) } });
  await q.ready;
  q.enqueue("one", payload("keep"));
  await expect(q.attempt("one")).rejects.toThrow("full");
  expect(sent).toBe(false);
  expect(q.get("one").payload).toEqual(payload("keep"));
});

test("a crash journal wins over stale IndexedDB retry metadata at the same sequence", async () => {
  const f = setup();
  const entry = { slug: "one", acard_id: "member-a", base_updated: 10, sequence: 10, payload: payload("keep"), updated: 100, attempts: 0, nextAt: 0, blocked: 0 };
  const q = f.api.create({ ...f.options, storage: { read: () => [entry, { ...entry, blocked: 409 }], write: () => {} } });
  await q.ready;
  expect(q.get("one").blocked).toBe(409);
  expect(await q.attempt("one", true)).toBeNull();
});

test("explicitly rebased drafts supersede permanent failures and different pages flush independently", async () => {
  const sent: string[] = [];
  const f = setup(async (slug, body) => {
    sent.push(slug + ":" + body.blocks[0].text);
    return new Response("{}", { status: body.blocks[0].text === "blocked" ? 409 : 200 });
  });
  const q = f.api.create(f.options);
  await q.ready;
  q.enqueue("one", payload("blocked"));
  await q.flush(true);
  q.enqueue("one", { ...payload("fixed"), base_updated: 11 });
  q.enqueue("two", payload("other"));
  await q.flush(true);
  expect(sent).toEqual(["one:blocked", "one:fixed", "two:other"]);
  expect(q.entries()).toEqual([]);
});


function wired(online: boolean) {
  const statuses: string[] = [];
  const listeners: Record<string, ((v?: any) => void)[]> = {};
  const status: any = { textContent: "" };
  let send!: (r: Response | Error) => void;
  let started: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  const statusWaits = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let clock = Date.now();
  const editor: any = {
    slug: "one", state: { title: "Queue", blocks: [], saving: false, dirty: false, baseUpdated: 10 },
    transport: () => new Promise<Response>((ok, bad) => { send = (r) => (r instanceof Error ? bad(r) : ok(r)); started?.(); }),
    setSave: (text: string) => { status.textContent = text; statuses.push(text); statusWaits.get(text)?.(); statusWaits.delete(text); },
    on: (name: string, fn: any) => { (listeners[name] ||= []).push(fn); },
    api: async () => null, render: () => {},
  };
  const values = new Map<string, string>();
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  const window: any = { AcardEditor: editor, localStorage, indexedDB: undefined, addEventListener: (name: string, fn: any) => { (listeners["window:" + name] ||= []).push(fn); }, dispatchEvent: (event: Event) => { (listeners["window:" + event.type] || []).forEach(fn => fn(event)); } };
  const context: any = { window, Promise, Map, Date: { now: () => clock }, JSON, Math, Response, Object, Array, CustomEvent,
    navigator: { onLine: online }, document: { cookie: "acard_id=member-a", querySelector: () => ({ content: "member-a" }), getElementById: () => status, addEventListener() {} },
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); scheduled?.(); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); } };
  runInNewContext(source.replace("(typeof window === \"undefined\" ? globalThis : window)", "(window)"), context);
  const emit = (name: string, value?: any) => Promise.all((listeners[name] || []).map((fn) => fn(value)));
  const nextSend = () => new Promise<void>(resolve => { started = resolve; });
  const nextStatus = (text: string) => new Promise<void>(resolve => { statusWaits.set(text, resolve); });
  const nextTimer = () => new Promise<void>(resolve => { scheduled = resolve; });
  return { editor, window, localStorage, statuses, status, emit, nextSend, nextStatus, nextTimer, respond: (r: Response | Error) => send(r), tick: () => { clock += 30000; const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); } };
}

test("status: online failure says it is resending, never offline; only a server OK shows saved", async () => {
  const w = wired(true);
  await w.emit("ready", w.editor);
  await w.emit("change", payload("draft"));
  expect(w.status.textContent).toBe("저장 중…");
  const first = w.nextSend();
  w.tick();
  await first;
  expect(w.status.textContent).not.toMatch(/저장됨|오프라인/);
  const retrying = w.nextStatus("저장 안 된 변경을 다시 보내는 중");
  const retryScheduled = w.nextTimer();
  w.respond(new TypeError("network"));
  await retrying;
  await retryScheduled;
  expect(w.status.textContent).not.toMatch(/저장됨|오프라인/);
  expect(w.status.textContent).toMatch(/다시 보내는/);
  const retry = w.nextSend();
  await w.emit("window:online");
  w.tick();
  await retry;
  const saved = w.nextStatus("저장됨");
  w.respond(Response.json({ updated: 11 }));
  await saved;
  expect(w.status.textContent).toBe("저장됨");
  expect(w.statuses.filter((s) => /오프라인/.test(s))).toEqual([]);
});

test("status: really offline shows the queued count", async () => {
  const w = wired(false);
  await w.emit("ready", w.editor);
  await w.emit("change", payload("draft"));
  expect(w.status.textContent).toBe("오프라인 - 1개 대기 중");
});

// A localStorage stand-in and an IndexedDB whose open request never answers (another tab holds the database).
function memoryLocal() {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
}
test("a blocked or never-answering IndexedDB open gives up within the step limit and the journal keeps saves", async () => {
  const timers = new Map<number, () => void>();
  let id = 0;
  const f = setup(undefined, { setTimeout: ((fn: () => void) => { timers.set(++id, fn); return id; }) as any, clearTimeout: ((id: number) => { timers.delete(id); }) as any });
  const local = memoryLocal();
  local.setItem("acard-save-queue:member-a:one", JSON.stringify({ slug: "one", acard_id: "member-a", base_updated: 10, payload: payload("left over"), sequence: 5, updated: 1, attempts: 0, nextAt: 0, blocked: 0 }));
  const hung = { open: () => ({}), deleteDatabase: () => ({}) };
  const store = f.api.storage(local, hung, "member-a");
  const reading = store.read();
  [...timers.values()].forEach(fn => fn());
  const rows = await reading;
  expect(rows.map((r: any) => r.payload.blocks[0].text)).toEqual(["left over"]);
  await store.write({ slug: "two", acard_id: "member-a", base_updated: 10, payload: payload("new"), sequence: 6 });
  expect(JSON.parse(local.getItem("acard-save-queue:member-a:two")!).payload.blocks[0].text).toBe("new");
});

test("a database left at a newer version (VersionError) is opened at its own version instead of being skipped", async () => {
  const f = setup();
  const versions: (number | undefined)[] = [];
  const rows = [{ slug: "kept", acard_id: "member-a", base_updated: 10, payload: payload("in idb"), sequence: 9 }];
  const db = { version: 7, objectStoreNames: { contains: () => true }, close() {}, transaction: () => ({ objectStore: () => ({ getAll: () => { const r: any = {}; queueMicrotask(() => { r.result = rows; r.onsuccess(); }); return r; } }) }) };
  const indexed = {
    open: (_: string, version?: number) => {
      versions.push(version);
      const r: any = {};
      queueMicrotask(() => { if (version === 1) r.onerror({ preventDefault() {} }); else { r.result = db; r.onsuccess(); } });
      return r;
    },
  };
  const store = f.api.storage(memoryLocal(), indexed, "member-a");
  expect((await store.read()).map((r: any) => r.slug)).toEqual(["kept"]);
  expect(versions).toEqual([1, undefined]);
});

test("writer drafts and success tombstones remain separate across reload", async () => {
  const f = setup();
  const local = memoryLocal();
  const storage = f.api.storage(local, null, "member-a");
  const a = f.api.create({ ...f.options, storage, writerId: "a" });
  const b = f.api.create({ ...f.options, storage, writerId: "b" });
  await Promise.all([a.ready, b.ready]);
  a.enqueue("one", payload("writer a"));
  b.enqueue("one", payload("writer b"));
  await a.attempt("one");
  const againA = f.api.create({ ...f.options, storage, writerId: "a" });
  const againB = f.api.create({ ...f.options, storage, writerId: "b" });
  await Promise.all([againA.ready, againB.ready]);
  expect(againA.entries()).toEqual([]);
  expect(againB.get("one").payload).toEqual(payload("writer b"));
  expect((await againA.recoveryDrafts()).map((e: any) => e.writerId)).toEqual(["b"]);
  expect(await againB.recoveryDrafts()).toEqual([]);
});

test("legacy and foreign drafts are discoverable but never automatically adopted", async () => {
  const f = setup();
  const storage = f.api.storage(memoryLocal(), null, "member-a");
  const legacy = f.api.create({ ...f.options, storage });
  await legacy.ready;
  legacy.enqueue("one", payload("legacy"));
  const current = f.api.create({ ...f.options, storage, writerId: "new" });
  await current.ready;
  expect(current.entries()).toEqual([]);
  current.enqueue("one", payload("current"));
  await current.attempt("one");
  expect((await current.recoveryDrafts()).map((e: any) => e.payload)).toEqual([payload("legacy")]);
  const legacyReload = f.api.create({ ...f.options, storage });
  await legacyReload.ready;
  expect(legacyReload.get("one").payload).toEqual(payload("legacy"));
});

test("IndexedDB keys isolate writer records while preserving logical page slugs", async () => {
  const f = setup();
  const rows = new Map<string, any>();
  const db = { version: 1, objectStoreNames: { contains: () => true }, close() {}, transaction: () => {
    const tx: any = { objectStore: () => ({
      getAll: () => { const request: any = {}; queueMicrotask(() => { request.result = [...rows.values()]; request.onsuccess(); }); return request; },
      put: (entry: any) => { rows.set(entry.slug, structuredClone(entry)); queueMicrotask(() => tx.oncomplete()); },
    }) };
    return tx;
  } };
  const indexed = { open: () => { const request: any = {}; queueMicrotask(() => { request.result = db; request.onsuccess(); }); return request; } };
  const storage = f.api.storage(null, indexed, "member-a");
  const a = f.api.create({ ...f.options, storage, writerId: "a" });
  const b = f.api.create({ ...f.options, storage, writerId: "b" });
  await Promise.all([a.ready, b.ready]);
  a.enqueue("one", payload("a"));
  b.enqueue("one", payload("b"));
  await a.attempt("one");
  const restored = f.api.create({ ...f.options, storage, writerId: "b" });
  await restored.ready;
  expect(rows.size).toBe(2);
  expect(restored.get("one").slug).toBe("one");
  expect(restored.get("one").payload).toEqual(payload("b"));
});

test("own acknowledgement rebases newer typing but a foreign writer keeps its original base", async () => {
  let release!: (r: Response) => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => { started = resolve; });
  const f = setup(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const storage = f.api.storage(memoryLocal(), null, "member-a");
  const a = f.api.create({ ...f.options, storage, writerId: "a" });
  const b = f.api.create({ ...f.options, storage, writerId: "b" });
  await Promise.all([a.ready, b.ready]);
  a.enqueue("one", payload("first"));
  const request = a.attempt("one");
  await signal;
  a.enqueue("one", payload("newer"));
  b.enqueue("one", payload("foreign"));
  release(Response.json({ updated: 11 }));
  await request;
  expect(a.get("one").payload).toEqual({ ...payload("newer"), base_updated: 11 });
  expect(b.get("one").payload).toEqual(payload("foreign"));
});

test("archiving awaits in-flight acknowledgement and preserves the latest draft before clearing", async () => {
  let release!: (r: Response) => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => { started = resolve; });
  const f = setup(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const storage = f.api.storage(memoryLocal(), null, "member-a");
  const q = f.api.create({ ...f.options, storage, writerId: "a" });
  await q.ready;
  q.enqueue("one", payload("first"));
  const request = q.attempt("one");
  await signal;
  q.enqueue("one", payload("latest"));
  const archived = q.archiveAndClear("one");
  expect(q.suspended()).toBe(true);
  release(Response.json({ updated: 11 }));
  await request;
  const archive = await archived;
  expect(archive.payload).toEqual({ ...payload("latest"), base_updated: 11 });
  expect(q.entries()).toEqual([]);
  const restored = f.api.create({ ...f.options, storage, writerId: "a" });
  await restored.ready;
  expect(restored.entries()).toEqual([]);
  expect(await restored.recoveryDrafts()).toEqual([archive]);
  q.enqueue("one", payload("later"));
  expect(await q.attempt("one", true)).toBeNull();
});

test("archive and tombstone persistence failures retain the active draft", async () => {
  for (const failure of ["archive", "tombstone"]) {
    const f = setup();
    const storage = f.api.storage(memoryLocal(), null, "member-a");
    const q = f.api.create({ ...f.options, writerId: "a", storage: {
      read: storage.read,
      write: (entry: any) => {
        if ((failure === "archive" && entry.archiveId) || (failure === "tombstone" && !entry.payload)) throw Error("full");
        return storage.write(entry);
      },
    } });
    await q.ready;
    q.enqueue("one", payload("keep"));
    await expect(q.archiveAndClear("one")).rejects.toThrow("full");
    expect(q.get("one").payload).toEqual(payload("keep"));
    const restored = f.api.create({ ...f.options, storage, writerId: "a" });
    await restored.ready;
    expect(restored.get("one").payload).toEqual(payload("keep"));
  }
});

test("typing during archive persistence cannot be cleared by the older archive", async () => {
  let release!: () => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => { started = resolve; });
  const f = setup();
  const q = f.api.create({ ...f.options, storage: { read: () => [], write: (entry: any) => {
    if (entry.archiveId) { started(); return new Promise<void>(resolve => { release = resolve; }); }
  } } });
  await q.ready;
  q.enqueue("one", payload("first"));
  const archive = q.archiveAndClear("one");
  await signal;
  q.enqueue("one", payload("latest"));
  release();
  await expect(archive).rejects.toThrow("Draft changed while archiving");
  expect(q.get("one").payload).toEqual(payload("latest"));
});

test("archive durability must settle before any tombstone is requested", async () => {
  for (const rejectArchive of [false, true]) {
    const started = Promise.withResolvers<void>();
    const durability = Promise.withResolvers<void>();
    let tombstones = 0;
    const f = setup();
    const q = f.api.create({ ...f.options, storage: { read: () => [], write: (entry: { archiveId?: string; payload: unknown }) => {
      if (entry.archiveId) { started.resolve(); return durability.promise; }
      if (!entry.payload) tombstones++;
    } } });
    await q.ready;
    q.enqueue("one", payload("must survive"));
    const archived = q.archiveAndClear("one");
    const outcome = archived.then(() => "saved", (error: Error) => error.message);
    await started.promise;
    expect(q.get("one").payload).toEqual(payload("must survive"));
    expect(tombstones).toBe(0);
    if (rejectArchive) durability.reject(new Error("disk rejected"));
    else durability.resolve();
    expect(await outcome).toBe(rejectArchive ? "disk rejected" : "saved");
    expect(tombstones).toBe(rejectArchive ? 0 : 1);
    expect(q.entries().length).toBe(rejectArchive ? 1 : 0);
  }
});

test("the request stays busy when its acknowledged payload has just been cleared", async () => {
  const f = setup(async () => Response.json({ updated: 11 }));
  let inspect = () => {};
  const states: { entries: number; busy: boolean }[] = [];
  const q = f.api.create({ ...f.options, changed: () => inspect() });
  await q.ready;
  inspect = () => { states.push({ entries: q.entries().length, busy: q.busy() }); };
  q.enqueue("one", payload("submitted"));

  await q.attempt("one");

  expect(states).toContainEqual({ entries: 0, busy: true });
  expect(states.at(-1)).toEqual({ entries: 0, busy: false });
});

test("remote adoption guards initialization, core requests, queued and coalesced edits", async () => {
  const w = wired(false);
  const api = w.editor.saveQueue;
  expect(api.canAdoptRemote()).toBe(false);
  await w.emit("ready");
  expect(api.canAdoptRemote()).toBe(true);
  w.editor.state.saving = true;
  expect(api.canAdoptRemote()).toBe(false);
  expect(api.acceptRemote({ title: "remote", blocks: [], updated: 11 })).toBe(false);
  w.editor.state.saving = false;
  await w.emit("change", payload("first"));
  expect(api.canAdoptRemote()).toBe(false);
  const started = w.nextSend();
  const request = w.editor.transport("one", payload("first"));
  await started;
  expect(api.canAdoptRemote()).toBe(false);
  await w.emit("change", payload("coalesced"));
  w.respond(Response.json({ updated: 11 }));
  await request;
  expect(api.canAdoptRemote()).toBe(false);
  const archive = await api.archiveAndClear();
  expect(archive.payload.blocks[0].text).toBe("coalesced");
  expect(api.canAdoptRemote()).toBe(true);
});

test("acceptRemote records the remote baseline without enqueuing or sending", async () => {
  const w = wired(false);
  await w.emit("ready");
  w.editor.state.title = "remote";
  w.editor.state.blocks = payload("remote").blocks;
  w.editor.state.dirty = true;
  expect(w.editor.saveQueue.acceptRemote({ title: "remote", blocks: w.editor.state.blocks, updated: 11 })).toBe(true);
  expect(w.editor.state.dirty).toBe(false);
  expect(w.localStorage.length).toBe(0);
  expect(await w.editor.saveQueue.recoveryDrafts()).toEqual([]);
});

test("editor archive waits for core settlement and failures keep the latest coalesced edit", async () => {
  const w = wired(false);
  await w.emit("ready");
  await w.emit("change", payload("first"));
  await w.emit("change", payload("latest"));
  let settle!: () => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => { started = resolve; });
  w.editor.state.saving = true;
  w.editor.whenSaveSettled = () => { started(); return new Promise<void>(resolve => { settle = () => { w.editor.state.saving = false; resolve(); }; }); };
  const writing = w.localStorage.setItem;
  w.localStorage.setItem = (key: string, value: string) => { if (JSON.parse(value).archiveId) throw Error("full"); writing(key, value); };
  const archive = w.editor.saveQueue.archiveAndClear();
  await signal;
  expect(w.editor.saveQueue.canAdoptRemote()).toBe(false);
  settle();
  await expect(archive).rejects.toThrow();
  expect(w.editor.saveQueue.canAdoptRemote()).toBe(false);
  const records = Array.from({ length: w.localStorage.length }, (_, i) => JSON.parse(w.localStorage.getItem(w.localStorage.key(i))!));
  expect(records.find(e => e.payload && !e.archiveId).payload.blocks[0].text).toBe("latest");
});

test("queue-only settlement emits one idle event after safe acknowledgement", async () => {
  const w = wired(true);
  const events: string[] = [];
  let idle!: () => void;
  const signal = new Promise<void>(resolve => { idle = resolve; });
  w.window.addEventListener("saveQueueIdle", (event: CustomEvent) => {
    expect(w.editor.saveQueue.canAdoptRemote()).toBe(true);
    events.push(event.detail.slug);
    idle();
  });
  await w.emit("ready");
  expect(events).toEqual([]);
  await w.emit("change", payload("draft"));
  const started = w.nextSend();
  w.tick();
  await started;
  expect(events).toEqual([]);
  w.respond(Response.json({ updated: 11 }));
  await signal;
  expect(events).toEqual(["one"]);
  await w.emit("saved");
  expect(events).toEqual(["one"]);
});

test("remote adoption stays blocked after payload removal until the request settles", async () => {
  const w = wired(false);
  await w.emit("ready");
  await w.emit("change", payload("submitted"));
  const observations: boolean[] = [];
  const setSave = w.editor.setSave;
  w.editor.setSave = (text: string, on: boolean) => {
    setSave(text, on);
    if (!on) observations.push(w.editor.saveQueue.canAdoptRemote());
  };
  const started = w.nextSend();
  const request = w.editor.transport("one", payload("submitted"));
  await started;
  w.respond(Response.json({ updated: 11 }));
  await request;
  expect(observations).toContain(false);
  expect(w.editor.saveQueue.canAdoptRemote()).toBe(true);
});

test("queue settlement does not emit idle while core saves or coalesced typing remain", async () => {
  for (const blockedBy of ["core", "typing"]) {
    const w = wired(false);
    const events: Event[] = [];
    w.window.addEventListener("saveQueueIdle", (event: Event) => events.push(event));
    await w.emit("ready");
    await w.emit("change", payload("first"));
    const started = w.nextSend();
    const request = w.editor.transport("one", payload("first"));
    await started;
    if (blockedBy === "core") w.editor.state.saving = true;
    else await w.emit("change", payload("coalesced"));
    w.respond(Response.json({ updated: 11 }));
    await request;
    expect(events).toEqual([]);
  }
});
