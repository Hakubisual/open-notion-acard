import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Clipboard HTML in the shape each app writes (research C04-C09). The fixtures follow each app's documented clipboard
// format; they are not captured from the live apps.
const ROOT = join(import.meta.dir, "..");
const model = readFileSync(join(ROOT, "assets/editor-model.js"), "utf8");
const chunk = readFileSync(join(ROOT, "assets/features/lazy/editor-next.js"), "utf8");
const fixture = (name: string) => readFileSync(join(ROOT, "tests/fixtures/paste", name + ".html"), "utf8");

let browser: InstanceType<typeof Bun.WebView>;
beforeAll(async () => { browser = new Bun.WebView(); await browser.navigate("about:blank"); });
afterAll(async () => { await browser.close(); });

type Pasted = { blocks: { type: string; text: string; indent: number; checked: boolean; links: string[] }[]; pwned: number };

async function paste(html: string, plain: string): Promise<Pasted> {
  return (await browser.evaluate(`(async () => {
    delete window.__pwned;
    document.body.innerHTML = '<div id="blocks"></div>';
    ${model}
    const els = { blocks: document.getElementById('blocks') };
    const state = { blocks: [{ id: 'b1', type: 'paragraph', text: '', checked: false, indent: 0, meta: null }], pages: [] };
    let n = 0;
    const apis = {};
    const render = () => { els.blocks.innerHTML = state.blocks.map(b => '<div class="blk" data-id="' + b.id + '"><div class="text" contenteditable="true"></div></div>').join(''); };
    window.AcardEditorNext = { on: true };
    window.AcardEditor = {
      provide: (name, api) => { apis[name] = api; }, on() { return () => {}; }, get state() { return state; }, slug: 'p', render, scheduleSave() {}, setSave() {},
      api: () => Promise.reject(Error('offline')), transport: () => Promise.reject(Error('offline')), lazy: () => Promise.reject(Error('not needed')),
      insertBlocksAfter(id, blocks) { const at = state.blocks.findIndex(b => b.id === id); const added = blocks.map(b => Object.assign({ id: 'n' + (++n), type: 'paragraph', text: '', checked: false, indent: 0, meta: null }, b)); state.blocks.splice(at + 1, 0, ...added); render(); return added.map(b => b.id); },
    };
    render();
    new Function(${JSON.stringify(chunk)})();
    apis['editor-next'].start();
    const text = els.blocks.querySelector('.text');
    text.addEventListener('input', () => {
      const block = state.blocks.find(b => b.id === 'b1'), rich = EditorModel.readRich(text);
      block.text = rich.map(r => r.text).join(''); block.meta = { richText: rich };
    });
    text.focus();
    getSelection().setBaseAndExtent(text, 0, text, 0);
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(plain)});
    dt.setData('text/html', ${JSON.stringify(html)});
    text.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return {
      blocks: state.blocks.filter(b => b.text || b.type !== 'paragraph').map(b => ({ type: b.type, text: b.text, indent: b.indent || 0, checked: !!b.checked,
        links: ((b.meta && b.meta.richText) || []).filter(r => r.href).map(r => r.href) })),
      pwned: window.__pwned || 0,
    };
  })()`)) as Pasted;
}

const shape = (out: Pasted) => out.blocks.map((b) => [b.type, b.text, b.indent]);

test("captured MDN inline clipboard preserves one paragraph, spaces and links", async () => {
  const receipt = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/paste/web-mdn-captured.json"), "utf8"));
  const out = await paste(fixture("web-mdn-captured"), receipt.plain);
  expect(shape(out)).toEqual([["paragraph", receipt.plain, 0]]);
  expect(out.blocks[0].links).toContain("https://developer.mozilla.org/en-US/docs/Web/HTML");
  expect(out.blocks[0].links).toContain("https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/cite");
});

test("Google Docs: a list nested beside its parent item keeps every item at its level", async () => {
  const out = await paste(fixture("google-docs"), "Meeting notes\nBudget review\nQ3 numbers\nHiring");
  expect(shape(out)).toEqual([
    ["heading2", "Meeting notes", 0],
    ["paragraph", "Agenda with bold and a link.", 0],
    ["bulleted", "Budget review", 0],
    ["bulleted", "Q3 numbers", 1],
    ["bulleted", "Hiring", 0],
    ["paragraph", "Next steps.", 0],
  ]);
  expect(out.blocks[1].links).toEqual(["https://example.com/doc"]);
});

test("Word: list paragraphs become bulleted and numbered items at their level, without the bullet characters", async () => {
  const out = await paste(fixture("word-list"), "Quarterly plan");
  expect(shape(out)).toEqual([
    ["heading1", "Quarterly plan", 0],
    ["paragraph", "Intro with bold and italic text.", 0],
    ["bulleted", "First goal", 0],
    ["bulleted", "Nested detail", 1],
    ["bulleted", "Second goal", 0],
    ["numbered", "Step one", 0],
    ["numbered", "Step two", 0],
    ["paragraph", "Closing line.", 0],
  ]);
});

test("Notion: nested bullets, to-dos with their state, quote, callout and code keep their structure", async () => {
  const out = await paste(fixture("notion"), "Project brief");
  expect(shape(out)).toEqual([
    ["heading2", "Project brief", 0],
    ["paragraph", "Owner: Kim, see the spec.", 0],
    ["bulleted", "Scope", 0],
    ["bulleted", "Editor parity", 1],
    ["bulleted", "Timeline", 0],
    ["to_do", "Write tests", 0],
    ["to_do", "Ship", 0],
    ["quote", "Keep it simple.", 0],
    ["callout", "Remember the deadline.", 0],
    ["code", "const x = 1;", 0],
  ]);
  expect(out.blocks.filter((b) => b.type === "to_do").map((b) => b.checked)).toEqual([true, false]);
});

test("a web page: scripts, handlers, script links and frames are dropped; text, safe links and https images stay", async () => {
  const out = await paste(fixture("web-unsafe"), "News headline");
  expect(out.pwned).toBe(0);
  expect(shape(out)).toEqual([
    ["heading3", "News headline", 0],
    ["paragraph", "Body text with bad link and good link.", 0],
    ["image", "Chart", 0],
    ["paragraph", "Last paragraph.", 0],
  ]);
  expect(out.blocks[1].links).toEqual(["https://example.org/ok"]);
  expect(JSON.stringify(out.blocks)).not.toMatch(/javascript:|evil\.example/);
});
