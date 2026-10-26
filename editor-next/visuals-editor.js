import { visualBlockHtml, VISUAL_MAX_HEIGHT, placeHeads, htmlHeadings } from "../visual-html.js";
import { DIAGRAM_KINDS, CHART_TYPES, diagramToText, diagramFromText, chartToText, chartFromText, chartFromTable } from "./visual-forms.js";

var TEMPLATES = {
  diagram: "flowchart LR\n  A[시작] --> B{확인}\n  B -->|예| C[끝]\n  B -->|아니오| A",
  chart: '{"type":"bar","labels":["1월","2월","3월"],"series":[{"name":"값","data":[3,5,8]}]}',
  visual: '<svg viewBox="0 0 200 120"><circle cx="40" cy="60" r="16" fill="#7b68ee"><animate attributeName="cx" values="40;160;40" dur="3s" repeatCount="indefinite"/></circle></svg>',
  html: '<div id="c" style="display:flex;gap:8px;align-items:flex-end;height:140px;padding:12px"></div>\n<script>\n[3, 5, 8, 6].forEach(function (v) {\n  var b = document.createElement("div");\n  b.style.cssText = "flex:1;border-radius:6px 6px 0 0;background:#86dfe3;height:" + v * 15 + "px";\n  document.getElementById("c").appendChild(b);\n});\n</script>',
};
var HINT = {
  diagram: "Mermaid 문법: flowchart, sequenceDiagram, timeline, gantt, mindmap",
  chart: '차트 JSON: {"type":"bar|line|area|pie","labels":[...],"series":[{"name":"...","data":[숫자]}]}',
  visual: "HTML/SVG/CSS (64KB 이하). 외부 주소, 쿠키, 페이지 접근은 막혀요.",
  html: "HTML/CSS/JS (64KB 이하). 격리된 창에서 실행돼요. 외부 주소, 쿠키, 페이지 접근은 막혀요.",
};

function field(doc, label, value, onInput) {
  var wrap = doc.createElement("label"), name = doc.createElement("span"), input = doc.createElement("input");
  wrap.className = "acv-field";
  name.textContent = label;
  input.value = value || "";
  input.addEventListener("input", function () { onInput(input.value.trim()); });
  wrap.append(name, input);
  return wrap;
}

function codeMount(host, block, save, note, back) {
  var doc = host.ownerDocument, meta = block.meta || (block.meta = {});
  if (!block.text) block.text = TEMPLATES[block.type] || "";
  host.className = "acv-editor";
  host.replaceChildren();
  var source = doc.createElement("textarea"), preview = doc.createElement("div"), hint = doc.createElement("p"), timer = 0;
  source.className = "acv-source";
  source.spellcheck = false;
  source.setAttribute("aria-label", "원문");
  source.value = block.text;
  source.rows = Math.min(16, Math.max(4, block.text.split("\n").length + 1));
  hint.className = "acv-hint";
  hint.textContent = HINT[block.type] || "";
  preview.className = "acv-preview";
  preview.setAttribute("aria-live", "polite");
  // true: an HTML block's headings get anchors beside the frame for the page TOC and outline (acv-f<id>-h<n>).
  function draw() { preview.innerHTML = visualBlockHtml(block, block.id, true); }
  function changed() { block.meta = meta; save(); clearTimeout(timer); timer = setTimeout(draw, 250); }
  source.addEventListener("input", function () { block.text = source.value; changed(); });
  source.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
  var fields = doc.createElement("div");
  fields.className = "acv-fields";
  fields.append(
    field(doc, "캡션", meta.caption, function (v) { if (v) meta.caption = v; else delete meta.caption; changed(); }),
    field(doc, "대체 글", meta.alt, function (v) { if (v) meta.alt = v; else delete meta.alt; changed(); })
  );
  fields.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
  var grid = doc.createElement("div");
  grid.className = "acv-grid";
  var left = doc.createElement("div");
  var srcHead = doc.createElement("div"), prevHead = doc.createElement("div"), right = doc.createElement("div");
  srcHead.className = prevHead.className = "acv-head";
  srcHead.textContent = "소스 코드"; prevHead.textContent = "미리보기";
  if (back) { var toForm = doc.createElement("button"); toForm.type = "button"; toForm.className = "acv-link"; toForm.textContent = "양식으로 보기"; toForm.addEventListener("click", back); srcHead.appendChild(toForm); }
  if (note) { var warn = doc.createElement("p"); warn.className = "acv-note"; warn.textContent = note; host.appendChild(warn); }
  left.append(srcHead, source, hint, fields);
  right.append(prevHead, preview);
  grid.append(left, right);
  host.append(grid);
  draw();
}


