import { expect, test } from "bun:test";
import { join } from "node:path";
import { setup, cookie, read } from "./db-harness";
import { renderBlocks } from "../block-html.js";

const root = join(import.meta.dir, "..");
const seed = [
  { id: "bullet", type: "bulleted", text: "Bulleted parent", indent: 0, meta: { ai: "lock", richText: [{ text: "Bulleted parent", bold: true }] } },
  { id: "nested", type: "numbered", text: "Nested numbered child", indent: 1, meta: { open: false } },
  { id: "deep", type: "paragraph", text: "Grandchild content", indent: 2 },
  { id: "number", type: "numbered", text: "Numbered parent", indent: 0 },
  { id: "child", type: "bulleted", text: "Nested bulleted child", indent: 1 },
  { id: "sibling", type: "numbered", text: "Following sibling", indent: 0 },
];
const shape = (blocks: any[]) => blocks.map(({ id, type, text, indent }) => ({ id, type, text, indent }));

for (const width of [1440, 390]) test(`list folds preserve structure, persistence, undo and reader at ${width}px`, async () => {
  const h = setup();
  expect((await h.call("POST", "/api/pages", { slug: "folds", title: "List folding" })).status).toBe(200);
  expect((await h.call("PUT", "/api/page/folds", { blocks: seed })).status).toBe(200);
  const original = (await h.call("GET", "/api/page/folds")).data.blocks;
  const auth = await cookie();
  const names = ["recent-cache", "block-commands", "editor-selection", "synced-blocks", "ai-marks-ui", "editor-navigation", "context-menu", "tab-palette"];
  const manifest = Object.fromEntries(names.map(name => [name, { js: "test" }]));
  const html = read("assets/editor.html")
    .replace('<html lang="ko">', '<html lang="ko" data-human-edit="on">')
    .replace('<script src="/site-config.js"></script>', '<script>window.DoriSite={name:"Test"};window.browserErrors=[];addEventListener("error",e=>browserErrors.push(e.message));</script>')
    .replace('<script src="/features.js"></script>', `<script>window.AcardLazy=${JSON.stringify(manifest)};</script>`)
    .replace('<script src="/editor.js"></script>', '<script src="/editor.js"></script><script>AcardEditor.provide("recent-cache",{load:p=>p});</script>');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/edit/")) return new Response(html, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/reader") {
      const blocks = (await h.call("GET", "/api/page/folds")).data.blocks;
      return new Response('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><main id="article">' + renderBlocks(blocks) + "</main>", { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/lazy/recent-cache.js") return new Response("", { headers: { "content-type": "text/javascript" } });
    if (url.pathname.startsWith("/api/")) {
      const headers = new Headers(request.headers); headers.set("cookie", auth);
      return h.worker.fetch(new Request(request.url, { method: request.method, headers, body: request.method === "GET" ? undefined : await request.text() }), h.env);
    }
    const file = Bun.file(join(root, "assets", url.pathname.startsWith("/lazy/") ? "features" + url.pathname : url.pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("missing", { status: 404 });
  }});
  const view = new Bun.WebView({ width, height: 900 });
  const twist = (id: string) => `#block-${id} > .body > .trow > .twist`;
  const visible = (id: string) => view.evaluate(`document.getElementById('block-${id}').getBoundingClientRect().height > 0`);
  async function open(enabled = true) {
    await view.navigate(server.url.href + "edit/folds/" + (enabled ? "?core-editing=on" : ""));
    await view.evaluate(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('editor ready timeout')),5000);AcardEditor.on('ready',()=>{clearTimeout(timer);resolve();});})`);
  }
  async function history(redo = false) {
    await view.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:${redo},bubbles:true,cancelable:true}))`);
  }
  async function screenshot(name: string) {
    if (process.env.QA_LIST_FOLD_OUT) await Bun.write(join(process.env.QA_LIST_FOLD_OUT, `${width}-${name}.png`), await view.screenshot());
  }
  try {
    await view.navigate("about:blank");
    await view.cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await open();
    expect(await view.evaluate("innerWidth")).toBe(width);
    expect(await visible("nested")).toBe(true);
    expect(await visible("deep")).toBe(false);
    expect(await view.evaluate(`document.querySelector(${JSON.stringify(twist("bullet"))}).getAttribute('aria-expanded')`)).toBe("true");
    expect(await view.evaluate("document.querySelector('#block-sibling > .body > .trow') === null")).toBe(true);
    expect(await view.evaluate("getComputedStyle(document.querySelector('#block-child > .marker'),'::before').content")).toBe('"•"');
    expect(await view.evaluate("getComputedStyle(document.querySelector('#block-number > .body > .children')).counterReset")).toBe("ednum 0");
    await view.evaluate("document.fonts.ready");
    await screenshot("expanded");
    for (const id of ["bullet", "number"]) {
      const child = id === "bullet" ? "nested" : "child";
      await view.click(twist(id));
      expect(await visible(child)).toBe(false);
      expect(await visible("sibling")).toBe(true);
      expect(await view.evaluate(`document.querySelector(${JSON.stringify(twist(id))}).getAttribute('aria-expanded')`)).toBe("false");
      await history();
      expect(await visible(child)).toBe(true);
      await history(true);
      expect(await visible(child)).toBe(false);
    }
    await view.evaluate("AcardEditor.save()");
    const saved = (await h.call("GET", "/api/page/folds")).data.blocks;
    expect(shape(saved)).toEqual(shape(original));
    expect(saved[0].meta).toMatchObject({ ...original[0].meta, open: false });
    expect(saved[1].meta).toEqual(original[1].meta);
    expect(saved[3].meta.open).toBe(false);
    await screenshot("collapsed");
    await open();
    expect(await visible("nested")).toBe(false);
    expect(await visible("child")).toBe(false);
    await view.click(twist("bullet"));
    expect(await visible("nested")).toBe(true);
    expect(await visible("deep")).toBe(false);
    await view.click(twist("nested"));
    expect(await visible("deep")).toBe(true);
    await view.evaluate("AcardEditor.save()");
    await open();
    expect(await visible("deep")).toBe(true);
    expect(await view.evaluate("AcardEditor.state.blocks[0].type")).toBe("bulleted");
    expect(await view.evaluate("document.querySelector('#block-bullet > .marker') !== null && document.querySelector('#block-number > .marker') !== null")).toBe(true);
    expect(await view.evaluate("document.querySelector('#block-bullet > .body').getBoundingClientRect().right <= innerWidth")).toBe(true);
    expect(await view.evaluate("browserErrors")).toEqual([]);
    await open(false);
    expect(await view.evaluate("document.querySelector('#block-number > .body > .trow') === null")).toBe(true);
    expect(await visible("child")).toBe(true);
    await view.navigate(server.url.href + "reader");
    expect(await view.evaluate("document.querySelector('#block-number').nextElementSibling.tagName")).toBe("DETAILS");
    expect(await view.evaluate("document.querySelector('#block-number').nextElementSibling.open")).toBe(false);
    expect(await view.evaluate("document.querySelector('#block-number').closest('ol') !== null")).toBe(true);
    expect(await view.evaluate("document.querySelector('#block-bullet').closest('ul') !== null")).toBe(true);
    await screenshot("reader");
    await view.click("#block-number + details > summary");
    expect(await view.evaluate("document.querySelector('#block-number').nextElementSibling.open")).toBe(true);
    expect(await view.evaluate("document.querySelector('#block-child').getBoundingClientRect().height > 0")).toBe(true);
    await open();
    await view.evaluate("(async()=>{await AcardEditor.lazy('editor-navigation');AcardEditor.commands.jumpToBlock('child');})()");
    expect(await visible("child")).toBe(true);
    expect(await view.evaluate("AcardEditor.state.blocks.find(b=>b.id==='number').meta.open")).toBe(true);
  } finally { view.close(); server.stop(true); h.sqlite.close(); }
}, 30000);
