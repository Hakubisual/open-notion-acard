import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../assets/features/lazy/editor-navigation.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/features/lazy/editor-navigation.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../assets/tokens.css", import.meta.url), "utf8").replace(/@font-face\{[^}]*\}/g, "");
const fixture = `
  document.body.innerHTML = '<button id="opener">Outline</button><main id="doc"><input id="title"><div id="blocks"></div></main>';
  window.listeners = {}; window.saves = 0; window.browserErrors = []; window.selectedBlockIds = [];
  window.addEventListener('error', event => browserErrors.push(event.message));
  window.originalCommands = { duplicate() { return 'human-edit'; }, openPalette() { return 'palette'; } };
  window.emit = name => (listeners[name] || []).forEach(fn => fn());
  window.AcardEditor = { state: { blocks: [], title: 'Excluded page title' }, commands: originalCommands,
    on(name, fn) { (listeners[name] ||= []).push(fn); if(name === 'ready') fn(); },
    getSelection() { return { blockIds: selectedBlockIds, text: window.getSelection().toString() }; },
    provide(name, api) { window.providedName = name; window.navigation = api; },
    scheduleSave() { saves++; emit('change'); }
  };
  window.render = () => {
    const host = document.getElementById('blocks'); host.replaceChildren(); const parents = [];
    AcardEditor.state.blocks.forEach((block, index) => {
      while(parents.length && parents.at(-1).depth >= (block.indent || 0)) parents.pop();
      const row = document.createElement('div'); row.className = 'blk'; row.id = 'block-' + block.id;
      row.dataset.id = block.id; row.dataset.index = String(index);
      const body = document.createElement('div'); body.className = 'body'; row.append(body);
      let textHost = body;
      if(block.type === 'toggle' || block.meta?.toggle) {
        row.classList.toggle('collapsed', !block.meta?.open);
        textHost = document.createElement('div'); textHost.className = 'trow'; body.append(textHost);
        const twist = document.createElement('button'); twist.className = 'twist'; textHost.append(twist);
      }
      const text = document.createElement('div'); text.className = 'text'; text.contentEditable = 'true';
      text.spellcheck = false; text.textContent = block.text; textHost.append(text);
      text.addEventListener('input', () => { block.text = text.textContent; emit('change'); });
      const children = document.createElement('div'); children.className = 'children'; body.append(children);
      (parents.length ? parents.at(-1).host : host).append(row); parents.push({ depth: block.indent || 0, host: children });
    });
  };
  window.setBlocks = blocks => { AcardEditor.state.blocks = blocks; render(); emit('change'); };
  window.typeText = (id, value) => {
    const text = document.getElementById('block-' + id).querySelector('.text'); text.textContent = value;
    text.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  document.getElementById('title').addEventListener('input', () => emit('change'));
`;

async function withBrowser(run: (browser: Bun.WebView) => Promise<void>, width = 1440) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><html><body></body></html>", { headers: { "content-type": "text/html" } }) });
  const browser = new Bun.WebView({ width, height: 900 });
  try {
    await browser.navigate(server.url.href);
    await browser.cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate(`(() => {
      document.head.innerHTML = '<style>' + ${JSON.stringify(tokens + css + ".collapsed > .body > .children{display:none}.text{min-height:40px}body{font-family:system-ui;background:var(--color-bg);color:var(--color-text)}")} + '</style>';
      ${fixture}
      ${source}
    })()`);
    await run(browser);
    expect(await browser.evaluate("browserErrors")).toEqual([]);
  } finally { browser.close(); server.stop(true); }
}

