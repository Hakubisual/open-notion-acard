import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pages = readFileSync(new URL("../assets/editor-pages-ui.js", import.meta.url), "utf8");
const next = readFileSync(new URL("../editor-next/editor-next.js", import.meta.url), "utf8");
const attachments = next.slice(next.indexOf("  function mountAttachments()"), next.indexOf("  // --- Tables:"));

for (const mode of ["classic", "next"]) test(mode + ": only three header chips, with working page actions in More", async () => {
  const browser = new Bun.WebView({ width: 390, height: 844 });
  try {
    await browser.navigate("about:blank");
    await browser.evaluate(`(async () => {
      document.body.innerHTML = '<button id="more" aria-expanded="true"></button><div id="more-menu"></div><aside><div class="navhead"></div></aside><main id="doc"><div id="page-tools"></div><div class="docbar"></div></main>';
      window.calls = []; window.saves = 0; window.trees = 0; window.templates = 0; window.settings = {};
      window.api = async (path, options = {}) => {
        calls.push([path, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
        if (path.endsWith('/settings')) { if (options.body) Object.assign(settings, JSON.parse(options.body)); return {settings}; }
        if (path.endsWith('/history')) return {versions:[]};
        if (path.endsWith('/attachments')) return {attachments:[{url:'/media/file',name:'file.txt',mime:'text/plain',bytes:1024}]};
        throw Error('Unexpected request: ' + path);
      };
      window.AcardEditor = {api,slug:'a page',setSave(message,bad){if(bad)throw Error(message);},openTemplatePicker(){templates++;},lazy(){throw Error('Unexpected lazy load');}};
      ${pages}
      await mountEditorPages({api,slug:'a page',state:{title:'A title'},save:async()=>{saves++;},loadTree:async()=>{trees++;},setSave:AcardEditor.setSave});
      const editor = AcardEditor;
      ${attachments}
      ${mode === "next" ? "mountAttachments(); mountAttachments();" : ""}
      window.clickAction = async text => {
        const button = [...document.querySelectorAll('#more-menu button')].find(b=>b.textContent === text);
        if (!button) throw Error('Missing menu action ' + text);
        document.getElementById('more-menu').hidden = false;
        document.getElementById('more').setAttribute('aria-expanded','true');
        const done = new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{observer.disconnect();reject(Error('action timeout'));},3000);
          const observer=new MutationObserver(()=>{if(document.querySelector('dialog[open]') || settings.favorite){clearTimeout(timer);observer.disconnect();resolve();}});
          observer.observe(document.body,{subtree:true,childList:true,attributes:true});
        });
        button.click(); await done;
      };
    })()`);
    expect(await browser.evaluate("document.querySelectorAll('#page-tools > button').length")).toBe(3);
    expect(await browser.evaluate("document.querySelectorAll('#more-menu > button').length")).toBe(mode === "next" ? 4 : 3);
    await browser.evaluate("clickAction('즐겨찾기')");
    expect(await browser.evaluate("({settings,trees,closed:document.getElementById('more-menu').hidden,expanded:document.getElementById('more').getAttribute('aria-expanded')})")).toEqual({ settings: { favorite: true }, trees: 1, closed: true, expanded: "false" });
    await browser.evaluate("(() => { settings.favorite = false; return clickAction('페이지 기록'); })()");
    expect(await browser.evaluate("({saves,history:calls.filter(c=>c[0].endsWith('/history')).length,open:!!document.querySelector('dialog[open]')})")).toEqual({ saves: 1, history: 1, open: true });
    await browser.evaluate("(() => { document.querySelector('dialog[open]').close(); [...document.querySelectorAll('#more-menu button')].find(b=>b.textContent === '템플릿 사용').click(); })()");
    expect(await browser.evaluate("templates")).toBe(1);
    if (mode === "next") {
      await browser.evaluate("clickAction('첨부')");
      expect(await browser.evaluate("({requests:calls.filter(c=>c[0].endsWith('/attachments')).length,links:[...document.querySelectorAll('.att-panel a')].map(a=>a.getAttribute('href')),closed:document.getElementById('more-menu').hidden})")).toEqual({ requests: 1, links: ["/media/file"], closed: true });
    }
  } finally { await browser.close(); }
}, 15000);
