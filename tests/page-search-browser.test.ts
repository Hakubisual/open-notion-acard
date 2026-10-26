import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (name: string) => readFileSync(join(root, name), "utf8");

for (const width of [1440, 390]) test(`page search cold opening, keyboard and text links at ${width}px`, async () => {
  const requests: string[] = [];
  const manifest = { "page-search": { js: "palette-test" }, "recent-cache": { js: "test" } };
  const html = source("assets/editor.html")
    .replace("<head>", '<head><meta name="acard-id" content="palette-member">')
    .replace('<script src="/site-config.js"></script>', `<script>window.DoriSite={name:"Palette QA"};window.browserErrors=[];addEventListener("error",e=>browserErrors.push(e.message));window.AcardEditorProvider={fetch:(url,options)=>fetch(url,options)};localStorage.setItem("dori-notes-recent:palette-member",JSON.stringify([{slug:"recent",title:"Recent page"}]));</script>`)
    .replace('<script src="/features.js"></script>', `<script>window.AcardLazy=${JSON.stringify(manifest)};</script>`)
    .replace('<script src="/editor.js"></script>', '<script src="/editor.js"></script><script>AcardEditor.provide("recent-cache",{load:p=>p});</script>');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    if (url.pathname.startsWith("/edit/")) return new Response(html, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/lazy/recent-cache.js" || url.pathname === "/features.css") return new Response("");
    if (url.pathname === "/api/page/palette") return Response.json({ page: { slug: "palette", title: "Search palette QA", kind: "note", updated: 1 }, blocks: [{ id: "first", type: "paragraph", text: "Select this text to add a link.", indent: 0 }] });
    if (url.pathname === "/api/search") return Response.json({ results: [{ slug: "first-result", title: "First result", hit: "Matches the query" }, { slug: "second-result", title: "Second result", kind: "db", hit: "Another matching page" }] });
    if (url.pathname.startsWith("/api/")) return Response.json({ pages: [], backlinks: [], settings: {} });
    if (url.pathname === "/style.css") return new Response(source("assets/tokens.css") + source("assets/style.css"), { headers: { "content-type": "text/css" } });
    const file = Bun.file(join(root, "assets", url.pathname.startsWith("/lazy/") ? "features" + url.pathname : url.pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("missing", { status: 404 });
  }});
  const view = new Bun.WebView({ width, height: 900 });
  const press = (key: string, ctrlKey = false) => view.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:${ctrlKey},bubbles:true,cancelable:true}))`);
  const open = async () => {
    await view.evaluate(`(()=>{window.paletteOpened=new Promise((resolve,reject)=>{const palette=document.getElementById('palette');const timer=setTimeout(()=>{observer.disconnect();reject(Error('palette open timeout'));},5000);const observer=new MutationObserver(()=>{if(!palette.hidden){observer.disconnect();clearTimeout(timer);resolve();}});observer.observe(palette,{attributes:true,attributeFilter:['hidden']});});})()`);
    await press("k", true);
    await view.evaluate("paletteOpened");
  };
  try {
    await view.navigate("about:blank");
    await view.cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await view.navigate(server.url.href + "edit/palette/");
    await view.evaluate(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('editor ready timeout')),5000);AcardEditor.on('ready',()=>{clearTimeout(timer);resolve();});})`);
    expect(requests.some(url => url.startsWith("/lazy/page-search"))).toBe(false);
    expect(requests.some(url => url.startsWith("/api/search"))).toBe(false);
    await open();
    expect(await view.evaluate("document.activeElement.id")).toBe("palette-q");
    expect(await view.evaluate("document.querySelector('#palette-list a').getAttribute('href')")).toBe("/edit/recent/");
    expect(requests.filter(url => url.startsWith("/lazy/page-search"))).toEqual(["/lazy/page-search.js?v=palette-test"]);
    await view.evaluate(`new Promise((resolve,reject)=>{const list=document.getElementById('palette-list');const timer=setTimeout(()=>{observer.disconnect();reject(Error('search render timeout'));},5000);const observer=new MutationObserver(()=>{if(list.querySelectorAll('a').length===2){observer.disconnect();clearTimeout(timer);resolve();}});observer.observe(list,{childList:true});const input=document.getElementById('palette-q');input.value='result';input.dispatchEvent(new Event('input',{bubbles:true}));})`);
    await press("ArrowDown");
    expect(await view.evaluate("document.querySelector('#palette-list .on').getAttribute('href')")).toBe("/edit/second-result/");
    await press("ArrowUp");
    expect(await view.evaluate("document.querySelector('#palette-list .on').getAttribute('href')")).toBe("/edit/first-result/");
    await view.evaluate("document.fonts.ready");
    if (process.env.QA_PALETTE_OUT) await Bun.write(join(process.env.QA_PALETTE_OUT, `${width}-page-search.png`), await view.screenshot());
    const bounds: any = await view.evaluate(`(()=>{const r=document.querySelector('#palette .sheet').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};})()`);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    await press("k", true);
    expect(await view.evaluate("document.getElementById('palette').hidden")).toBe(true);
    await open();
    await press("Escape");
    expect(await view.evaluate("document.getElementById('palette').hidden")).toBe(true);
    expect(requests.filter(url => url.startsWith("/lazy/page-search"))).toHaveLength(1);
    await view.evaluate(`(()=>{const text=document.querySelector('#blocks .text');text.focus();const range=document.createRange();range.selectNodeContents(text);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
    await view.evaluate(`document.querySelector('.format-toolbar button[aria-label="링크"]').click()`);
    expect(await view.evaluate("!!document.querySelector('dialog[open] input[type=url]')")).toBe(true);
    expect(await view.evaluate("document.getElementById('palette').hidden")).toBe(true);
    await view.evaluate(`document.querySelector('dialog[open]').close()`);
    expect(await view.evaluate("browserErrors")).toEqual([]);
  } finally { view.close(); server.stop(true); }
}, 30000);