test("outline extracts heading levels 1-4 in document order and preserves existing commands", async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks([{id:'p',type:'paragraph',text:'Body'}, {id:'a',type:'heading1',text:'<img onerror=fail>'},
        {id:'b',type:'heading2',text:'둘'}, {id:'c',type:'heading3',text:'Three'}, {id:'d',type:'heading4',text:'Four'},
        {id:'blank',type:'heading2',text:'   '}, {id:'other',type:'heading5',text:'Not a heading'}]);
      navigation.openOutline();
    })()`);
    expect(await browser.evaluate(`({same:AcardEditor.commands === originalCommands, human:AcardEditor.commands.duplicate(), palette:AcardEditor.commands.openPalette(), providedName,
      links:[...document.querySelectorAll('.editor-navigation li:not([hidden]) a')].map(a=>[a.getAttribute('href'),a.parentElement.className]),
      injected:!!document.querySelector('.editor-navigation img')})`)).toEqual({ same: true, human: "human-edit", palette: "palette", providedName: "editor-navigation", injected: false,
      links: [["#block-a", "editor-navigation-level-1"], ["#block-b", "editor-navigation-level-2"], ["#block-c", "editor-navigation-level-3"], ["#block-d", "editor-navigation-level-4"]] });
  });
}, 15000);

test("jump opens collapsed toggle ancestors in state and DOM, focuses and follows hashes", async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks([{id:'outer',type:'toggle',text:'Outer',meta:{open:false}},
        {id:'inner',type:'heading2',text:'Inner',indent:1,meta:{toggle:true,open:false}},
        {id:'deep space',type:'heading4',text:'Deep',indent:2}, {id:'end',type:'paragraph',text:'Last'}]);
      navigation.openOutline(); navigation.jumpToBlock('deep space');
    })()`);
    expect(await browser.evaluate(`({open:AcardEditor.state.blocks.slice(0,2).map(b=>b.meta.open), collapsed:document.querySelectorAll('.collapsed').length,
      twists:[...document.querySelectorAll('.twist')].map(b=>b.getAttribute('aria-expanded')), focus:document.activeElement.closest('.blk').dataset.id,
      highlight:document.querySelector('.editor-navigation-target').dataset.id, saves, missing:navigation.jumpToBlock('missing')})`)).toEqual({ open: [true, true], collapsed: 0, twists: ["true", "true"], focus: "deep space", highlight: "deep space", saves: 1, missing: false });
    await browser.evaluate(`(async () => {
      const changed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('hashchange timeout')), 3000);
        window.addEventListener('hashchange', () => { clearTimeout(timeout); resolve(); }, {once:true});
      });
      location.hash = '#block-end'; await changed;
    })()`);
    expect(await browser.evaluate("document.activeElement.closest('.blk').dataset.id")).toBe("end");
    expect(await browser.evaluate("navigation.jumpToTop() && document.activeElement.closest('.blk').dataset.id")).toBe("outer");
    expect(await browser.evaluate("navigation.jumpToBottom() && document.activeElement.closest('.blk').dataset.id")).toBe("end");
    await browser.evaluate("(() => { history.replaceState(null, '', '#block-%invalid'); dispatchEvent(new HashChangeEvent('hashchange')); render(); })()");
    expect(await browser.evaluate("document.querySelectorAll('.collapsed').length")).toBe(0);
  });
}, 15000);

test("explicit stats count Korean, English, Unicode and empty text without counting titles", async () => {
  await withBrowser(async browser => {
    await browser.evaluate("setBlocks([{id:'p',type:'paragraph',text:'안녕 세계 hello world'}])");
    expect(await browser.evaluate("navigation.wordStats()")).toEqual({ words: 4, characters: 17, charactersWithoutSpaces: 14, readingMinutes: 1, selection: null });
    await browser.evaluate("setBlocks([{id:'p',type:'paragraph',text:'😀 é'}])");
    expect(await browser.evaluate("navigation.wordStats()")).toEqual({ words: 1, characters: 4, charactersWithoutSpaces: 3, readingMinutes: 1, selection: null });
    await browser.evaluate(`setBlocks([{id:'p',type:'paragraph',text:${JSON.stringify("😀 é\t안녕\r\nworld\u00a0\u2003")}},{id:'q',type:'paragraph',text:'Next'}])`);
    expect(await browser.evaluate("navigation.wordStats()")).toEqual({ words: 4, characters: 20, charactersWithoutSpaces: 14, readingMinutes: 1, selection: null });
    await browser.evaluate("setBlocks([{id:'p',type:'paragraph',text:'hello '.repeat(201)}])");
    expect(await browser.evaluate("navigation.wordStats().readingMinutes")).toBe(2);
    await browser.evaluate("setBlocks([])");
    expect(await browser.evaluate("navigation.wordStats()")).toEqual({ words: 0, characters: 0, charactersWithoutSpaces: 0, readingMinutes: 0, selection: null });
    expect(await browser.evaluate("[navigation.jumpToTop(),navigation.jumpToBottom(),document.querySelector('.editor-navigation-empty').hidden]")).toEqual([false, false, false]);
  });
}, 15000);

