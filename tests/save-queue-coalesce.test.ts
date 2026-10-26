import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

// Typing emits "change" per keystroke; the journal (localStorage) must not take every one, but a pagehide,
// a hidden tab, a save or the queue's own flush timer must land the newest text before anything else runs.
const source = await Bun.file(new URL("../assets/features/save-queue.js", import.meta.url)).text();

function wired(transport: (slug: string, payload: any) => Promise<Response> = async () => new Response(JSON.stringify({ updated: 11 }))) {
  const listeners: Record<string, ((v?: any) => void)[]> = {};
  const status: any = { textContent: "", dataset: {} };
  const timers = new Map<number, () => void>();
  let timerId = 0, clock = 1_000_000, writes = 0;
  const editor: any = {
    writerId: "coalesce",
    slug: "one", state: { title: "Queue", blocks: [{ id: "b1", type: "paragraph", text: "" }], saving: false, dirty: false, baseUpdated: 10 },
    transport,
    setSave: (text: string) => { status.textContent = text; },
    on: (name: string, fn: any) => { (listeners[name] ||= []).push(fn); },
    render: () => {},
  };
  const values = new Map<string, string>();
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { writes++; values.set(k, v); } };
  const window: any = { AcardEditor: editor, localStorage, indexedDB: undefined, addEventListener: (name: string, fn: any) => { (listeners["window:" + name] ||= []).push(fn); }, dispatchEvent: (event: Event) => { (listeners["window:" + event.type] || []).forEach(fn => fn(event)); } };
  const context: any = { window, Promise, Map, Date: { now: () => clock }, JSON, Math, Response, Object, Array, Number, CustomEvent,
    navigator: { onLine: true }, document: { cookie: "acard_id=member-a", querySelector: () => ({ content: "member-a" }), getElementById: () => status, addEventListener: (name: string, fn: any) => { (listeners["document:" + name] ||= []).push(fn); } },
    MutationObserver: class { observe() {} },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); } };
  runInNewContext(source.replace("(typeof window === \"undefined\" ? globalThis : window)", "(window)"), context);
  const emit = (name: string, value?: any) => Promise.all((listeners[name] || []).map((fn) => fn(value)));
  const type = (text: string) => { editor.state.blocks[0].text = text; editor.state.dirty = true; return emit("change", { title: editor.state.title, blocks: editor.state.blocks, base_updated: 10 }); };
  const journal = () => JSON.parse(values.get('acard-save-queue:member-a:writer:["coalesce","one",""]')!).payload.blocks[0].text;
  // Runs every timer that is due at the current clock (the queue's flush timer and the change timer).
  const runDue = () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); };
  return { editor, emit, type, journal, runDue, writes: () => writes, advance: (ms: number) => { clock += ms; } };
}

test("keystrokes within the window share one journal write and the next window takes the newest text", async () => {
  const w = wired();
  await w.emit("ready", w.editor);
  const before = w.writes();
  await w.type("a");
  expect(w.writes()).toBe(before + 1);
  expect(w.journal()).toBe("a");
  for (const text of ["ab", "abc", "abcd"]) { w.advance(20); await w.type(text); }
  expect(w.writes()).toBe(before + 1);
  w.advance(300);
  w.runDue();
  expect(w.journal()).toBe("abcd");
  expect(w.writes()).toBe(before + 2);
});

test("a pagehide flushes the coalesced edit to storage before the window elapses", async () => {
  const w = wired();
  await w.emit("ready", w.editor);
  await w.type("a");
  w.advance(20);
  await w.type("ab");
  expect(w.journal()).toBe("a");
  await w.emit("window:pagehide");
  expect(w.journal()).toBe("ab");
});

test("a hidden tab and a save also land the newest text first", async () => {
  const w = wired();
  await w.emit("ready", w.editor);
  await w.type("a");
  w.advance(20);
  await w.type("ab");
  await w.emit("document:visibilitychange");
  expect(w.journal()).toBe("ab");
  w.advance(20);
  await w.type("abc");
  expect(w.journal()).toBe("ab");
  await w.emit("beforeSave", { title: w.editor.state.title, blocks: w.editor.state.blocks, base_updated: 10 });
  expect(w.journal()).toBe("abc");
});

test("the queue's own flush timer commits pending typing before it sends", async () => {
  const sent: string[] = [];
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const w = wired(async (_: string, payload: any) => { sent.push(payload.blocks[0].text); started(); return new Response(JSON.stringify({ updated: 11 })); });
  await w.emit("ready", w.editor);
  await w.type("a");
  w.advance(20);
  await w.type("ab");
  w.advance(1000);
  w.runDue();
  await sending;
  expect(sent).toEqual(["ab"]);
});
