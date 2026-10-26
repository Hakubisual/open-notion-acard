import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, cookie } from "./db-harness";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const lazyNames = ["recent-cache", "changed-blocks", "synced-blocks", "block-commands", "editor-selection", "context-menu", "tab-palette", "command-search", "ai-marks-ui"];

for (const width of [1440, 390]) test(`real editor and server create, reference, detach, Ctrl+Z and reload at ${width}px`, async () => {
  const h = setup();
  for (const slug of ["source", "target"]) {
    expect((await h.call("POST", "/api/pages", { slug, title: slug })).status).toBe(200);
    expect((await h.call("PUT", "/api/page/" + slug, { blocks: [{ id: "p", type: "paragraph", text: slug === "source" ? "Shared original" : "Target text", indent: 0 }] })).status).toBe(200);
  }
  const auth = await cookie();
  const manifest = Object.fromEntries(lazyNames.map(name => [name, { js: "test", ...(name === "synced-blocks" ? { css: "test" } : {}) }]));
  const html = read("assets/editor.html").replace('<html lang="ko">', '<html lang="ko" data-core-editing="on" data-human-edit="on">').replace('<head>', '<head><meta name="acard-id" content="0123456789abcdef">')
    .replace('<script src="/features.js"></script>', `<script>window.AcardLazy=${JSON.stringify(manifest)};</script><script src="/features/changed-blocks.js"></script><script src="/features/save-queue.js"></script>`)
    .replace('<link rel="preload" as="script" href="/lazy/recent-cache.js?v=__RECENT_CACHE_JS__">', "")
    .replace('<script src="/editor.js"></script>', '<script src="/editor.js"></script><script>AcardEditor.provide("recent-cache",{load:p=>p});AcardLazy={"recent-cache":{js:"test"}};</script>')
    .replace('<script src="/site-config.js"></script>', '<script>window.DoriSite={name:"Test"};window.browserErrors=[];addEventListener("error",e=>browserErrors.push(e.message));</script>');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/edit/")) return new Response(html, { headers: { "content-type": "text/html", "set-cookie": "acard_id=0123456789abcdef; Path=/; SameSite=Lax" } });
    if (url.pathname === "/lazy/recent-cache.js") return new Response("", {headers:{"content-type":"text/javascript"}});
    if (url.pathname.startsWith("/api/")) {
      const headers = new Headers(request.headers); headers.set("cookie", auth);
      return h.worker.fetch(new Request(request.url, { method: request.method, headers, body: request.method === "GET" ? undefined : await request.text() }), h.env);
    }
    const file = Bun.file(join(root, "assets", url.pathname.startsWith("/lazy/") ? "features" + url.pathname : url.pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("missing", { status: 404 });
  }});
  const view = new Bun.WebView({ width, height: 900 });
  async function open(slug: string) {
    await view.navigate(server.url.href + "edit/" + slug + "/?core-editing=on");
    await view.evaluate(`new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('editor ready timeout')),5000);AcardEditor.on('ready',async()=>{try{await AcardEditor.lazy('synced-blocks');clearTimeout(timeout);resolve();}catch(e){reject(e);}});})`);
  }
  async function undo() {
    await view.evaluate(`new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('receipt undo timeout')),5000);const off=AcardEditor.on('remoteAdopted',()=>{off();clearTimeout(timeout);resolve();});document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));})`);
  }
  let stage = "open source";
  try {
    await open("source");
    await view.evaluate(`(async()=>{await AcardEditor.lazy('context-menu');await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{observer.disconnect();reject(Error('menu timeout'));},5000);const observer=new MutationObserver(()=>{if(document.querySelector('.cm')){clearTimeout(timeout);observer.disconnect();resolve();}});observer.observe(document.body,{childList:true});AcardEditor.contextMenu.openBlock('p',document.querySelector('.drag-handle'));});})()`);
    expect(await view.evaluate("document.querySelector('.cm').textContent.includes('동기화 블록')")).toBe(true);
    const created = await view.evaluate(`(async()=>{AcardEditor.contextMenu.close();try{await AcardEditor.commands.createSynced(['p']);return null;}catch(e){return {error:e.message,browserErrors};}})()`);
    expect(created).toBeNull();
    const canonical = (await h.call("GET", "/api/page/source")).data;
    expect(canonical.blocks.map((b: any) => b.type)).toEqual(["synced", "paragraph"]);
    const sourceId = canonical.blocks[0].id;
    stage = "undo source";
    await undo();
    expect((await h.call("GET", "/api/page/source")).data.blocks.map((b: any) => b.type)).toEqual(["paragraph"]);
    await view.evaluate(`new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('redo timeout')),5000);const off=AcardEditor.on('remoteAdopted',()=>{off();clearTimeout(timeout);resolve();});document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));})`);
    const version = (await h.call("GET", "/api/page/source")).data.page.updated;
    stage = "open target";
    await open("target");
    stage = "insert reference";
    await view.evaluate(`(async()=>{
      await AcardEditor.lazy('tab-palette');await AcardEditor.palette.open('p',document.getElementById('block-p'));
      const input=document.querySelector('.tp-input');input.value='동기화';input.dispatchEvent(new Event('input'));
      [...document.querySelectorAll('.tp-item')].find(item=>item.textContent.includes('가져오기')).click();
      await new Promise((resolve,reject)=>{const select=document.querySelector('.synced-picker select:last-of-type');if(select.options.length)return resolve();const timeout=setTimeout(()=>{observer.disconnect();reject(Error('source picker timeout'));},5000);const observer=new MutationObserver(()=>{if(select.options.length){clearTimeout(timeout);observer.disconnect();resolve();}});observer.observe(select,{childList:true});});
      await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('insert timeout')),5000);const off=AcardEditor.on('remoteAdopted',()=>{off();clearTimeout(timeout);resolve();});document.querySelector('.synced-picker button:last-of-type').click();});
    })()`);
    const target = (await h.call("GET", "/api/page/target")).data;
    expect(target.blocks[0].meta.synced.source).toEqual({ page: "source", block: sourceId });
    await open("target");
    await view.evaluate(`new Promise((resolve,reject)=>{const host=document.getElementById('blocks');const check=()=>host.querySelector('.synced-content')?.textContent.includes('Shared original');if(check())return resolve();const timeout=setTimeout(()=>{observer.disconnect();reject(Error('reference render timeout'));},5000);const observer=new MutationObserver(()=>{if(check()){clearTimeout(timeout);observer.disconnect();resolve();}});observer.observe(host,{subtree:true,childList:true});})`);
    expect(await view.evaluate("document.querySelector('.synced-content').isContentEditable")).toBe(false);
    expect(await view.evaluate("document.querySelector('.synced-block').getBoundingClientRect().right<=innerWidth")).toBe(true);
    await view.evaluate(`AcardEditor.commands.detachSynced(${JSON.stringify(target.blocks[0].id)},${version})`);
    expect((await h.call("GET", "/api/page/target")).data.blocks[0].type).toBe("paragraph");
    await undo();
    expect((await h.call("GET", "/api/page/target")).data.blocks[0].type).toBe("synced");
    await open("target");
    expect(await view.evaluate("AcardEditor.state.blocks[0].type")).toBe("synced");
  } catch (error) { console.error(stage, await view.evaluate("browserErrors")); throw error; }
  finally { view.close(); server.stop(true); h.sqlite.close(); }
}, 30000);
