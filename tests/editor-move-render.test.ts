import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { setup, cookie, read } from "./db-harness";

const root = join(import.meta.dir, "..");
const h = setup();
const lorem = ["아카드는 에이전트가 쓰고 사람이 읽는 노트예요.", "긴 문단은 줄바꿈과 자간이 그대로인지 보는 데 써요.", "Mixed English text keeps the Latin glyph metrics in view.", "숫자 1234567890 과 기호 · — … 도 함께 들어가요."];
const seed = Array.from({ length: 600 }, (_, i) => ({ id: "move" + i, type: i % 25 === 0 ? "heading2" : i % 7 === 0 ? "bulleted" : "paragraph", text: i % 25 === 0 ? "구역 " + (i / 25 + 1) : lorem[i % 4] + " " + lorem[(i + 1) % 4], indent: 0, checked: false, meta: null }));
let server: ReturnType<typeof Bun.serve>;
let view: Bun.WebView;
const frames = `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`;
async function key(key: string, code: string, vk: number, modifiers = 0) {
  await view.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers });
  await view.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
}
async function reset(blocks = seed) {
  await view.evaluate(`(async()=>{AcardEditor.transact('fixture',()=>{AcardEditor.state.blocks=${JSON.stringify(blocks)};});AcardEditor.selectBlocks([]);await AcardEditor.save();await ${frames};})()`);
}
async function history(redo = false) { await key("z", "KeyZ", 90, redo ? 10 : 2); }
async function assertOrder() {
  expect(await view.evaluate(`JSON.stringify(AcardEditor.state.blocks.map(b=>b.id))===JSON.stringify(Array.from(document.querySelectorAll('#blocks .blk'),r=>r.dataset.id))`)).toBe(true);
}