function el(doc, tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function stop(node) { node.addEventListener("keydown", function (ev) { ev.stopPropagation(); }); return node; }

function formShell(host, title, sub) {
  var doc = host.ownerDocument;
  host.className = "acv-editor acv-form";
  host.replaceChildren();
  var head = el(doc, "div", "acv-formhead");
  head.append(el(doc, "strong", null, title), el(doc, "span", null, sub));
  host.appendChild(head);
  return doc;
}

function diagramForm(host, block, save) {
  var parsed = diagramFromText(block.text);
  if (!parsed) return codeMount(host, block, save, "이 그림은 코드로만 고칠 수 있어요.", null);
  var doc = formShell(host, "다이어그램", "글로 쓰면 그림이 바로 만들어져요.");
  var state = { kind: parsed.kind, input: parsed.input || (block.text ? "" : DIAGRAM_KINDS[0].sample) };
  if (!block.text) { block.text = diagramToText(state.kind, state.input); save(); }
  var tabs = el(doc, "div", "acv-tabs"), grid = el(doc, "div", "acv-grid"), left = el(doc, "div"), right = el(doc, "div");
  tabs.setAttribute("role", "tablist");
  var label = el(doc, "div", "acv-head", "내용"), area = stop(el(doc, "textarea", "acv-lines")), help = el(doc, "p", "acv-hint");
  area.setAttribute("aria-label", "다이어그램 내용");
  area.spellcheck = false;
  var prevHead = el(doc, "div", "acv-head", "미리보기"), code = el(doc, "button", "acv-link", "코드 보기"), preview = el(doc, "div", "acv-preview");
  code.type = "button";
  code.addEventListener("click", function () { codeMount(host, block, save, null, function () { diagramForm(host, block, save); }); });
  prevHead.appendChild(code);
  function draw() { preview.innerHTML = visualBlockHtml(block, block.id); }
  function paintTabs() {
    tabs.replaceChildren();
    DIAGRAM_KINDS.forEach(function (k) {
      var b = el(doc, "button", "acv-tab" + (k.kind === state.kind ? " on" : ""), k.label);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(k.kind === state.kind));
      b.addEventListener("click", function () {
        var prevSample = DIAGRAM_KINDS.filter(function (x) { return x.kind === state.kind; })[0].sample;
        state.kind = k.kind;
        if (!area.value.trim() || area.value === prevSample) area.value = k.sample;
        update(); paintTabs();
      });
      tabs.appendChild(b);
    });
    help.textContent = DIAGRAM_KINDS.filter(function (x) { return x.kind === state.kind; })[0].help;
  }
  var timer = 0;
  function update() { state.input = area.value; block.text = diagramToText(state.kind, state.input); save(); clearTimeout(timer); timer = setTimeout(draw, 120); }
  area.value = state.input;
  area.rows = Math.min(14, Math.max(6, area.value.split("\n").length + 1));
  area.addEventListener("input", update);
  left.append(label, area, help);
  right.append(prevHead, preview);
  grid.append(left, right);
  host.append(tabs, grid);
  paintTabs(); draw();
}

