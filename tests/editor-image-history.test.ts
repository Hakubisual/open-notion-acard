import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { editorNextChunk } from "../scripts/build-editor-next.ts";

const editorSource = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const modelSource = readFileSync(new URL("../assets/editor-model.js", import.meta.url), "utf8");
let nextSource = "", pasteSource = "";
beforeAll(async () => {
  nextSource = (await editorNextChunk()).js;
  const built = await Bun.build({ entrypoints: [new URL("../assets/features/lazy/paste-md.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], minify: true, format: "iife" });
  if (!built.success) throw new AggregateError(built.logs);
  pasteSource = await built.outputs[0].text();
});
const historySource = editorSource.slice(editorSource.indexOf("  var undoStack = [],"), editorSource.indexOf("  function save() {"));
const insertionSource = editorSource.slice(editorSource.indexOf("    insertBlocksAfter: function"), editorSource.indexOf("    replaceBlockText: function"));

async function imageHistory(intervene: boolean) {
  const browser = new Bun.WebView();
  try {
    await browser.navigate("about:blank");
    const result = await browser.evaluate(`(async () => {
      ${modelSource}
      document.body.innerHTML='<main id="doc"><div id="blocks"></div></main>';
      const host=document.getElementById('blocks'), model=window.EditorModel, selectedIds=new Set();
      let state={title:'Image test',blocks:[{id:'a',type:'paragraph',text:'Preserve this text',indent:0,meta:null}],dirty:false,saving:false};
      let saveTimer=null,startupEdited=false,hasToc=false,n=0;
      const listeners={};
      const emitFeature=(name,value)=>(listeners[name]||[]).slice().forEach(fn=>fn(value));
      const render=()=>{host.innerHTML='';state.blocks.forEach(b=>{const row=document.createElement('div');row.className='blk';row.dataset.id=b.id;row.id='block-'+b.id;const text=document.createElement('div');text.className='text';text.contentEditable='true';text.textContent=b.text;row.appendChild(text);host.appendChild(row);});};
      const structure=b=>b,subpagesOf=()=>[],syncSubpages=()=>{},paintTocs=()=>{},setSave=()=>{},save=()=>Promise.resolve();
      const newBlock=()=>({id:'image-'+(++n),type:'paragraph',text:'',indent:0,meta:null});
      ${historySource}
      selectionTools={capture:ids=>({selectedBlockIds:ids,anchor:null,focus:null}),restore:()=>{}};
      const apis={};
      window.AcardEditor={
        get state(){return state;},slug:'test',coreEditing:true,transact,captureSelection,render,scheduleSave,setSave,
        ${insertionSource}
        provide(name,api){apis[name]=api;},
        lazy:name=>Promise.resolve(apis[name]||{}),
        on(name,fn){(listeners[name]||(listeners[name]=[])).push(fn);return()=>{listeners[name]=listeners[name].filter(x=>x!==fn);};},
        api:()=>Promise.resolve({}),transport:()=>Promise.resolve(new Response('{}')),
      };
      let finishUpload, uploadStarted;
      const requestStarted=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('upload request did not start')),3000);uploadStarted=()=>{clearTimeout(timer);resolve(true);};});
      window.AcardEditorProvider={fetch:()=>new Promise(resolve=>{finishUpload=()=>resolve(new Response(JSON.stringify({url:'/media/0123456789abcdef',name:'tiny.png',size:68}),{headers:{'content-type':'application/json'}}));uploadStarted();})};
      render();previousSnapshot=snapshot();
      new Function(${JSON.stringify(pasteSource)})();
      new Function(${JSON.stringify(nextSource)})();apis['editor-next'].start();
      const uploaded=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('upload completion not observed')),3000);
        listeners.change=[()=>{if(state.blocks.some(b=>b.type==='image'&&b.meta.src&&!b._busy)){clearTimeout(timer);resolve(true);}}];
      });
      const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const data=new DataTransfer();data.items.add(new File([blob],'tiny.png',{type:'image/png'}));
      host.querySelector('.text').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
      await requestStarted;
      if (${intervene}) transact('typing while upload pending',()=>{state.blocks[0].text='Edited during upload';});
      finishUpload();await uploaded;clearTimeout(saveTimer);
      const before=state.blocks.map(b=>({type:b.type,text:b.text,src:b.meta&&b.meta.src}));
      const entries=undoStack.length;
      restoreEdit(undoStack,redoStack);clearTimeout(saveTimer);
      const undone=state.blocks.map(b=>({type:b.type,text:b.text}));
      restoreEdit(redoStack,undoStack);clearTimeout(saveTimer);
      const redone=state.blocks.map(b=>({type:b.type,text:b.text,src:b.meta&&b.meta.src}));
      return {before,entries,undone,redone};
    })()`);
    return result;
  } finally {
    await browser.close();
  }
}

test("one undo after a pasted image finishes uploading removes it, and redo restores its uploaded URL", async () => {
    expect(await imageHistory(false)).toEqual({
      before: [{ type: "paragraph", text: "Preserve this text", src: null }, { type: "image", text: "", src: "/media/0123456789abcdef" }],
      entries: 1,
      undone: [{ type: "paragraph", text: "Preserve this text" }],
      redone: [{ type: "paragraph", text: "Preserve this text", src: null }, { type: "image", text: "", src: "/media/0123456789abcdef" }],
    });
}, 15000);

test("undoing a completed image upload preserves typing made while it was uploading", async () => {
  expect(await imageHistory(true)).toEqual({
    before: [{ type: "paragraph", text: "Edited during upload", src: null }, { type: "image", text: "", src: "/media/0123456789abcdef" }],
    entries: 2,
    undone: [{ type: "paragraph", text: "Edited during upload" }],
    redone: [{ type: "paragraph", text: "Edited during upload", src: null }, { type: "image", text: "", src: "/media/0123456789abcdef" }],
  });
}, 15000);
