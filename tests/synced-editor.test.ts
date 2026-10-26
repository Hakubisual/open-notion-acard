import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const path = new URL("../assets/features/lazy/synced-blocks.js", import.meta.url);
const source = existsSync(path) ? readFileSync(path, "utf8") : "";
const editorSource = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
const liveSource = readFileSync(new URL("../assets/features/lazy/live.js", import.meta.url), "utf8");
const adoption = liveSource.slice(liveSource.indexOf("  function adoptRemote("), liveSource.indexOf("  if (window.AcardEditor) window.AcardEditor.adoptRemote"));
const history = editorSource.match(/remoteHistory: function \(remote[^]*?\},\r?\n/)![0].replace(/^remoteHistory: /, "").replace(/,\r?\n$/, "");

async function withEditor(run: (view: Bun.WebView) => Promise<void>, enabled = true, width = 1440) {
  const view = new Bun.WebView({ width, height: 900 });
  try {
    await view.navigate("about:blank");
    await view.evaluate(`(() => {
      document.body.innerHTML = '<main id="doc"><div id="blocks"></div></main>';
      window.errors=[]; addEventListener('error', e=>errors.push(e.message));
      window.undoStack=[]; window.redoStack=[]; window.previousSnapshot=null;
      window.events={}; window.emitFeature=(name,value)=>(events[name]||[]).forEach(fn=>fn(value));
      window.snapshot=()=>JSON.stringify({title:AcardEditor.state.title,blocks:AcardEditor.state.blocks});
      window.calls=[]; window.menu=[]; window.palette=[]; window.receipt=null;
      window.remote={page:{title:'Target',updated:2},blocks:[{id:'s',type:'synced',text:'',indent:0,meta:{synced:{v:1,source:null}}}]};
      window.resolved=[{id:'r',status:'available',source:{page:'source',block:'s'},source_updated:8,editable:true,html:'<p id="synced-r-p">Shared <strong>content</strong></p>'}];
      window.AcardEditor={slug:'target',coreEditing:${enabled},state:{title:'Target',baseUpdated:1,dirty:false,saving:false,blocks:[{id:'p',type:'paragraph',text:'Text',indent:0}],pages:[{slug:'target',title:'Target'},{slug:'source',title:'Source'}]},commands:{},
        contextMenu:{register(item){menu.push(item);}},palette:{register(item){palette.push(item);}},
        getSelection(){return {blockIds:['p'],blockId:'p'};},captureSelection(){return {selectedBlockIds:[]};},restoreSelection(){},
        on(name,fn){(events[name]||=[]).push(fn);},provide(name,api){window.synced=api;},setSave(text,error){window.lastSave={text,error};},render(){},
        save:async()=>{},lazy:async()=>({}),recordExternalEdit(run){undoStack.push({run});redoStack.length=0;},remoteHistory:${history},
        api:async(path,options)=>{ calls.push({path,body:options?JSON.parse(options.body):null});
          if(options){ if(window.rejectWrite) throw Error('conflict'); const body=JSON.parse(options.body); const n=(receipt?.reference_updated||1)+1;
            receipt={history:'receipt-'+n,reference_updated:n,source_updated:body.source_updated||n};remote.page.updated=n;return {receipt}; }
          if(path.endsWith('/synced'))return {updated:8,resolved};return remote;
        }};
      ${adoption}
      AcardEditor.adoptRemote=adoptRemote;
      ${source}
    })()`);
    await run(view);
    expect(await view.evaluate("errors")).toEqual([]);
  } finally { view.close(); }
}

test("synced commands register in both existing registries only behind the core flag", async () => {
  await withEditor(async view => {
    expect(await view.evaluate("menu.map(x=>x.id)")).toContain("synced-create");
    expect(await view.evaluate("palette.map(x=>x.id)")).toContain("synced-insert");
  });
  await withEditor(async view => {
    expect(await view.evaluate("[menu.length,palette.length,Object.keys(AcardEditor.commands).length]")).toEqual([0,0,0]);
  }, false);
});

test("creating a source saves first and records versioned receipt undo and redo without losing earlier history", async () => {
  await withEditor(async view => {
    await view.evaluate(`(async()=>{undoStack.push({label:'earlier'}); await AcardEditor.commands.createSynced(['p']); window.first=undoStack.at(-1); await first.run(); await first.run();})()`);
    expect(await view.evaluate("calls.filter(x=>x.body).map(x=>x.body)")).toEqual([
      {ids:["p"],base_updated:1}, {undo:"receipt-2",base_updated:2,source_updated:2}, {undo:"receipt-3",base_updated:3,source_updated:2}
    ]);
    expect(await view.evaluate("[undoStack.length,undoStack[0].label,AcardEditor.state.baseUpdated,document.getElementById('doc').inert]")).toEqual([2,"earlier",4,false]);
  });
});