function chartForm(host, block, save, seed) {
  var spec = seed || chartFromText(block.text);
  if (!spec) return codeMount(host, block, save, "이 차트는 코드로만 고칠 수 있어요.", null);
  var doc = formShell(host, "차트", "종류를 고르고 표에 숫자를 넣으세요.");
  var meta = block.meta || (block.meta = {});
  function commit() { block.text = chartToText(spec); block.meta = meta; save(); clearTimeout(t); t = setTimeout(draw, 120); }
  var t = 0;
  if (!block.text || seed) commit();
  var grid = el(doc, "div", "acv-grid"), left = el(doc, "div"), right = el(doc, "div");
  var types = el(doc, "div", "acv-tabs");
  CHART_TYPES.forEach(function (pair) {
    var b = el(doc, "button", "acv-tab" + (spec.type === pair[0] ? " on" : ""), pair[1]);
    b.type = "button";
    b.addEventListener("click", function () { spec.type = pair[0]; types.querySelectorAll(".acv-tab").forEach(function (x) { x.classList.toggle("on", x === b); }); commit(); });
    types.appendChild(b);
  });
  var title = stop(el(doc, "input", "acv-title")); title.placeholder = "차트 제목"; title.value = spec.title || ""; title.setAttribute("aria-label", "차트 제목");
  title.addEventListener("input", function () { spec.title = title.value.trim(); if (!spec.title) delete spec.title; commit(); });
  var table = el(doc, "table", "acv-data");
  function paintTable() {
    table.replaceChildren();
    var hr = el(doc, "tr");
    hr.appendChild(el(doc, "th", null, "항목"));
    spec.series.forEach(function (s, si) {
      var th = el(doc, "th"), inp = stop(el(doc, "input")); inp.value = s.name; inp.setAttribute("aria-label", (si + 1) + "번째 계열 이름");
      inp.addEventListener("input", function () { s.name = inp.value; commit(); });
      th.appendChild(inp); hr.appendChild(th);
    });
    table.appendChild(hr);
    spec.labels.forEach(function (lab, ri) {
      var tr = el(doc, "tr"), td = el(doc, "td"), inp = stop(el(doc, "input")); inp.value = lab; inp.setAttribute("aria-label", (ri + 1) + "번째 항목");
      inp.addEventListener("input", function () { spec.labels[ri] = inp.value; commit(); });
      td.appendChild(inp); tr.appendChild(td);
      spec.series.forEach(function (s) {
        var c = el(doc, "td"), v = stop(el(doc, "input")); v.inputMode = "decimal"; v.value = s.data[ri] == null ? "" : String(s.data[ri]);
        v.addEventListener("input", function () { var n = Number(v.value.replace(/,/g, "")); s.data[ri] = v.value.trim() === "" || !isFinite(n) ? null : n; commit(); });
        c.appendChild(v); tr.appendChild(c);
      });
      var del = el(doc, "button", "acv-x", "✕"); del.type = "button"; del.setAttribute("aria-label", (ri + 1) + "번째 항목 지우기");
      del.addEventListener("click", function () { if (spec.labels.length < 2) return; spec.labels.splice(ri, 1); spec.series.forEach(function (s) { s.data.splice(ri, 1); }); paintTable(); commit(); });
      var dc = el(doc, "td"); dc.appendChild(del); tr.appendChild(dc);
      table.appendChild(tr);
    });
  }
  var tools = el(doc, "div", "acv-tools");
  var addRow = el(doc, "button", "acv-pill", "+ 항목"); addRow.type = "button";
  addRow.addEventListener("click", function () { spec.labels.push("항목" + (spec.labels.length + 1)); spec.series.forEach(function (s) { s.data.push(null); }); paintTable(); commit(); });
  var addSeries = el(doc, "button", "acv-pill", "+ 계열"); addSeries.type = "button";
  addSeries.addEventListener("click", function () { if (spec.series.length >= 4) return; spec.series.push({ name: "값" + (spec.series.length + 1), data: spec.labels.map(function () { return null; }) }); paintTable(); commit(); });
  var fromTable = el(doc, "button", "acv-pill", "▤ 위 표로 채우기"); fromTable.type = "button";
  fromTable.addEventListener("click", function () {
    var editor = window.AcardEditor, blocks = editor.state.blocks, at = blocks.findIndex(function (b) { return b.id === block.id; });
    for (var i = at - 1; i >= 0; i -= 1) if (blocks[i].type === "table" && blocks[i].meta) {
      var next = chartFromTable(blocks[i].meta, spec.title); if (next) { next.type = spec.type; return chartForm(host, block, save, next); }
    }
    fromTable.textContent = "위에 숫자 표가 없어요";
  });
  tools.append(addRow, addSeries, fromTable);
  var prevHead = el(doc, "div", "acv-head", "미리보기"), code = el(doc, "button", "acv-link", "코드 보기"), preview = el(doc, "div", "acv-preview");
  code.type = "button";
  code.addEventListener("click", function () { codeMount(host, block, save, null, function () { chartForm(host, block, save); }); });
  prevHead.appendChild(code);
  function draw() { preview.innerHTML = visualBlockHtml(block, block.id); }
  left.append(types, title, table, tools);
  right.append(prevHead, preview);
  grid.append(left, right);
  host.appendChild(grid);
  paintTable(); draw();
}

function mount(host, block, save) {
  if (block.type === "diagram") return diagramForm(host, block, save);
  if (block.type === "chart") return chartForm(host, block, save);
  return codeMount(host, block, save);
}

// The preview's frame arrives through innerHTML, so the resize script beside it never runs: size HTML/visual frames here (#43).
addEventListener("message", function (e) {
  var h = e.data && +e.data.acvH;
  if (!(h > 0)) return;
  document.querySelectorAll(".acv-preview iframe.acv-frame:not(.acp-frame)").forEach(function (f) { if (f.contentWindow === e.source) { f.style.height = Math.min(VISUAL_MAX_HEIGHT, h) + "px"; placeHeads(f, e.data.acvT); } });
});

if (window.AcardEditor) window.AcardEditor.provide("visuals", { mount: mount, html: visualBlockHtml });
// The editor's TOC blocks and outline list blocks through this: each HTML block becomes its headings, as heading
// entries (h1 -> heading1, h4-h6 -> heading4) whose "block-" + id is the anchor beside the preview frame and whose
// block is the HTML block. Then the TOCs drawn before this chunk loaded are repainted.
window.AcardHtmlHeadings = function (blocks) {
  var out = [];
  blocks.forEach(function (b) {
    if (b.type !== "html") return out.push(b);
    htmlHeadings(b.text).forEach(function (h, i) { out.push({ id: b.id + "-h" + i, type: "heading" + Math.min(4, h.level), text: h.text, block: b.id }); });
  });
  return out;
};
if (window.AcardEditor && window.AcardEditor.paintTocs) window.AcardEditor.paintTocs();
