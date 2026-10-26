import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { editorNextChunk } from "../scripts/build-editor-next.ts";

const source = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const editorSource = source("assets/editor.js");
const section = (from: string, to: string) => editorSource.slice(editorSource.indexOf(from), editorSource.indexOf(to, editorSource.indexOf(from)));
let browser: Bun.WebView, pasteMd: string, next: string, server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [new URL("../assets/features/lazy/paste-md.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], minify: true, format: "iife" });
  if (!built.success) throw new AggregateError(built.logs);
  pasteMd = await built.outputs[0].text();
  const editorChunk = await editorNextChunk();
  expect(Buffer.byteLength(editorChunk.js + editorChunk.css)).toBeLessThanOrEqual(40000);
  next = editorChunk.js;
  browser = new Bun.WebView({ width: 1440, height: 900 });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">', { headers: { "content-type": "text/html" } }) });
}, 20000);
afterAll(async () => { await browser.close(); server.stop(true); });

async function setup() {
  await browser.navigate(server.url.href);
  await browser.evaluate(`(() => {
    document.head.innerHTML = '<style>' + ${JSON.stringify(source("assets/tokens.css") + source("assets/features/lazy/context-menu.css"))} + '</style>';
    document.body.innerHTML = '<main id="doc" style="max-width:760px;margin:80px auto;font:17px/1.85 system-ui"><h1>URL paste</h1><div id="blocks"></div><input id="title" hidden></main>';
    ${source("assets/editor-model.js")}
    window.model = EditorModel;
    window.state = { title: 'URL paste', blocks: [{ id: 'a', type: 'paragraph', text: 'AlphaBravo', indent: 0, meta: { richText: [{ text: 'Alpha', bold: true }, { text: 'Bravo', italic: true }] } }], pages: [{ slug: 'guide', title: 'Guide' }] };
    window.els = { blocks: document.getElementById('blocks'), slash: { hidden: true } };
    window.selectedIds = new Set(); window.structure = value => value;
    window.coreEditing = true; window.startupEdited = false;
    window.subpagesOf = () => []; window.syncSubpages = () => {}; window.paintTocs = () => {};
    window.save = () => Promise.resolve(); window.status = '';
    window.setSave = message => { window.status = message; };
    const events = {}; window.emitFeature = (name, value) => (events[name] || []).slice().forEach(fn => fn(value));
    let saveTimer = null, hasToc = false, serial = 0;
    ${section("  var undoStack = [],", "  function save() {")}
    window.newBlock = () => ({ id: 'n' + (++serial), type: 'paragraph', text: '', indent: 0, checked: false, meta: null });
    window.render = () => {
      els.blocks.replaceChildren();
      state.blocks.forEach(block => {
        const row = document.createElement('div'); row.className = 'blk'; row.dataset.id = block.id; row.id = 'block-' + block.id;
        const host = document.createElement('div'); host.className = 'text'; host.contentEditable = 'true';
        host.innerHTML = model.richHtml(block.meta && block.meta.richText, block.text);
        host.addEventListener('input', () => { const runs = model.readRich(host); block.text = runs.map(r => r.text).join(''); block.meta = { ...block.meta, richText: runs }; scheduleSave(); clearTimeout(saveTimer); });
        row.append(host); els.blocks.append(row);
      });
    };
    const apis = {}; window.loads = []; window.hold = null;
    window.AcardEditor = {
      state, coreEditing: true, slug: 'test', createBlock: newBlock, transact, captureSelection, restoreSelection, render,
      scheduleSave, setSave, getSelection: () => ({ blockIds: [] }), selectBlocks: () => {},
      on(name, fn) { (events[name] ||= []).push(fn); return () => { events[name] = events[name].filter(f => f !== fn); }; },
      provide(name, api) { apis[name] = api; if(name === 'editor-selection') selectionTools = api; },
      api(path) { if (path.startsWith('/link-preview')) return window.preview || Promise.resolve({ title: 'Example', description: 'Preview', site: 'example.com' }); if (path === '/media/import') return window.preview || Promise.resolve({ url: '/media/image.png' }); return Promise.reject(Error('not requested')); },
      transport: () => Promise.reject(Error('not requested')),
      lazy(name) { loads.push(name); const result = name === 'ai-marks-ui' ? { ready: Promise.resolve() } : apis[name]; return window.hold && name === 'paste-md' ? window.hold.then(() => result) : Promise.resolve(result); }
    };
    window.ColumnsModel = { canIndent: () => true };
    ${source("assets/features/lazy/editor-selection.js")}
    ${source("assets/features/lazy/block-commands.js")}
    ${source("assets/features/lazy/context-menu.js")}
    ${pasteMd}
    ${next}
    render(); previousSnapshot = snapshot(); apis['editor-next'].start();
    window.place = (start = 5, end = start) => { const host = els.blocks.querySelector('.text'); host.focus(); const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), nodes = []; while(walk.nextNode()) nodes.push(walk.currentNode); const point = offset => { for (const node of nodes) { if(offset <= node.length) return [node, offset]; offset -= node.length; } return [host,0]; }; getSelection().setBaseAndExtent(...point(start), ...point(end)); return host; };
    window.paste = (url = 'https://example.com/path') => { const data = new DataTransfer(); data.setData('text/plain', url); const host = document.activeElement; host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); clearTimeout(saveTimer); };
    window.menuAfter = action => new Promise((resolve, reject) => { const timer = setTimeout(() => { observer.disconnect(); reject(Error('URL chooser not opened')); }, 1500); const observer = new MutationObserver(() => { if(document.querySelector('[data-url-choice]')) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); observer.observe(document.body, { childList: true, subtree: true }); action(); });
    window.choose = kind => { const button = document.querySelector('[data-url-choice="' + kind + '"]'); return new Promise((resolve, reject) => { const timer = setTimeout(() => { off(); reject(Error('choice did not change document')); }, 1500); const off = AcardEditor.on('change', () => { off(); clearTimeout(timer); resolve(true); }); button.click(); }); };
    window.result = () => { clearTimeout(saveTimer); return { blocks: structuredClone(state.blocks), undo: undoStack.length, selection: captureSelection(), status: window.status }; };
    window.undo = () => { restoreEdit(undoStack, redoStack); clearTimeout(saveTimer); };
  })()`);
}