test("selected blocks include nested descendants once and exclude following siblings", async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks([{id:'parent',type:'toggle',text:'One',meta:{open:false}},
        {id:'child',type:'paragraph',indent:1,text:'Two'}, {id:'deep',type:'paragraph',indent:2,text:'😀'},
        {id:'sibling',type:'paragraph',indent:1,text:'Three'}, {id:'outside',type:'paragraph',text:'Excluded'},
        {id:'last',type:'paragraph',text:'Four'}]);
      selectedBlockIds = ['child','parent','deep','last','parent'];
      AcardEditor.captureSelection = () => { throw Error('selection serialization'); };
    })()`);
    expect(await browser.evaluate("navigation.wordStats()")).toEqual({ words: 5, characters: 24, charactersWithoutSpaces: 24, readingMinutes: 1,
      selection: { scope: "blocks", words: 4, characters: 16, charactersWithoutSpaces: 16, readingMinutes: 1 } });
    await browser.evaluate("(() => { setBlocks([{id:'empty',type:'paragraph',text:''}]); selectedBlockIds=['empty']; })()");
    expect(await browser.evaluate("navigation.wordStats().selection")).toEqual({ scope: "blocks", words: 0, characters: 0, charactersWithoutSpaces: 0, readingMinutes: 0 });
  });
}, 15000);

test("text selection counts Unicode code points and selected whitespace before panel focus", async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks([{id:'p',type:'paragraph',text:'Before 😀 é\\n안녕 After'}]);
      const text=document.querySelector('.text'); text.style.whiteSpace='pre-wrap'; text.focus();
      window.getSelection().setBaseAndExtent(text.firstChild, 7, text.firstChild, 15);
    })()`);
    expect(await browser.evaluate("navigation.wordStats()")).toEqual({ words: 4, characters: 20, charactersWithoutSpaces: 16, readingMinutes: 1,
      selection: { scope: "text", words: 2, characters: 7, charactersWithoutSpaces: 5, readingMinutes: 1 } });
    await browser.evaluate(`(() => {
      const text=document.querySelector('.text'); text.focus();
      window.getSelection().setBaseAndExtent(text.firstChild, 15, text.firstChild, 7);
    })()`);
    expect(await browser.evaluate("navigation.wordStats().selection")).toEqual({ scope: "text", words: 2, characters: 7, charactersWithoutSpaces: 5, readingMinutes: 1 });
    await browser.evaluate("window.getSelection().collapse(document.querySelector('.text').firstChild, 7)");
    expect(await browser.evaluate("navigation.wordStats().selection")).toBeNull();
  });
}, 15000);

