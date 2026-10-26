import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// paintTocs() walks every block and stringifies the heading list; it must run only when the page has a TOC
// block, and typing in a non-heading block must not trigger it (the TOC lists headings only).
const editorSource = readFileSync(new URL("../assets/editor.js", import.meta.url), "utf8");
function section(start: string, end: string) {
  const from = editorSource.indexOf(start), to = editorSource.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("Missing editor section");
  return editorSource.slice(from, to);
}

function scheduler() {
  const state: any = { title: "T", blocks: [{ id: "h", type: "heading1", text: "A" }, { id: "p", type: "paragraph", text: "" }], dirty: false, baseUpdated: 10 };
  const context: any = { state, paints: 0, paintTocs() { context.paints++; }, emitFeature() {}, setSave() {}, save: async () => {},
    setTimeout: () => 1, clearTimeout() {}, JSON, Number, Promise, subpagesOf: () => [], syncSubpages() {}, render() {} };
  // The vm keeps script-declared vars apart from the sandbox object, so hasToc lives on the context instead.
  context.hasToc = false;
  runInNewContext(section("  var saveTimer =", "  function save()").replace("var hasToc = false;", ""), context);
  return context;
}

test("typing repaints the TOC only for a heading, and never on a page without a TOC block", () => {
  const c = scheduler();
  c.hasToc = true;
  c.scheduleSave(c.state.blocks[1]);
  expect(c.paints).toBe(0);
  c.scheduleSave(c.state.blocks[0]);
  expect(c.paints).toBe(1);
  c.scheduleSave();
  expect(c.paints).toBe(2);
  c.hasToc = false;
  c.scheduleSave(c.state.blocks[0]);
  c.scheduleSave();
  expect(c.paints).toBe(2);
});

test("render records whether the page has a TOC block", () => {
  const node = () => ({ className: "", style: { setProperty() {} }, appendChild() {}, querySelector: () => node(), innerHTML: "", value: "" });
  const context: any = { state: { title: "T", blocks: [] }, transaction: null, els: { title: node(), blocks: node() }, document: { activeElement: null, createElement: node },
    structure: (blocks: any[]) => blocks, blockEl: () => node(), model: { depth: () => 0 }, columnTemplate: () => "", mountLinkedDatabases() {} };
  context.hasToc = false;
  runInNewContext(section("  function render()", "  function blockEl("), context);
  context.render();
  expect(context.hasToc).toBe(false);
  context.state.blocks = [{ id: "p", type: "paragraph", text: "" }, { id: "t", type: "toc", text: "" }];
  context.render();
  expect(context.hasToc).toBe(true);
});