test("URL link choice preserves rich prefix/suffix and undoes in one transaction", async () => {
  await setup();
  await browser.evaluate(`menuAfter(() => { place(); paste(); })`);
  await browser.click('[data-url-choice="link"]');
  const value: any = await browser.evaluate(`result()`);
  expect(value.blocks).toHaveLength(1);
  expect(value.blocks[0].text).toBe("Alphahttps://example.com/pathBravo");
  expect(value.blocks[0].meta.richText).toEqual([{ text: "Alpha", bold: true }, { text: "https://example.com/path", href: "https://example.com/path" }, { text: "Bravo", italic: true }]);
  expect(value.undo).toBe(1);
  await browser.evaluate(`undo()`);
  expect((await browser.evaluate(`result()`)) as any).toMatchObject({ blocks: [{ text: "AlphaBravo" }], undo: 0, selection: { anchor: { offset: 5 }, focus: { offset: 5 } } });
});

test("preview, embed and imported image choices split at the caret with one undo", async () => {
  for (const [kind, type] of [["preview", "bookmark"], ["embed", "embed"], ["image", "image"]]) {
    await setup();
    await browser.evaluate(`menuAfter(() => { place(); paste(); })`);
    await browser.evaluate(`choose(${JSON.stringify(kind)})`);
    const value: any = await browser.evaluate(`result()`);
    expect(value.blocks.map((b: any) => [b.type, b.text])).toEqual([["paragraph", "Alpha"], [type, ""], ["paragraph", "Bravo"]]);
    expect(value.blocks[0].meta.richText).toEqual([{ text: "Alpha", bold: true }]);
    expect(value.blocks[2].meta.richText).toEqual([{ text: "Bravo", italic: true }]);
    expect(value.blocks[1].meta).toMatchObject(kind === "image" ? { src: "/media/image.png" } : { url: "https://example.com/path" });
    if (kind === "preview") expect(value.blocks[1].meta.title).toBe("Example");
    expect(value.undo).toBe(1);
    await browser.evaluate(`undo()`);
    expect((await browser.evaluate(`result()`)) as any).toMatchObject({ blocks: [{ text: "AlphaBravo" }], undo: 0 });
  }
});

test("same-origin page URL becomes a real page mention, never an external page slug", async () => {
  await setup();
  await browser.evaluate(`menuAfter(() => { place(); paste(location.origin + '/edit/guide/'); })`);
  expect(await browser.evaluate(`!!document.querySelector('[data-url-choice="mention"]') && !document.querySelector('[data-url-choice="embed"]')`)).toBe(true);
  await browser.evaluate(`choose('mention')`);
  expect((await browser.evaluate(`result()`)) as any).toMatchObject({ blocks: [{ text: "AlphaGuideBravo", meta: { richText: [{ text: "Alpha", bold: true }, { text: "Guide", mention: { type: "page", slug: "guide" } }, { text: "Bravo", italic: true }] } }], undo: 1 });
  await setup();
  await browser.evaluate(`menuAfter(() => { place(); paste('https://example.com/guide/'); })`);
  expect(await browser.evaluate(`!!document.querySelector('[data-url-choice="mention"]')`)).toBe(false);
});

test("selected text, explicit plain paste and code stay on their existing literal paths", async () => {
  for (const mode of ["selection", "plain", "code"]) {
    await setup();
    const value: any = await browser.evaluate(`(() => {
      if (${JSON.stringify(mode)} === 'code') { state.blocks[0].type = 'code'; render(); }
      const host = place(5, ${JSON.stringify(mode)} === 'selection' ? 10 : 5);
      if (${JSON.stringify(mode)} === 'plain') host.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }));
      paste();
      return { ...result(), loads, linked: !!host.querySelector('a') };
    })()`);
    expect(value.loads).not.toContain("paste-md");
    expect(value.blocks[0].text).toBe(mode === "selection" ? "AlphaBravo" : "Alphahttps://example.com/pathBravo");
    expect(value.linked).toBe(mode === "selection");
  }
});