test("text ranges follow native editor selection while unrelated inputs and outside ranges are ignored", async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks([{id:'a',type:'paragraph',text:'First'}, {id:'b',type:'paragraph',text:'Last'}]);
      const texts=document.querySelectorAll('.text'); texts[0].focus();
      window.getSelection().setBaseAndExtent(texts[0].firstChild, 2, texts[1].firstChild, 2);
      window.selectedText=window.getSelection().toString();
    })()`);
    const selectedText = await browser.evaluate("selectedText") as string;
    // Chromium clips rendered selection text at separate contenteditable boundaries.
    expect(selectedText.replace(/\s/gu, "")).toBe("rst");
    expect(await browser.evaluate("navigation.wordStats().selection")).toEqual({ scope: "text", words: 1, characters: Array.from(selectedText).length, charactersWithoutSpaces: 3, readingMinutes: 1 });
    for (const tag of ["input", "textarea"]) {
      await browser.evaluate(`(() => {
        const input=document.createElement('${tag}'); input.id='unrelated'; input.value='not editor text'; document.body.append(input);
        const text=document.querySelector('.text'); text.focus(); window.getSelection().selectAllChildren(text);
        selectedBlockIds=['a']; input.focus(); input.setSelectionRange(0, 3);
      })()`);
      expect(await browser.evaluate("navigation.wordStats().selection")).toBeNull();
      await browser.evaluate("document.getElementById('unrelated').remove()");
    }
    await browser.evaluate(`(() => {
      const input=document.createElement('input'); input.id='embedded-input'; input.value='embedded field'; document.getElementById('blocks').append(input);
      input.focus(); input.setSelectionRange(0, 8);
    })()`);
    expect(await browser.evaluate("navigation.wordStats().selection")).toBeNull();
    await browser.evaluate("document.getElementById('embedded-input').remove()");
    await browser.evaluate(`(() => {
      selectedBlockIds=[]; const outside=document.createElement('div'); outside.textContent='Outside'; document.body.append(outside);
      const text=document.querySelector('.text'); text.focus(); window.getSelection().setBaseAndExtent(text.firstChild, 0, outside.firstChild, 3);
    })()`);
    expect(await browser.evaluate("navigation.wordStats().selection")).toBeNull();
  });
}, 15000);

test("typing touches one outline entry and never scans the document or refreshes stats", async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks([{id:'a',type:'heading1',text:'First'}, {id:'p',type:'paragraph',text:'Body'}, {id:'blank',type:'heading2',text:''}, {id:'z',type:'heading4',text:'Last'}]);
      navigation.openOutline(); window.initialStats = document.querySelector('.editor-navigation-stats').textContent;
      window.stableLink = document.querySelector('.editor-navigation a');
      window.blocks = AcardEditor.state.blocks;
      AcardEditor.state.blocks = new Proxy(blocks, {get(target,key) {
        if(['filter','map','forEach',Symbol.iterator].includes(key)) throw Error('whole-page scan during input');
        return Reflect.get(target,key);
      }});
      AcardEditor.captureSelection = () => { throw Error('selection serialization'); };
      const outline = document.querySelector('.editor-navigation ol');
      Object.defineProperty(outline,'children',{get(){throw Error('outline scan during input');},configurable:true});
      typeText('p','Changed body'); typeText('a','Changed heading'); typeText('blank','New heading');
      delete outline.children;
      document.getElementById('title').dispatchEvent(new InputEvent('input',{bubbles:true}));
    })()`);
    expect(await browser.evaluate(`({same:stableLink===document.querySelector('.editor-navigation a'), links:[...document.querySelectorAll('.editor-navigation a')].map(a=>a.hash),
      label:stableLink.textContent,stats:initialStats===document.querySelector('.editor-navigation-stats').textContent})`)).toEqual({ same: true, links: ["#block-a", "#block-blank", "#block-z"], label: "Changed heading", stats: true });
    await browser.evaluate("(() => { typeText('blank',''); document.querySelector('.editor-navigation button').click(); typeText('a','Hidden change'); AcardEditor.state.blocks = blocks; navigation.openOutline(); })()");
    expect(await browser.evaluate("[...document.querySelectorAll('.editor-navigation li:not([hidden]) a')].map(a=>a.textContent)")).toEqual(["Hidden change", "Last"]);
  });
}, 15000);

