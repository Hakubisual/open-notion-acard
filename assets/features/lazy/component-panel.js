// Visual kit settings panel (lazy, editor only): preview + chips for preset / palette + the schema form from part-form.
(function () {
  "use strict";
  var editor = window.AcardEditor, C = window.AcardComponents;
  if (!editor || !C) return;
  var getComponent = C.getComponent, renderComponentBlock = C.renderComponentBlock;
  // Settings panel: the same schema form the parts use (lazy part-form: fields, label x series grid, JSON toggle) plus a
  // row of chips for the kit's common choices (preset, palette, figure numbering). The JSON box stays the fallback.
  var PRESET_LABELS = { "": "기본", report: "보고서", friendly: "블로그", paper: "논문", showcase: "포트폴리오" };
  var FIELD_LABELS = { title: "제목", subtitle: "설명", caption: "아래 메모", source: "출처", unit: "단위", figure: "그림 번호", stacked: "쌓기", xTitle: "가로축 이름", yTitle: "세로축 이름", colorBy: "색 나누기", area: "면 채우기", highlight: "강조할 항목", center: "가운데 글자", centerLabel: "가운데 설명", hole: "구멍 크기", label: "이름", value: "값", delta: "변화", note: "메모", trend: "추세", values: "값 목록", kind: "모양", sort: "정렬", items: "항목", points: "점", groups: "그룹", stages: "단계", steps: "단계", tasks: "할 일", rows: "행", cols: "열", min: "최소", max: "최대", target: "목표", bins: "구간 수", trendline: "추세선", children: "하위", start: "시작", end: "끝", group: "그룹", done: "끝남", x: "가로 값", y: "세로 값", r: "크기", compact: "촘촘하게" };
  var PALETTE_LABELS = { acard: "아카드", colorblind: "색약 안전", mono: "흑백" };
  function validate(schema, data, path) {
    var errors = [];
    function typeOf(v) { return v === null ? "null" : Array.isArray(v) ? "array" : typeof v; }
    function walk(sc, v, p) {
      if (!sc || typeof sc !== "object" || errors.length >= 20) return;
      var t = typeOf(v);
      if (sc.type) {
        var types = Array.isArray(sc.type) ? sc.type : [sc.type];
        if (!types.some(function (x) { return x === t || (x === "integer" && t === "number" && Number.isInteger(v)); })) { errors.push(p + ": " + types.join("|") + " 이어야 해요"); return; }
      }
      if (Array.isArray(sc.enum) && sc.enum.indexOf(v) < 0) { errors.push(p + ": " + sc.enum.join(", ") + " 중 하나여야 해요"); return; }
      if (t === "array" && sc.items) v.forEach(function (item, i) { walk(sc.items, item, p + "[" + i + "]"); });
      if (t === "object") {
        (sc.required || []).forEach(function (k) { if (!(k in v)) errors.push(p + "." + k + ": 꼭 있어야 해요"); });
        Object.keys(sc.properties || {}).forEach(function (k) { if (k in v) walk(sc.properties[k], v[k], p + "." + k); });
      }
    }
    walk(schema, data, path || "data");
    return errors;
  }
  function parse(text) { try { var v = JSON.parse(String(text || "")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (e) { return null; } }
  function chips(doc, comp, block, save, redraw) {
    var wrap = doc.createElement("div");
    wrap.className = "ui-kit-chips";
    function group(label, key, options) {
      var g = doc.createElement("div");
      g.className = "ui-kit-group";
      g.setAttribute("role", "radiogroup");
      g.setAttribute("aria-label", label);
      var cap = doc.createElement("span");
      cap.className = "ui-kit-cap";
      cap.textContent = label;
      g.appendChild(cap);
      Object.keys(options).forEach(function (value) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "ui-kit-chip";
        b.textContent = options[value];
        b.setAttribute("role", "radio");
        function sync() { var d = parse(block.text) || {}; b.setAttribute("aria-checked", String((d[key] || "") === value)); }
        sync();
        b.addEventListener("click", function () {
          var d = parse(block.text) || {};
          if (value) d[key] = value; else delete d[key];
          block.text = JSON.stringify(d, null, 2);
          save();
          wrap.querySelectorAll(".ui-kit-chip").forEach(function (x) { x.dispatchEvent(new Event("sync")); });
          redraw();
        });
        b.addEventListener("sync", sync);
        g.appendChild(b);
      });
      wrap.appendChild(g);
    }
    var props = (comp.schema && comp.schema.properties) || {};
    if (Object.keys(comp.presets || {}).length) group("용도", "preset", PRESET_LABELS);
    if (props.palette || comp.family === "chart") group("색", "palette", PALETTE_LABELS);
    return wrap;
  }

  function mount(host, block, save, comp, mountJson) {
    var doc = host.ownerDocument;
    host.className = "ui-editor ui-kit-editor";
    host.replaceChildren();
    var preview = doc.createElement("div");
    preview.className = "ui-editor-preview";
    var panel = doc.createElement("details");
    panel.className = "ui-editor-data ui-kit-panel";
    var summary = doc.createElement("summary");
    summary.textContent = comp.name + " 설정";
    var form = doc.createElement("div");
    function draw() { preview.innerHTML = renderComponentBlock(block, C.pageOf ? C.pageOf(block) : null); }
    panel.append(summary, chips(doc, comp, block, save, function () { draw(); form.dispatchEvent(new Event("reload")); }), form);
    host.append(preview, panel);
    draw();
    var props = Object.assign({}, (comp.schema && comp.schema.properties) || {});
    ["preset", "palette", "height"].forEach(function (k) { delete props[k]; });
    var schema = Object.assign({}, comp.schema, { properties: props });
    function mountForm() {
      editor.lazy("part-form").then(function (pf) {
        pf.mount(form, { block: block, schema: schema, name: comp.name, kind: "설정 ·", labels: FIELD_LABELS, hint: "값을 바꾸면 위 그림이 바로 다시 그려져요", parse: parse, validate: validate, save: save, preview: function () { draw(); } });
      }, function () { mountJson(form, block, save, comp); });
    }
    form.addEventListener("reload", mountForm);
    panel.addEventListener("toggle", function once() { if (panel.open) { panel.removeEventListener("toggle", once); mountForm(); } });
  }
  editor.provide("component-panel", { mount: mount });
})();
