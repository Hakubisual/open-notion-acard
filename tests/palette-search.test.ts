import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const block = readFileSync(new URL("../assets/features/lazy/page-search.js", import.meta.url), "utf8");

function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const requests: { q: string; done: ReturnType<typeof deferred> }[] = [];
  const timers = new Map<number, () => Promise<void>>();
  let timerId = 0;
  const handlers: Record<string, (ev: any) => void> = {};
  const list: any = { innerHTML: "", ariaBusy: null, addEventListener() {} };
  const input: any = { value: "", focus() {}, addEventListener(name: string, fn: any) { handlers[name] = fn; } };
  const palette: any = { hidden: true, addEventListener() {} };
  const els: Record<string, any> = { palette, "palette-q": input, "palette-list": list };
  const location = { href: "" };
  const document = { getElementById: (id: string) => els[id] || null };
  const storage = new Map([["dori-notes-recent:member", JSON.stringify([{ slug: "index", title: "홈" }])]]);
  const localStorage = { getItem: (key: string) => storage.get(key) || null };
  const fetch = (url: string) => {
    const done = deferred();
    requests.push({ q: decodeURIComponent(url.split("q=")[1]), done });
    return done.promise.then((results) => ({ ok: true, json: () => Promise.resolve({ results }) }));
  };
  const setTimeout = (fn: () => Promise<void>) => { timers.set(++timerId, fn); return timerId; };
  const clearTimeout = (id: number) => timers.delete(id);
  let api: any;
  const window = { AcardEditor: { provide(name: string, value: any) { expect(name).toBe("page-search"); api = value; } } };
  new Function("window", "document", "location", "localStorage", "setTimeout", "clearTimeout", block)(window, document, location, localStorage, setTimeout, clearTimeout);
  const open = (identity = "member") => api.open(fetch, identity);
  open();
  const type = (q: string) => { input.value = q; handlers.input({}); };
  const key = (k: string) => handlers.keydown({ key: k, preventDefault() {} });
  const fire = () => { const pending = [...timers.values()]; timers.clear(); return Promise.all(pending.map(fn => fn())); };
  return { requests, list, location, type, key, fire, open, close: api.close, storage, palette };
}

test("a late answer for an older query is dropped", async () => {
  const f = setup();
  f.type("바나나"); const older = f.fire();
  f.type("사과"); const newer = f.fire();
  f.requests[1].done.resolve([{ slug: "apple", title: "사과" }]);
  await newer;
  f.requests[0].done.resolve([{ slug: "banana", title: "바나나" }]);
  await older;
  expect(f.list.innerHTML).toContain("/edit/apple/");
  expect(f.list.innerHTML).not.toContain("banana");
});

test("while the newest query is pending the old list is gone and marked busy", async () => {
  const f = setup();
  f.type("바나나"); const pending = f.fire();
  f.requests[0].done.resolve([{ slug: "banana", title: "바나나" }]);
  await pending;
  expect(f.list.innerHTML).toContain("banana");
  f.type("사과");
  expect(f.list.innerHTML).not.toContain("banana");
  expect(f.list.ariaBusy).toBe(true);
});

test("Enter while pending opens the newest result once it arrives, never the old one", async () => {
  const f = setup();
  f.type("바나나"); const older = f.fire();
  f.requests[0].done.resolve([{ slug: "banana", title: "바나나" }]);
  await older;
  f.type("사과");
  f.key("Enter");
  expect(f.location.href).toBe("");
  const newer = f.fire();
  f.requests[1].done.resolve([{ slug: "apple", title: "사과" }]);
  await newer;
  expect(f.location.href).toBe("/edit/apple/");
});

test("Escape after a pending Enter cancels the jump", async () => {
  const f = setup();
  f.type("사과");
  f.key("Enter");
  const pending = f.fire();
  f.key("Escape");
  f.requests[0].done.resolve([{ slug: "apple", title: "사과" }]);
  await pending;
  expect(f.location.href).toBe("");
});

test("recents stay identity-scoped and reopen reads persisted changes without searching", () => {
  const f = setup();
  expect(f.list.innerHTML).toContain("/edit/index/");
  f.storage.set("dori-notes-recent:member", JSON.stringify([{ slug: "updated", title: "Updated" }]));
  f.open();
  expect(f.list.innerHTML).toContain("/edit/updated/");
  f.open("other");
  expect(f.list.innerHTML).not.toContain("/edit/");
  f.open("");
  expect(f.list.innerHTML).not.toContain("/edit/");
  expect(f.requests).toHaveLength(0);
});

test("keyboard selection clamps and Enter follows the selected result", async () => {
  const f = setup();
  f.type("page"); const pending = f.fire();
  f.requests[0].done.resolve([{ slug: "first", title: "First" }, { slug: "second", title: "Second" }]);
  await pending;
  f.key("ArrowUp"); f.key("ArrowDown"); f.key("ArrowDown"); f.key("Enter");
  expect(f.location.href).toBe("/edit/second/");
});

test("closing before debounce cancels both search and deferred navigation", async () => {
  const f = setup();
  f.type("page"); f.key("Enter"); f.close();
  await f.fire();
  expect(f.requests).toHaveLength(0);
  expect(f.location.href).toBe("");
  expect(f.palette.hidden).toBe(true);
});

const editorSource = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const bridge = editorSource.slice(editorSource.indexOf("  var palette = document.getElementById"), editorSource.indexOf("  // --- 전역 단축키 ---"));
function cold() {
  const chunk = deferred();
  const calls: string[] = [];
  const errors: string[] = [];
  const palette = { hidden: true };
  const document = { getElementById: (id: string) => id === "palette" ? palette : null };
  const api = new Function("document", "lazy", "net", "identity", "setSave", bridge + "return {open:openPalette,close:closePalette};")(
    document, (name: string) => { calls.push(name); return chunk.promise; }, () => {}, "member", (error: string) => errors.push(error));
  return { api, chunk, calls, errors, palette };
}

test("the bridge makes no eager request and a cancelled cold open stays closed", async () => {
  const f = cold();
  expect(f.calls).toEqual([]);
  let opened = 0;
  f.api.open(); f.api.close();
  f.chunk.resolve({ open() { opened++; } });
  await f.chunk.promise;
  expect(f.calls).toEqual(["page-search"]);
  expect(opened).toBe(0);
  expect(f.palette.hidden).toBe(true);
});

test("multiple cold opens resolve only the latest intent", async () => {
  const f = cold();
  let opened = 0;
  f.api.open(); f.api.open();
  f.chunk.resolve({ open() { opened++; } });
  await f.chunk.promise;
  expect(opened).toBe(1);
});

test("a chunk load failure reports an error and leaves no empty dialog", async () => {
  const f = cold();
  f.api.open();
  f.chunk.resolve(Promise.reject(Error("chunk unavailable")));
  await f.chunk.promise.catch(() => {});
  expect(f.errors).toEqual(["chunk unavailable"]);
  expect(f.palette.hidden).toBe(true);
});