test("spellcheck persists and reaches rebuilt and appended surfaces without input scans", async () => {
  await withBrowser(async browser => {
    await browser.evaluate("(() => { setBlocks([{id:'a',type:'paragraph',text:'One'}]); navigation.setSpellcheck(true); })()");
    expect(await browser.evaluate("[localStorage.getItem('acard-editor-spellcheck'),document.querySelector('.text').spellcheck]")).toEqual(["true", true]);
    await browser.evaluate(`(async () => {
      const applied = new Promise((resolve,reject) => {
        const timeout = setTimeout(()=>{observer.disconnect();reject(Error('spellcheck timeout'));},3000);
        const observer = new MutationObserver(()=>{
          if(document.querySelector('#block-b .text')?.spellcheck){clearTimeout(timeout);observer.disconnect();resolve();}
        }); observer.observe(document.getElementById('blocks'), {subtree:true,childList:true,attributes:true,attributeFilter:['spellcheck']});
      });
      AcardEditor.state.blocks.push({id:'b',type:'paragraph',text:'New'}); render(); await applied;
    })()`);
    expect(await browser.evaluate("[...document.querySelectorAll('.text')].every(t=>t.spellcheck)")).toBe(true);
    await browser.evaluate(`(async () => {
      const applied = new Promise((resolve,reject) => {
        const timeout=setTimeout(()=>{observer.disconnect();reject(Error('append timeout'));},3000);
        const observer=new MutationObserver(()=>{if(document.getElementById('extra')?.spellcheck){clearTimeout(timeout);observer.disconnect();resolve();}});
        observer.observe(document.getElementById('blocks'),{subtree:true,childList:true,attributes:true,attributeFilter:['spellcheck']});
      });
      const text=document.createElement('div');text.id='extra';text.className='text';text.spellcheck=false;document.getElementById('blocks').append(text);await applied;
    })()`);
    expect(await browser.evaluate("navigation.setSpellcheck(false)")).toBe(false);
    expect(await browser.evaluate("[...document.querySelectorAll('.text')].every(t=>!t.spellcheck)")).toBe(true);
    await browser.evaluate("navigation.setSpellcheck(true)");
    await browser.navigate(await browser.evaluate("location.href"));
    await browser.evaluate(`(() => { ${fixture} ${source} setBlocks([{id:'reload',type:'paragraph',text:'Reloaded'}]); })()`);
    expect(await browser.evaluate("document.querySelector('.text').spellcheck")).toBe(true);
  });
}, 15000);

for (const width of [1440, 390]) test(`outline bounds, close, mobile jump and focus layout at ${width}px`, async () => {
  await withBrowser(async browser => {
    await browser.evaluate(`(() => {
      setBlocks(Array.from({length:30},(_,i)=>({id:'h'+i,type:'heading'+(i%4+1),text:'Heading '+i+' '+ 'long'.repeat(20)})));
      selectedBlockIds=['h0','h1'];
      document.getElementById('opener').focus(); navigation.openOutline();
    })()`);
    expect(await browser.evaluate(`(() => { const panel=document.querySelector('.editor-navigation'), r=panel.getBoundingClientRect(), nav=panel.querySelector('nav');
      const stats=panel.querySelector('.editor-navigation-stats').getBoundingClientRect();
      return {bounded:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight, scrollable:nav.scrollHeight>nav.clientHeight, closeHeight:panel.querySelector('button').getBoundingClientRect().height>=44,
        statsVisible:stats.top>=nav.getBoundingClientRect().bottom&&stats.bottom<=r.bottom,
        scopes:[...panel.querySelectorAll('[data-scope]')].map(el=>el.dataset.scope)}; })()`)).toEqual({ bounded: true, scrollable: true, closeHeight: true, statsVisible: true, scopes: ['document','selection'] });
    await browser.evaluate("document.querySelector('.editor-navigation button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    expect(await browser.evaluate("[document.querySelector('.editor-navigation').hidden,document.activeElement.id]")).toEqual([true, "opener"]);
    await browser.evaluate("(() => { navigation.openOutline(); document.querySelector('.editor-navigation a').click(); })()");
    expect(await browser.evaluate("document.querySelector('.editor-navigation').hidden")).toBe(width === 390);
    expect(await browser.evaluate("location.hash")).toBe("#block-h0");
    expect(await browser.evaluate(`(() => { const before=document.getElementById('blocks').getBoundingClientRect().toJSON(); const on=navigation.toggleFocus();
      const after=document.getElementById('blocks').getBoundingClientRect().toJSON();return [on,JSON.stringify(before)===JSON.stringify(after),navigation.toggleFocus()]; })()`)).toEqual([true, true, false]);
  }, width);
}, 15000);