test("reference creation and detach use the source version and refuse a draft changed during save", async () => {
  await withEditor(async view => {
    await view.evaluate(`(async()=>{await AcardEditor.commands.insertSynced({page:'source',block:'s'},8,'p');await AcardEditor.commands.detachSynced('r',8);})()`);
    expect(await view.evaluate("calls.filter(x=>x.body)")).toEqual([
      {path:"/page/target/synced",body:{source:{page:"source",block:"s"},source_updated:8,beforeId:"p",base_updated:1}},
      {path:"/page/target/synced/r/detach",body:{source_updated:8,base_updated:2}}
    ]);
    await view.evaluate("AcardEditor.save=async()=>{AcardEditor.state.dirty=true;}");
    expect(await view.evaluate("AcardEditor.commands.createSynced(['p']).then(()=>false,()=>true)")).toBe(true);
    expect(await view.evaluate("calls.filter(x=>x.body).length")).toBe(2);
  });
});

test("conflicts retain the receipt and restore editor interaction", async () => {
  await withEditor(async view => {
    await view.evaluate("AcardEditor.commands.createSynced(['p'])");
    await view.evaluate("window.rejectWrite=true");
    expect(await view.evaluate("undoStack.at(-1).run().then(()=>false,e=>e.message)")).toBe("conflict");
    expect(await view.evaluate("[undoStack.length,document.getElementById('doc').inert,AcardEditor.state.baseUpdated]")).toEqual([1,false,2]);
  });
});

for (const width of [1440,390]) test(`synced references render rich read-only content and gated actions at ${width}px`, async () => {
  await withEditor(async view => {
    await view.evaluate(`(async()=>{const host=document.createElement('div');host.id='reference';document.getElementById('blocks').append(host);await synced.mount(host,{id:'r',type:'synced',meta:{synced:{v:1,source:{page:'source',block:'s'}}}});})()`);
    expect(await view.evaluate("[document.querySelector('#reference strong').textContent,document.querySelector('#reference [contenteditable=true]'),document.querySelector('#reference a').getAttribute('href'),document.querySelectorAll('#reference button').length]")).toEqual(["content",null,"/edit/source/#block-s",1]);
    expect(await view.evaluate("document.getElementById('reference').getBoundingClientRect().right<=innerWidth")).toBe(true);
  },true,width);
});

test("flag-off and unavailable references never expose edit actions or stale source content", async () => {
  await withEditor(async view => {
    await view.evaluate(`(async()=>{const host=document.createElement('div');host.id='reference';document.body.append(host);await synced.mount(host,{id:'r',meta:{synced:{v:1,source:{page:'source',block:'s'}}}});})()`);
    expect(await view.evaluate("document.querySelectorAll('#reference button,#reference a').length")).toBe(0);
    await view.evaluate(`(async()=>{resolved=[{id:'r',status:'unavailable'}];await synced.mount(document.getElementById('reference'),{id:'r',meta:{synced:{v:1,source:{page:'source',block:'s'}}}});})()`);
    expect(await view.evaluate("document.querySelector('#reference strong')")).toBeNull();
    expect(await view.evaluate("document.getElementById('reference').textContent.includes('source')")).toBe(false);
  },false);
});

test("live source changes refresh mounted references without scanning editable blocks", async () => {
  await withEditor(async view => {
    await view.evaluate(`(async()=>{
      const host=document.createElement('div');host.id='reference';document.body.append(host);
      await synced.mount(host,{id:'r',meta:{synced:{v:1,source:{page:'source',block:'s'}}}});
      AcardEditor.state.blocks=new Proxy([], {get(){throw Error('whole-page scan');}});
      resolved=[{id:'r',status:'unavailable'}];
      window.done=new Promise(resolve=>{const observer=new MutationObserver(()=>{if(!host.querySelector('strong')){observer.disconnect();resolve(true);}});observer.observe(host,{subtree:true,childList:true});});
      document.dispatchEvent(new CustomEvent('acard:live',{detail:{slugs:['source'],kinds:['page']}}));
    })()`);
    expect(await view.evaluate("Promise.race([done,new Promise(resolve=>setTimeout(()=>resolve(false),1000))])")).toBe(true);
    expect(await view.evaluate("document.querySelectorAll('#reference a,#reference button').length")).toBe(0);
  });
});

test("an older response cannot repaint a reference after a newer unavailable result", async () => {
  await withEditor(async view => {
    await view.evaluate(`(async()=>{
      const host=document.createElement('div');host.id='reference';document.body.append(host);
      let finish;AcardEditor.api=()=>new Promise(resolve=>{finish=resolve;});
      const first=synced.mount(host,{id:'r',meta:{synced:{v:1,source:{page:'source',block:'s'}}}});
      AcardEditor.api=async()=>({resolved:[{id:'r',status:'unavailable'}]});
      document.dispatchEvent(new CustomEvent('acard:live',{detail:{slugs:['source']}}));
      finish({resolved});await first;
    })()`);
    expect(await view.evaluate("document.querySelector('#reference strong')")).toBeNull();
  });
});