test("an outstanding lazy load or metadata response cannot paste into a changed document", async () => {
  await setup();
  expect(await browser.evaluate(`(async () => {
    hold = new Promise(resolve => { window.release = resolve; });
    place(); paste(); state.blocks[0].text = 'changed'; emitFeature('change'); release();
    await hold; await Promise.resolve(); await Promise.resolve();
    return { menu: !!document.querySelector('[data-url-choice]'), ...result() };
  })()`)).toMatchObject({ menu: false, undo: 0, blocks: [{ text: "changed" }] });
  await setup();
  await browser.evaluate(`menuAfter(() => { place(); paste(); })`);
  expect(await browser.evaluate(`(async () => {
    preview = new Promise(resolve => { window.release = resolve; });
    const done = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('late preview not cancelled')), 1500); window.setSave = message => { clearTimeout(timer); window.status = message; resolve(true); }; AcardEditor.setSave = window.setSave; });
    document.querySelector('[data-url-choice="preview"]').click(); await Promise.resolve();
    state.blocks[0].text = 'changed'; emitFeature('change');
    release({ title: 'Late preview' }); await done;
    return result();
  })()`)).toMatchObject({ undo: 0, blocks: [{ text: "changed" }] });
});

test("Escape cancels the chooser, and typing dismisses a stale choice", async () => {
  await setup();
  await browser.evaluate(`menuAfter(() => { place(); paste(); })`);
  expect(await browser.evaluate(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return { menu: !!document.querySelector('[data-url-choice]'), ...result() }; })()`)).toMatchObject({ menu: false, undo: 0, blocks: [{ text: "AlphaBravo" }] });
  await browser.evaluate(`menuAfter(() => { place(); paste(); })`);
  expect(await browser.evaluate(`(() => { state.blocks[0].text += '!'; emitFeature('change'); return !!document.querySelector('[data-url-choice]'); })()`)).toBe(false);
});

test("a cold URL paste captures the caret without requiring the selection chunk yet", async () => {
  await setup();
  await browser.evaluate(`menuAfter(() => { place(); window.captureBeforeLoad = AcardEditor.captureSelection; AcardEditor.captureSelection = () => { throw Error('selection chunk not loaded'); }; paste(); })`);
  await browser.evaluate(`(() => { AcardEditor.captureSelection = captureBeforeLoad; return choose('link'); })()`);
  expect((await browser.evaluate(`result()`)) as any).toMatchObject({ undo: 1, blocks: [{ text: "Alphahttps://example.com/pathBravo" }] });
});

test("cold structured paste waits for block commands and preserves caret prefix and suffix", async () => {
  await setup();
  const result = await browser.evaluate(`(async () => {
    const insert=AcardEditor.commands.insertBlocks, lazy=AcardEditor.lazy;
    delete AcardEditor.commands.insertBlocks;
    let release;
    const loaded=new Promise(resolve=>{release=resolve;});
    AcardEditor.lazy=name=>name==='block-commands'?loaded.then(()=>{AcardEditor.commands.insertBlocks=insert;return {}; }):lazy(name);
    const host=place(5), data=new DataTransfer();data.setData('text/html','<h2>Inserted</h2><p>Second</p>');data.setData('text/plain','Inserted Second');
    const changed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(Error('cold paste did not complete'));},2000);const off=AcardEditor.on('change',()=>{clearTimeout(timer);off();resolve(true);});});
    host.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    const before=state.blocks.map(x=>x.text);release();await changed;
    const after=state.blocks.map(x=>[x.type,x.text]);undo();return {before,after,undone:state.blocks.map(x=>x.text)};
  })()`);
  expect(result).toEqual({before:["AlphaBravo"],after:[["paragraph","Alpha"],["heading2","Inserted"],["paragraph","Second"],["paragraph","Bravo"]],undone:["AlphaBravo"]});
});

test("cold structured paste refuses a selection moved during loading", async () => {
  await setup();
  const result = await browser.evaluate(`(async () => {
    const insert=AcardEditor.commands.insertBlocks,lazy=AcardEditor.lazy;delete AcardEditor.commands.insertBlocks;
    let release;const loaded=new Promise(resolve=>{release=resolve;});
    AcardEditor.lazy=name=>name==='block-commands'?loaded.then(()=>{AcardEditor.commands.insertBlocks=insert;return {}; }):lazy(name);
    const refused=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('stale paste not rejected')),2000);AcardEditor.setSave=message=>{clearTimeout(timer);resolve(message);};});
    const host=place(5),data=new DataTransfer();data.setData('text/html','<h2>Inserted</h2><p>Second</p>');data.setData('text/plain','Inserted Second');
    host.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));place(0);release();await refused;
    return {texts:state.blocks.map(x=>x.text),undo:result().undo};
  })()`);
  expect(result).toEqual({texts:["AlphaBravo"],undo:0});
});
