import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const start = source.indexOf("  function renderTree(");
const end = source.indexOf("  function loadBacklinks(", start);
const lazySource = readFileSync(new URL("../assets/features/lazy/editor-page-menu.js", import.meta.url), "utf8");
const menuFunctions = lazySource.slice(lazySource.indexOf("  function pageMenu("), lazySource.lastIndexOf("    pageMenu(anchor, page);"));
const menuSource = source.slice(start, source.indexOf("  function pageMenu(", start)) + menuFunctions;

function setup() {
  let focused: Node | null = null;
  class Node extends EventTarget {
    children: Node[] = [];
    parent: Node | null = null;
    hidden = false;
    style = {};
    value = "";
    textContent = "";
    href = "";
    onblur: ((event: Event) => void) | null = null;
    onkeydown: ((event: Event) => void) | null = null;
    constructor(readonly tagName: string) { super(); }
    set innerHTML(value: string) { this.replaceChildren(); }
    setAttribute() {}
    dispatchEvent(event: Event) {
      if (event.type === "blur") this.onblur?.(event);
      if (event.type === "keydown") this.onkeydown?.(event);
      return super.dispatchEvent(event);
    }
    appendChild(node: Node) { this.children.push(node); node.parent = this; }
    add(node: Node) { this.appendChild(node); }
    replaceChildren() { this.children = []; }
    replaceWith(node: Node) {
      if (!this.parent) return;
      const parent = this.parent;
      parent.children[parent.children.indexOf(this)] = node;
      node.parent = parent;
      this.parent = null;
    }
    querySelector(selector: string): Node | null {
      for (const node of this.children) {
        if (node.tagName === (selector === "button" ? "button" : "a") && (!selector.includes("href=") || selector.includes(node.href))) return node;
        const found = node.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    focus() { focused = this; }
    select() {}
    blur() { this.dispatchEvent(new Event("blur")); }
    getBoundingClientRect() { return { left: 250, bottom: 100 }; }
  }
  const ctx = new Node("div"), tree = new Node("div"), link = new Node("a"), anchor = new Node("button"), title = new Node("input");
  link.textContent = title.value = "Original";
  link.href = "/edit/page/";
  tree.appendChild(link);
  const page = { slug: "page", title: "Original", parent: "parent" };
  const state = { title: "Original", pages: [page, { slug: "parent", title: "Parent" }] };
  const events = new EventTarget();
  const requests: { path: string; options: any; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const errors: { message: string; on: boolean }[] = [];
  let loads = 0;
  const api = (path: string, options: unknown) => new Promise((resolve, reject) => { requests.push({ path, options, resolve, reject }); });
  const loadTree = async () => { loads++; events.dispatchEvent(new Event("loaded")); };
  const setSave = (message: string, on: boolean) => { errors.push({ message, on }); events.dispatchEvent(new Event("error-ui")); };
  class Option extends Node {
    constructor(text: string, value: string) { super("option"); this.textContent = text; this.value = value; }
  }
  const run = new Function("els", "document", "window", "state", "slug", "api", "loadTree", "setSave", "location", "Option", menuSource + "return { pageMenu, renameInline, pickParent };");
  const location = { href: "" };
  const actions = run({ ctx, tree, title }, { createElement: (tag: string) => new Node(tag) }, { innerWidth: 1000, innerHeight: 800, confirm: () => true }, state, "page", api, loadTree, setSave, location, Option);
  const fire = (node: Node, type: string, key?: string) => {
    const event = new Event(type, { cancelable: true });
    if (key) Object.defineProperty(event, "key", { value: key });
    node.dispatchEvent(event);
    return event;
  };
  const signal = (name: string) => new Promise<void>((resolve, reject) => {
    const timeout = AbortSignal.timeout(1000);
    const aborted = () => reject(new Error("Missing " + name + " event"));
    timeout.addEventListener("abort", aborted, { once: true });
    events.addEventListener(name, () => { timeout.removeEventListener("abort", aborted); resolve(); }, { once: true });
  });
  return { actions, page, ctx, tree, link, anchor, title, state, requests, errors, fire, signal, location, focus: () => focused, loads: () => loads };
}

test("sidebar menu focuses its first button and Escape returns to the trigger", () => {
  const f = setup();
  f.actions.pageMenu(f.anchor, f.page);
  const button = f.ctx.children[1];
  expect(f.focus()).toBe(button);
  f.fire(button, "keydown", "Escape");
  expect(f.ctx.hidden).toBe(true);
  expect(f.focus()).toBe(f.anchor);
});

test("sidebar mousedown preserves selection and click activates a menu action", () => {
  const f = setup();
  f.actions.pageMenu(f.anchor, f.page);
  const rename = f.ctx.children[1];
  expect(f.fire(rename, "mousedown").defaultPrevented).toBe(true);
  expect(f.tree.querySelector('a[href="/edit/page/"]')?.textContent).toBe("Original");
  expect(f.ctx.hidden).toBe(false);
  f.fire(rename, "click");
  expect(f.tree.children[0].tagName).toBe("input");
  expect(f.ctx.hidden).toBe(true);
});

test("sidebar click without a pointer activates rename like a native keyboard click", () => {
  const f = setup();
  f.actions.pageMenu(f.anchor, f.page);
  f.fire(f.ctx.children[1], "click");
  expect(f.tree.children[0].tagName).toBe("input");
});

test("failed inline rename restores the original link and reports the error", async () => {
  const f = setup();
  f.actions.renameInline(f.page);
  const input = f.tree.children[0];
  input.value = "Unsaved";
  const reported = f.signal("error-ui");
  f.fire(input, "keydown", "Enter");
  expect(f.requests[0].path).toBe("/page/page/rename");
  f.requests[0].reject(new Error("rename failed"));
  await reported;
  expect(f.tree.querySelector('a[href="/edit/page/"]')?.textContent).toBe("Original");
  expect(f.state.title).toBe("Original");
  expect(f.title.value).toBe("Original");
  expect(f.errors).toEqual([{ message: "rename failed", on: true }]);
});

test("successful inline rename updates the current title and refreshes the tree", async () => {
  const f = setup();
  f.actions.renameInline(f.page);
  const input = f.tree.children[0];
  input.value = "Saved";
  const loaded = f.signal("loaded");
  f.fire(input, "keydown", "Enter");
  f.requests[0].resolve({});
  await loaded;
  expect(f.state.title).toBe("Saved");
  expect(f.title.value).toBe("Saved");
  expect(f.errors).toEqual([]);
});

for (const [index, method, path] of [[3, "POST", "/page/page/move"], [4, "DELETE", "/page/page"]] as const) {
  test("sidebar " + method + " " + path + " reports rejected requests", async () => {
    const f = setup();
    f.actions.pageMenu(f.anchor, f.page);
    f.fire(f.ctx.children[index], "click");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ path, options: { method } });
    const reported = f.signal("error-ui");
    f.requests[0].reject(new Error("request failed"));
    await reported;
    expect(f.errors).toEqual([{ message: "request failed", on: true }]);
  });
}

// #162: deleting the open page went to "/", the public landing. It goes to the parent page, or the app home at the top level.
for (const [parent, want] of [["parent", "/edit/parent/"], [null, "/home/"]] as const) {
  test("deleting the open page from the sidebar lands on " + want, async () => {
    const f = setup();
    f.actions.pageMenu(f.anchor, f.page);
    (f.page as any).parent = parent;
    f.fire(f.ctx.children[4], "click");
    expect(f.requests[0]).toMatchObject({ path: "/page/page", options: { method: "DELETE" } });
    f.requests[0].resolve({});
    await Promise.resolve(); await Promise.resolve();
    expect(f.location.href).toBe(want);
  });
}

test("parent-picker failure restores the page link even if the tree cannot refresh", async () => {
  const f = setup();
  f.actions.pickParent(f.page);
  const select = f.tree.children[0];
  expect(select.children.map(option => [option.textContent, option.value])).toEqual([["(맨 위)", ""], ["Parent", "parent"]]);
  select.value = "parent";
  const reported = f.signal("error-ui");
  f.fire(select, "change");
  f.requests[0].reject(new Error("move failed"));
  await reported;
  expect(f.tree.querySelector('a[href="/edit/page/"]')?.textContent).toBe("Original");
  expect(f.errors).toEqual([{ message: "move failed", on: true }]);
});

// The editor closes els.ctx on any document click outside it. The ⋯ button's own click bubbles there right after
// pageMenu opened the menu, so without stopPropagation the menu closed at once (live: fallback sidebar, mouse and Enter).
test("the page menu opened from ⋯ stays open when its click reaches the document", () => {
  const ctx = new EventTarget() as any;
  ctx.hidden = true; ctx.children = []; ctx.style = {};
  ctx.replaceChildren = () => { ctx.children = []; };
  ctx.appendChild = (n: any) => { ctx.children.push(n); n.parent = ctx; };
  ctx.contains = (n: any) => { for (let p = n; p; p = p.parent) if (p === ctx) return true; return false; };
  const doc = new EventTarget() as any;
  const make = (tag: string) => {
    const n = new EventTarget() as any;
    Object.assign(n, { tagName: tag, children: [], style: {}, parent: null, className: "", textContent: "", setAttribute() {}, focus() {},
      appendChild(c: any) { n.children.push(c); c.parent = n; }, getBoundingClientRect: () => ({ left: 250, bottom: 100 }) });
    // Bubble to the document like a real click on an element in the page.
    const dispatch = n.dispatchEvent.bind(n);
    n.dispatchEvent = (ev: Event) => { const ok = dispatch(ev); if (ev.bubbles && !(ev as any).__stopped) doc.dispatchEvent(new Event(ev.type)); return ok; };
    return n;
  };
  doc.createElement = make;
  const page = { slug: "page", title: "Page", parent: null };
  const run = new Function("els", "document", "window", "state", "slug", "api", "loadTree", "setSave", "location", "Option",
    menuSource + "return { treeList };");
  const { treeList } = run({ ctx, tree: make("div"), title: make("input") }, doc, { innerWidth: 1000, innerHeight: 800 }, { pages: [page] }, "page", () => new Promise(() => {}), () => {}, () => {}, { href: "" }, class {});
  doc.addEventListener("click", (ev: any) => { if (!ctx.hidden && !ctx.contains(ev.target ?? null)) ctx.hidden = true; });
  const ul = treeList([page]);
  const more = ul.children[0].children[0].children.find((n: any) => n.tagName === "button");
  const click = new Event("click", { bubbles: true, cancelable: true });
  const stop = click.stopPropagation.bind(click);
  click.stopPropagation = () => { (click as any).__stopped = true; stop(); };
  more.dispatchEvent(click);
  expect(ctx.hidden).toBe(false);
  expect(ctx.children[1].textContent).toBe("이름 바꾸기");
});
