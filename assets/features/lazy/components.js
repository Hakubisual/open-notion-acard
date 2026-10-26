// Editor side of the ds10 component registry: the same component-registry.js + components/*.js the reader uses
// (inlined at build time), a JSON data box with a live preview, and the slash entries for every registered component.
// Visual kit: this chunk carries the registry and the basic family; every other family (chart, diagram, ...) is its own
// lazy chunk components-<family>, loaded when one of its blocks is shown or inserted. COMPONENT_MANIFEST lists those
// components (id, name, family, slash) so the slash menu shows them before their chunk is loaded.
(function () {
  "use strict";
//__COMPONENT_SOURCE__
  var editor = window.AcardEditor;
  var manifest = [];
  // Every non-basic component (id, name, family, slash, chunk, core) comes from the small components-index chunk.
  var ready = editor ? editor.lazy("components-index").then(function (index) { manifest = (index && index.list) || []; }, function () {}) : Promise.resolve();
  var style = document.createElement("style");
  function paint() { style.textContent = componentCss(); }
  var chunks = Object.create(null);
  function entryOf(id) {
    for (var i = 0; i < manifest.length; i += 1) if (manifest[i].id === id) return manifest[i];
    return null;
  }
  function familyOf(id) {
    var c = getComponent(id), m = entryOf(id);
    return c ? c.family : m ? m.family : "basic";
  }
  function load(name) {
    return chunks[name] || (chunks[name] = editor.lazy(name).catch(function () { delete chunks[name]; }));
  }
  // Resolves once the component's chunk (after its family core) has registered; basic and unknown ids resolve at once.
  function ensure(id) {
    return ready.then(function () { return ensureNow(id); });
  }
  function ensureNow(id) {
    var m = entryOf(id);
    if (getComponent(id) || !m || !editor) return Promise.resolve(getComponent(id));
    return (m.core ? load(m.core) : Promise.resolve()).then(function () { return load(m.chunk); }).then(function () { return getComponent(id); });
  }
  // What the reader knows around a block (footnote numbers from the page's [^id] marks, the heading right above), so the
  // editor preview numbers notes and hides a repeated title the way the page will.
  function pageOf(block) {
    var list = (editor && editor.state && editor.state.blocks) || [];
    var i = list.indexOf(block), prev = i > 0 ? list[i - 1] : null;
    return { footnotes: footnoteOrder(list), heading: prev && /^heading[1-4]$/.test(prev.type) && (prev.indent || 0) === (block.indent || 0) ? String(prev.text || "") : "" };
  }
  window.AcardComponents = { pageOf: pageOf, registerComponent: registerComponent, registerHelpers: registerHelpers, registerFamilyCss: registerFamilyCss, UI_TONES: UI_TONES, getComponent: getComponent, listComponents: listComponents, componentCatalog: componentCatalog, componentMarkdown: componentMarkdown, componentData: componentData, renderComponentBlock: renderComponentBlock, fallbackCardHtml: fallbackCardHtml, componentCss: componentCss, ensure: ensure, familyLoaded: paint };
  paint();
  document.head.appendChild(style);

  var GROUPS = { basic: "컴포넌트", chart: "그래프", diagram: "다이어그램", interactive: "인터랙션", block: "꾸밈 블록", asset: "그림" };
  function slashItems() {
    var seen = Object.create(null);
    return listComponents().concat(manifest).filter(function (c) { if (seen[c.id]) return false; seen[c.id] = 1; return true; }).map(function (c) {
      var s = c.slash || {};
      return { type: "component:" + c.id, label: s.label || c.name, hint: s.hint || "", ico: s.ico || "▦", aliases: [s.aliases, c.id, c.name].filter(Boolean).join(" "), group: "컴포넌트", family: c.family || "basic", familyLabel: GROUPS[c.family] || GROUPS.basic };
    });
  }

  // The block keeps the person's JSON exactly as typed; only the preview falls back to defaults.
  function mount(host, block, save) {
    var id = String((block.meta && block.meta.ui) || "");
    if (!getComponent(id)) {
      host.className = "ui-editor";
      host.textContent = "불러오는 중…";
      ensure(id).then(function () { mountNow(host, block, save); });
      return;
    }
    mountNow(host, block, save);
  }
  function mountNow(host, block, save) {
    var comp = getComponent(String((block.meta && block.meta.ui) || ""));
    if (!block.text && comp) { block.text = JSON.stringify(comp.sample, null, 2); save(); }
    if (!comp || comp.family === "basic" || !editor) return mountJson(host, block, save, comp);
    editor.lazy("component-panel").then(function (panel) { panel.mount(host, block, save, comp, mountJson); }, function () { mountJson(host, block, save, comp); });
  }
  function mountJson(host, block, save, comp) {
    var doc = host.ownerDocument;
    host.className = "ui-editor";
    host.replaceChildren();
    var preview = doc.createElement("div");
    preview.className = "ui-editor-preview";
    var tools = doc.createElement("details");
    tools.className = "ui-editor-data";
    var summary = doc.createElement("summary");
    summary.textContent = (comp ? comp.name : "컴포넌트") + " 데이터 고치기";
    var area = doc.createElement("textarea");
    area.className = "ui-editor-source";
    area.spellcheck = false;
    area.setAttribute("aria-label", "컴포넌트 데이터(JSON)");
    area.value = block.text;
    area.rows = Math.min(14, Math.max(4, block.text.split("\n").length + 1));
    var hint = doc.createElement("p");
    hint.className = "ui-editor-hint";
    var timer = 0;
    function draw() {
      preview.innerHTML = renderComponentBlock(block, pageOf(block));
      var bad = preview.querySelector("[data-ui-invalid]");
      hint.textContent = !comp ? "모르는 컴포넌트예요. 이름(ui)을 확인해 주세요." : bad ? "JSON 형식이 맞지 않아 기본값으로 보여 주고 있어요." : "값을 고치면 바로 다시 그려져요.";
    }
    area.addEventListener("input", function () { block.text = area.value; save(); clearTimeout(timer); timer = setTimeout(draw, 200); });
    area.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
    tools.append(summary, area, hint);
    host.append(preview, tools);
    draw();
  }

  if (editor) editor.provide("components", { mount: mount, slashItems: slashItems, getComponent: getComponent, ensure: ensure, ready: ready });
})();
