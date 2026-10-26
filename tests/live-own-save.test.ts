import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// #109: a tab's own save came back as a live notice and showed 새 내용이 있어요 while the user kept typing.
const live = readFileSync(new URL("../assets/features/lazy/live.js", import.meta.url), "utf8");

function harness(server: { updated: number; text: string }) {
  const handlers: Record<string, Function[]> = {};
  const on = (map: Record<string, Function[]>) => (type: string, fn: Function) => { (map[type] ||= []).push(fn); return () => { map[type] = map[type].filter((f) => f !== fn); }; };
  const docHandlers: Record<string, Function[]> = {}, winHandlers: Record<string, Function[]> = {};
  const created: any[] = [];
  const document: any = { hidden: false, activeElement: null, addEventListener: on(docHandlers), dispatchEvent() {}, getElementById: () => null,
    querySelector: () => ({ content: "member-a" }), body: { appendChild() {} },
    createElement: (tag: string) => { const el: any = { tag, style: {}, hidden: false, setAttribute() {}, append() {} }; created.push(el); return el; } };
  const state = { title: "T", blocks: [{ id: "b1", type: "paragraph", text: "local, newer" }], baseUpdated: 0, dirty: false, saving: false };
  const history = { undoStack: ["older local version"], redoStack: ["older redo version"] };
  const editor = { state, render() {}, captureSelection: () => null, restoreSelection() {}, setSave() {}, remoteHistory() { history.undoStack.length = 0; history.redoStack.length = 0; }, on: on(handlers), emit: (type: string) => (handlers[type] || []).slice().forEach((f) => f()) };
  const sockets: any[] = [];
  class Socket { onmessage: any; onclose: any; onerror: any; readyState = 1; constructor() { sockets.push(this); } close() {} send() {} }
  const timers: Function[] = [];
  const window: any = { WebSocket: Socket, AcardEditor: editor, addEventListener: on(winHandlers), confirm: () => true };
  const fetch = async () => ({ ok: true, json: async () => ({ page: { title: "T", updated: server.updated }, blocks: [{ id: "b1", type: "paragraph", text: server.text }] }) });
  runInNewContext(live, { window, document,
    location: new URL("https://notes.example.com/edit/p/"), WebSocket: Socket, fetch, Date, JSON, Math, Number,
    sessionStorage: { getItem: () => null, setItem() {} }, CustomEvent: class { constructor(public type: string, public init: any) {} },
    setTimeout: (fn: Function) => { timers.push(fn); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {} });
  const settle = async () => { for (let i = 0; i < 5; i++) { timers.splice(0).forEach((f) => f()); await new Promise((r) => setImmediate(r)); } };
  const notice = async (src: string) => { sockets[0].onmessage({ data: JSON.stringify({ type: "change", id: 1 + Math.random(), kinds: ["page"], slugs: ["p"], src }) }); await settle(); };
  const bar = () => created.find((el) => el.tag === "div" && el.id === "acard-live-bar");
  document.fire = (type: string) => (docHandlers[type] || []).forEach((f) => f({}));
  return { state, editor, notice, bar, settle, document, history };
}

test("explicit draft restoration waits for persistence and does not publish draft text as a server baseline", async () => {
  const h = harness({ updated: 12, text: "server" });
  const stage = Promise.withResolvers<{ payload: { title: string; blocks: typeof h.state.blocks }; base_updated: number }>();
  const started = Promise.withResolvers<void>();
  const adopted: unknown[] = [];
  let rendered = false, resumed = false;
  const ed = Object.assign(h.editor, {
    lazy: async () => {},
    saveQueue: { stageRecovery: () => { started.resolve(); return stage.promise; }, isCurrent: () => true, continueDraft: () => { resumed = true; } },
    render: () => { rendered = true; }, remoteHistory: (remote?: unknown) => { if (remote) adopted.push(remote); }
  });
  const restore = Reflect.get(ed, "restoreDraft");
  const restoring = restore({});
  await started.promise;
  expect(rendered).toBe(false);
  stage.resolve({ payload: { title: "Recovered", blocks: [{ id: "b1", type: "paragraph", text: "unsaved" }] }, base_updated: 12 });
  await restoring;
  expect(h.state.blocks[0].text).toBe("unsaved");
  expect(h.state.baseUpdated).toBe(12);
  expect(h.state.dirty).toBe(true);
  expect(rendered && resumed).toBe(true);
  expect(adopted).toEqual([]);
});

test("typing while recovery is being persisted keeps the visible newer document", async () => {
  const h = harness({ updated: 12, text: "server" });
  const stage = Promise.withResolvers<{ payload: { title: string; blocks: typeof h.state.blocks }; base_updated: number }>();
  const started = Promise.withResolvers<void>();
  let rendered = false, resumed = false;
  const ed = Object.assign(h.editor, {
    lazy: async () => {}, saveQueue: { stageRecovery: () => { started.resolve(); return stage.promise; }, isCurrent: () => true, continueDraft: () => { resumed = true; } },
    render: () => { rendered = true; }
  });
  const restoring = Reflect.get(ed, "restoreDraft")({}).then(() => null, (error: Error) => error.message);
  await started.promise;
  h.state.blocks[0].text = "new local typing"; h.state.dirty = true;
  stage.resolve({ payload: { title: "Recovered", blocks: [{ id: "b1", type: "paragraph", text: "older draft" }] }, base_updated: 12 });
  expect(await restoring).toBe("Draft changed while recovering");
  expect(h.state.blocks[0].text).toBe("new local typing");
  expect(rendered).toBe(false);
  expect(resumed).toBe(true);
});

test("a notice for this tab's own save shows no 새 내용이 있어요 bar, even while typing", async () => {
  const h = harness({ updated: 50, text: "saved by me" });
  h.state.baseUpdated = 50;
  h.document.fire("input");
  await h.notice("");
  expect(h.bar()).toBeUndefined();
});

test("a notice that arrives while this tab's save is in flight waits for it and then stays quiet", async () => {
  const server = { updated: 60, text: "saved by me" };
  const h = harness(server);
  h.state.baseUpdated = 50; h.state.saving = true;
  h.document.fire("input");
  await h.notice("");
  expect(h.bar()).toBeUndefined();
  h.state.saving = false; h.state.baseUpdated = 60;
  h.editor.emit("saved");
  await h.settle();
  expect(h.bar()).toBeUndefined();
});

test("a newer version from someone else still shows the bar while typing", async () => {
  const h = harness({ updated: 70, text: "remote edit" });
  h.state.baseUpdated = 50;
  h.document.fire("input");
  await h.notice("");
  expect(h.bar()?.hidden).toBe(false);
});

test("adopting a remote page advances the version used by the next edit", async () => {
  const h = harness({ updated: 70, text: "remote edit" });
  h.state.baseUpdated = 50;

  await h.notice("other-tab");

  expect(h.state.blocks[0]?.text).toBe("remote edit");
  expect(h.state.baseUpdated).toBe(70);
  expect(h.history.undoStack).toEqual([]);
  expect(h.history.redoStack).toEqual([]);
});

test("a newer identical remote snapshot advances the baseline without retaining stale undo", async () => {
  const h = harness({ updated: 70, text: "local, newer" });
  h.state.baseUpdated = 50;

  await h.notice("other-tab");

  expect(h.state.baseUpdated).toBe(70);
  expect(h.history.undoStack).toEqual([]);
});

test("a dirty draft is not replaced by remote content", async () => {
  const h = harness({ updated: 70, text: "remote edit" });
  h.state.baseUpdated = 50;
  h.state.dirty = true;

  await h.notice("other-tab");

  expect(h.state.blocks[0]?.text).toBe("local, newer");
  expect(h.state.baseUpdated).toBe(50);
  expect(h.bar()?.hidden).toBe(false);
});

test("a late remote response cannot replace a newer accepted version", async () => {
  const h = harness({ updated: 40, text: "stale remote" });
  h.state.baseUpdated = 50;
  await h.notice("other-tab");
  expect(h.state.blocks[0]?.text).toBe("local, newer");
  expect(h.state.baseUpdated).toBe(50);
});