beforeAll(async () => {
  await h.call("POST", "/api/pages", { slug: "move-render", title: "[PERF] 긴 페이지" });
  await h.call("PUT", "/api/page/move-render", { blocks: seed });
  const auth = await cookie();
  const names = ["block-commands", "editor-selection", "editor-navigation", "synced-blocks", "ai-marks-ui", "easy-insert", "components", "context-menu", "tab-palette"];
  const html = read("assets/editor.html")
    .replace('<script src="/site-config.js"></script>', '<script>window.DoriSite={name:"Test"};window.browserErrors=[];addEventListener("error",e=>browserErrors.push(e.message));</script>')
    .replace('<script src="/features.js"></script>', `<script>window.AcardLazy=${JSON.stringify(Object.fromEntries(names.map(name => [name, { js: "test" }])))};</script>`)
    .replace('<script src="/editor.js"></script>', '<script src="/editor.js"></script><script>AcardEditor.provide("recent-cache",{load:p=>p});</script>');
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/edit/")) return new Response(html, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/lazy/components.js") return new Response('AcardEditor.provide("components",{ready:Promise.resolve(),slashItems:()=>[]});', { headers: { "content-type": "text/javascript" } });
    if (url.pathname.startsWith("/api/")) {
      const headers = new Headers(request.headers); headers.set("cookie", auth);
      return h.worker.fetch(new Request(request.url, { method: request.method, headers, body: request.method === "GET" ? undefined : await request.text() }), h.env);
    }
    const file = Bun.file(join(root, "assets", url.pathname.startsWith("/lazy/") ? "features" + url.pathname : url.pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("missing", { status: 404 });
  }});
  view = new Bun.WebView({ width: 1440, height: 900 });
  await view.navigate(server.url.href + "edit/move-render/?core-editing=on");
  await view.evaluate(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('editor ready timeout')),10000);AcardEditor.on('ready',()=>{clearTimeout(timer);resolve();});})`);
  await view.evaluate(`Promise.all([AcardEditor.lazy('block-commands'),AcardEditor.lazy('editor-selection'),document.fonts.ready])`);
}, 20000);
afterAll(() => { view?.close(); server?.stop(true); h.sqlite.close(); });

test("500 selected blocks move latency with trusted changed-order keyboard events", async () => {
  await view.cdp("Emulation.setCPUThrottlingRate", { rate: 4 });
  const measurements = [];
  try {
    for (let run = 0; run < 5; run++) {
      await reset();
      await view.evaluate(`(()=>{AcardEditor.selectBlocks(AcardEditor.state.blocks.slice(1,501).map(b=>b.id));const host=document.getElementById('blocks');host.tabIndex=-1;host.focus({preventScroll:true});window.moveDone=new Promise(resolve=>{window.addEventListener('keydown',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));},{once:true,capture:true});});})()`);
      await view.evaluate(frames);
      const start = performance.now();
      await key("ArrowDown", "ArrowDown", 40, 10);
      const browserMs = await view.evaluate<number>("moveDone");
      const wallMs = performance.now() - start;
      const order = await view.evaluate(`AcardEditor.state.blocks.map(b=>b.id)`);
      expect(order).toEqual(["move0", "move501", ...seed.slice(1, 501).map(b => b.id), ...seed.slice(502).map(b => b.id)]);
      await assertOrder();
      expect(await view.evaluate("AcardEditor.captureSelection().selectedBlockIds.length")).toBe(500);
      measurements.push({ browserMs, wallMs });
    }
    console.log("MOVE_500_PROFILE " + JSON.stringify({ measurements, medianBrowserMs: measurements.map(m => m.browserMs).sort((a, b) => a - b)[2], medianWallMs: measurements.map(m => m.wallMs).sort((a, b) => a - b)[2] }));
  } finally { await view.cdp("Emulation.setCPUThrottlingRate", { rate: 1 }); }
}, 60000);

test("moved rows keep editing, deletion, indentation, selection and undo bound to their IDs", async () => {
  const small = seed.slice(0, 7).map((b, i) => ({ ...b, type: i === 2 ? "bulleted" : "paragraph", text: "Text " + i }));
  await reset(small);
  await view.evaluate(`(()=>{AcardEditor.selectBlocks(['move1','move2']);const host=document.getElementById('blocks');host.tabIndex=-1;host.focus();window.oldRows=Array.from(host.children);})()`);
  await key("ArrowDown", "ArrowDown", 40, 10);
  await assertOrder();
  expect(await view.evaluate(`AcardEditor.state.blocks.map(b=>b.id)`)).toEqual(["move0", "move3", "move1", "move2", "move4", "move5", "move6"]);
  expect(await view.evaluate(`oldRows.every(row=>row===document.getElementById(row.id))`)).toBe(true);
  expect(await view.evaluate(`AcardEditor.captureSelection().selectedBlockIds`)).toEqual(["move1", "move2"]);
  await history();
  expect(await view.evaluate(`AcardEditor.state.blocks`)).toEqual(small);
  await history(true);
  await assertOrder();
  await view.evaluate(`(()=>{AcardEditor.commands.moveBlocks(['move1'],{afterId:'move4'});AcardEditor.selectBlocks([]);const text=document.querySelector('#block-move1 .text');text.focus();getSelection().setBaseAndExtent(text.firstChild,2,text.firstChild,4);window.bookmark=AcardEditor.captureSelection();AcardEditor.commands.moveBlocks(['move1'],{beforeId:'move3'});})()`);
  expect(await view.evaluate(`AcardEditor.captureSelection()`)).toEqual(await view.evaluate("bookmark"));
  await view.cdp("Input.insertText", { text: "EDIT" });
  expect(await view.evaluate(`AcardEditor.state.blocks.find(b=>b.id==='move1').text`)).toBe("TeEDIT 1");
  expect(await view.evaluate(`AcardEditor.state.blocks.filter(b=>b.id!=='move1').every(b=>b.text==='Text '+b.id.slice(4))`)).toBe(true);
  await view.evaluate(`(()=>{AcardEditor.commands.moveBlocks(['move2'],{beforeId:'move3'});AcardEditor.selectBlocks([]);document.querySelector('#block-move2 .text').focus();})()`);
  await key("Tab", "Tab", 9);
  expect(await view.evaluate(`AcardEditor.state.blocks.filter(b=>b.indent).map(b=>b.id)`)).toEqual(["move2"]);
  await assertOrder();
  await history();
  await view.evaluate(`(()=>{AcardEditor.commands.moveBlocks(['move2'],{afterId:'move4'});AcardEditor.selectBlocks(['move2']);document.getElementById('blocks').focus();})()`);
  await key("Delete", "Delete", 46);
  expect(await view.evaluate(`AcardEditor.state.blocks.some(b=>b.id==='move2')`)).toBe(false);
  expect(await view.evaluate(`AcardEditor.state.blocks.find(b=>b.id==='move1').text`)).toBe("TeEDIT 1");
  await history();
  expect(await view.evaluate(`AcardEditor.state.blocks.find(b=>b.id==='move2').text`)).toBe("Text 2");
  await assertOrder();
  await view.evaluate(`AcardEditor.save()`);
  const normalized = (blocks: any[]) => blocks.map(b => ({ ...b, meta: b.meta || null }));
  expect(normalized((await h.call("GET", "/api/page/move-render")).data.blocks)).toEqual(normalized(await view.evaluate<any[]>(`AcardEditor.state.blocks`)));
  expect(await view.evaluate("browserErrors")).toEqual([]);
}, 20000);

test("nested moves retain subtree rendering rather than reuse index-bound complex rows", async () => {
  const nested = seed.slice(0, 5).map((b, i) => ({ ...b, indent: i === 2 ? 1 : 0 }));
  await reset(nested);
  await view.evaluate(`AcardEditor.commands.moveBlocks(['move1'],{afterId:'move3'})`);
  expect(await view.evaluate(`AcardEditor.state.blocks.map(b=>b.id)`)).toEqual(["move0", "move3", "move1", "move2", "move4"]);
  expect(await view.evaluate(`document.getElementById('block-move1').contains(document.getElementById('block-move2'))`)).toBe(true);
  await assertOrder();
  await history();
  expect(await view.evaluate(`AcardEditor.state.blocks`)).toEqual(nested);
}, 10000);

test("repeated and noncontiguous moves update gutter insertion indices and preserve flag-off rendering", async () => {
  await reset(seed.slice(0, 8));
  await view.evaluate(`(()=>{AcardEditor.commands.moveBlocks(['move1','move4'],{afterId:'move6'});AcardEditor.commands.moveBlocks(['move1','move4'],{beforeId:'move2'});document.querySelector('#block-move4 > .gutter > button').click();})()`);
  const order = await view.evaluate<string[]>(`AcardEditor.state.blocks.map(b=>b.id)`);
  expect(order.slice(0, 3)).toEqual(["move0", "move1", "move4"]);
  expect(order.slice(4)).toEqual(["move2", "move3", "move5", "move6", "move7"]);
  expect(await view.evaluate(`AcardEditor.state.blocks[3].text`)).toBe("/");
  await assertOrder();
  await view.evaluate(`(()=>{window.oldRow=document.getElementById('block-move1');AcardEditor.coreEditing=false;AcardEditor.commands.moveBlocks(['move1'],{afterId:'move7'});})()`);
  expect(await view.evaluate(`oldRow!==document.getElementById('block-move1')`)).toBe(true);
  await view.evaluate(`AcardEditor.coreEditing=true`);
  await assertOrder();
}, 10000);

test("moved text rows retain visible ordering at desktop and mobile widths", async () => {
  await reset(seed.slice(0, 8));
  for (const width of [1440, 390]) {
    await view.cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await view.evaluate(`(()=>{AcardEditor.selectBlocks(['move1','move2']);AcardEditor.commands.moveBlocks(['move1','move2'],{afterId:'move4'});})()`);
    await view.evaluate(frames);
    await assertOrder();
    expect(await view.evaluate(`Array.from(document.querySelectorAll('#blocks > .blk')).every((row,i,rows)=>i===0||row.getBoundingClientRect().top>=rows[i-1].getBoundingClientRect().bottom)`)).toBe(true);
    if (process.env.QA_MOVE_OUT) await Bun.write(join(process.env.QA_MOVE_OUT, `move-${width}.png`), await view.screenshot());
  }
}, 10000);
