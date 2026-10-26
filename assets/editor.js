(function () {
  "use strict";
  // Network seam (open-notion-acard #1): a host page can set window.AcardEditorProvider = { fetch(url, options) } before
  // this script loads to route the editor's requests elsewhere. Without it every call is the browser fetch to /api.
  function net(url, options) {
    var provider = window.AcardEditorProvider;
    return provider && typeof provider.fetch === "function" ? provider.fetch(url, options) : fetch(url, options);
  }
  var model = window.EditorModel;
  var coreEditing = document.documentElement.getAttribute("data-core-editing") === "on" || /[?&]core-editing=on(?:&|$)/.test(location.search);
  function loadEditing() { return Promise.all([lazy("block-commands"), lazy("editor-selection")]); }
  function runBlockCommand(name, args) {
    var before = snapshot();
    return loadEditing().then(function (apis) {
      return apis[0].run(name, args, before);
    }).catch(featureError);
  }
  var pageContext;
  var formatContext;
  var selectedIds = new Set();

  var BLOCK_TYPES = [
    { type: "paragraph", label: "글", hint: "그냥 문장", ico: "¶" },
    { type: "heading1", label: "제목 1", hint: "큰 제목", ico: "H1" },
    { type: "heading2", label: "제목 2", hint: "중간 제목", ico: "H2" },
    { type: "heading3", label: "제목 3", hint: "작은 제목", ico: "H3" },
    { type: "heading4", label: "제목 4", hint: "가장 작은 제목", ico: "H4" },
    { type: "bulleted", label: "글머리 목록", hint: "• 항목", ico: "•" },
    { type: "numbered", label: "번호 목록", hint: "1. 항목", ico: "1." },
    { type: "to_do", label: "할 일", hint: "체크박스", ico: "☑" },
    { type: "toggle", label: "토글", hint: "접었다 펴는 목록", ico: "▸" },
    { type: "toggle_heading1", label: "토글 제목 1", hint: "접히는 큰 제목", ico: "▸H1" },
    { type: "toggle_heading2", label: "토글 제목 2", hint: "접히는 중간 제목", ico: "▸H2" },
    { type: "toggle_heading3", label: "토글 제목 3", hint: "접히는 작은 제목", ico: "▸H3" },
    { type: "callout", label: "콜아웃", hint: "강조 상자", ico: "!" },
    { type: "quote", label: "인용", hint: "인용문", ico: "❝" },
    { type: "code", label: "코드", hint: "코드 블록", ico: "{}" },
    { type: "diagram", label: "다이어그램", hint: "흐름·순서 그림", ico: "◇" },
    { type: "chart", label: "차트", hint: "숫자 그래프", ico: "▥" },
    { type: "visual", label: "시각 자료", hint: "HTML 애니메이션", ico: "✦" },
    { type: "html", label: "HTML 블록", hint: "차트·데모·레이아웃", ico: "</>" },
    { type: "divider", label: "구분선", hint: "가로줄", ico: "―" },
    { type: "database", label: "표", hint: "표·보드", ico: "▤" },
    { type: "image", label: "이미지", hint: "올리거나 붙여넣기", ico: "▣" },
    { type: "video", label: "영상", hint: "주소나 파일", ico: "▶" },
    { type: "audio", label: "오디오", hint: "소리 파일", ico: "♪" },
    { type: "file", label: "파일", hint: "문서 올리기", ico: "🗎" },
    { type: "embed", label: "임베드", hint: "지도·코드 넣기", ico: "⧉" },
    { type: "bookmark", label: "북마크", hint: "링크 카드", ico: "🔖" },
    { type: "columns", label: "열 나누기", hint: "2~3열", ico: "◫" },
    { type: "table", label: "간단 표", hint: "그냥 표", ico: "☐" },
    { type: "equation", label: "수식", hint: "라텍", ico: "∑" },
    { type: "subpage", label: "하위 페이지", hint: "이 안에 새 페이지", ico: "⊕" },
    { type: "toc", label: "목차", hint: "제목 목록", ico: "≡" },
    { type: "breadcrumb", label: "이동 경로", hint: "위 계층", ico: "⌂" },
    { type: "button", label: "버튼", hint: "링크 버튼", ico: "◉" },
    { type: "progress", label: "진행률", hint: "막대 표시", ico: "▮" },
    { type: "db_ref", label: "데이터베이스", hint: "연결된 DB 보기", ico: "⛁" }
  ];

  // issue 147: default column names are data, named in the UI language they are made in (assets/i18n-app.js).
  function dataName(ko) { return window.AcardLang ? AcardLang.text(ko) : ko; }
  function dbCols() { return ["상태", "담당", "다음 할 일"].map(dataName); }

  var easy = null;
  function loadEasy() { return Promise.all([lazy("easy-insert").then(function (e) { easy = e; }, function () {}), loadComponents()]); }
  // ds10: registered components join the slash list once the components chunk is loaded (with easy-insert).
  var componentItems = [];
  function loadComponents() { return lazy("components").then(function (c) { return c.ready; }).then(function () { return lazy("components"); }).then(function (c) { componentItems = c.slashItems(); }, function () {}); }
  function slashMatches(query) { var all = BLOCK_TYPES.concat(componentItems); return easy ? easy.matches(all, query) : all; }

  var MEDIA_TYPES = { image: 1, video: 1, audio: 1, file: 1, embed: 1, bookmark: 1 };
  var LAYOUT_TYPES = { table: 1, equation: 1, toc: 1, breadcrumb: 1, button: 1, progress: 1 };
  var cm = window.ColumnsModel;
  // Columns hold blocks (notion-parity C13): old text-only columns convert on load, empty columns keep one paragraph.
  function structure(blocks) { return cm.fillColumns(cm.clampColumnsDepth(cm.columnsFromLegacy(blocks)), newBlock); }
  var BLOCK_DEFAULTS = {
    image: function () { return { meta: { src: "", width: 100 } }; },
    video: function () { return { meta: { url: "" } }; },
    audio: function () { return { meta: { url: "" } }; },
    file: function () { return { meta: { url: "", name: "" } }; },
    embed: function () { return { meta: { url: "" } }; },
    bookmark: function () { return { meta: { url: "" } }; },
    table: function () { return { meta: { columns: ["열1", "열2", "열3"].map(dataName), rows: [["", "", ""], ["", "", ""]], header: true } }; },
    button: function () { return { meta: { url: "" } }; },
    progress: function () { return { meta: { value: 50, color: "blue" } }; }
  };

  var PH = {
    paragraph: "글을 써 보세요. '/' 를 누르면 블록을 고를 수 있어요.",
    heading1: "제목 1",
    heading2: "제목 2",
    heading3: "제목 3",
    heading4: "제목 4",
    bulleted: "목록 항목",
    numbered: "목록 항목",
    to_do: "할 일",
    toggle: "토글 제목",
    callout: "강조할 내용",
    quote: "인용",
    button: "버튼 글자",
    progress: "진행률 라벨"
  };

  var identity = document.querySelector('meta[name="acard-id"]')?.content || "";
  var THEME_KEY = "dori-notes-theme:" + identity;
  try {
    var stored = localStorage.getItem(THEME_KEY);
    document.documentElement.setAttribute("data-theme", stored === "light" || stored === "dark" ? stored : "auto");
  } catch (e) {}

  var slug = decodeURIComponent((location.pathname.match(/^\/edit\/([^/]+)\/?$/) || [])[1] || "index");
  var state = { title: "", blocks: [], pages: [], dirty: false, saving: false, lastSaved: null, kind: "note", dbRow: null, baseUpdated: null };
  var dirty = false;
  Object.defineProperty(state, "dirty", { enumerable: true, get: function () { return dirty; }, set: function (value) {
    dirty = !!value;
    window[dirty ? "addEventListener" : "removeEventListener"]("beforeunload", beforeUnload);
  } });
  var els = {
    tree: document.getElementById("tree"),
    title: document.getElementById("title"),
    blocks: document.getElementById("blocks"),
    save: document.getElementById("save-state"),
    meta: document.getElementById("meta"),
    slash: document.getElementById("slash"),
    ctx: document.getElementById("ctx"),
    backlinks: document.getElementById("backlinks"),
    sidebar: document.getElementById("sidebar"),
    menu: document.getElementById("menu")
  };

  function api(path, options) {
    return net("/api" + path, Object.assign({ headers: { "content-type": "application/json" } }, options || {})).then(apiResponse, function (error) {
      if (error.name !== "AbortError") error.acardFailure = "network";
      throw error;
    });
  }

  function apiResponse(res) {
    if (res.headers.get("x-acard-offline") === "1") return Promise.reject(Object.assign(new Error("오프라인 · 읽기 전용. 다시 연결한 뒤 새로고침해 주세요."), { acardFailure: "offline-cache", acardIdentity: res.headers.get("x-acard-id") }));
    return res.json().catch(function () { return {}; }).then(function (body) {
      if (!res.ok) throw Object.assign(new Error(body.error || String(res.status)), { acardFailure: "http", status: res.status });
      return body;
    });
  }

  var lazyPending = Object.create(null), lazyApis = Object.create(null);
  function lazy(name) {
    return lazyPending[name] || (lazyPending[name] = Promise.resolve().then(function () {
      var versions = (window.AcardLazy || {})[name];
      if (!versions || !versions.js) throw Error("Unknown lazy feature: " + name);
      return Promise.all(Object.keys(versions).map(function (ext) {
        return new Promise(function (resolve, reject) {
          var node = document.createElement(ext === "css" ? "link" : "script");
          node.rel = "stylesheet";
          node[ext === "css" ? "href" : "src"] = "/lazy/" + name + "." + ext + "?v=" + versions[ext];
          node.onload = resolve; node.onerror = reject;
          document.head.appendChild(node);
        });
      })).then(function () {
        if (!(name in lazyApis)) throw Error("Unregistered lazy feature: " + name);
        return lazyApis[name];
      });
    }));
  }
  var featureListeners = Object.create(null);
  var featureReady = false;
  function emitFeature(event, value) {
    (featureListeners[event] || []).slice().forEach(function (fn) {
      try { fn(value); } catch (error) { console.error("Editor feature listener failed", error); }
    });
  }
  window.AcardEditor = {
    lazy: lazy,
    provide: function (name, api) { lazyApis[name] = api; if (name === "editor-selection") selectionTools = api; },
    on: function (event, fn) {
      var listeners = featureListeners[event] || (featureListeners[event] = []);
      listeners.push(fn);
      if (event === "ready" && featureReady) {
        try { fn(window.AcardEditor); } catch (error) { console.error("Editor feature listener failed", error); }
      }
      return function () { var at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); };
    },
    get state() { return state; },
    blockTypes: function () { return BLOCK_TYPES.concat(componentItems); }, loadComponents: function () { return loadComponents(); },
    coreEditing: coreEditing,
    createBlock: newBlock,
    transact: transact, captureSelection: captureSelection, restoreSelection: restoreSelection,
    remoteHistory: function (remote, preserve) { if (!preserve) { undoStack.length = 0; redoStack.length = 0; } previousSnapshot = snapshot(); if (remote) emitFeature("remoteAdopted", remote); },
    recordExternalEdit: function (run) { undoStack.push({ run: run }); redoStack.length = 0; },
    whenSaveSettled: function () { return (activeSave || Promise.resolve()).catch(function () {}); },
    selectBlocks: function (ids) {
      restoreSelection({ anchor: null, focus: null, selectedBlockIds: ids });
      emitFeature("selection", { blockIds: Array.from(selectedIds) });
    },
    paintTocs: paintTocs, api: api, slug: slug, loadTree: function () { return loadTree(); }, scheduleSave: scheduleSave, render: render, setSave: setSave, save: save,
    transport: function (pageSlug, payload) {
      if (!Number.isSafeInteger(payload.base_updated)) return Promise.resolve(new Response(JSON.stringify({ error: "불러오지 못했어요 · 읽기 전용. 새로고침해 주세요." }), { status: 428 }));
      return net("/api/page/" + encodeURIComponent(pageSlug), { method: "PUT", headers: { "content-type": "application/json", "x-acard-client": this.clientId || "" }, body: JSON.stringify(payload) });
    },
    insertBlocksAfter: function (id, blocks) {
      var index = state.blocks.findIndex(function (block) { return block.id === id; });
      if (index < 0) throw new Error("Unknown block: " + id);
      var added = blocks.map(function (block) { return Object.assign(newBlock(), block); });
      state.blocks.splice.apply(state.blocks, [model.endOf(state.blocks, index), 0].concat(added));
      render(); scheduleSave();
      return added.map(function (block) { return block.id; });
    },
    replaceBlockText: function (id, text) {
      var block = state.blocks.find(function (entry) { return entry.id === id; });
      if (!block) throw new Error("Unknown block: " + id);
      block.text = String(text);
      if (block.meta) { block.meta = Object.assign({}, block.meta); delete block.meta.richText; }
      render(); scheduleSave();
    },
    // Block commands for the right-click menu and Tab palette (acard-human-edit). acard-core-editing may replace
    // these with its editor-commands module; callers use only these names.
    commands: {
      duplicate: function (id) { var i = indexOf(id); return i < 0 ? null : duplicate(i); },
      move: function (id, delta) { var i = indexOf(id); if (i >= 0) move(i, delta); },
      indent: function (id, delta) { var i = indexOf(id); if (i >= 0) indent(i, delta); },
      remove: function (id) { var i = indexOf(id); if (i < 0) return; state.blocks.splice(i, model.endOf(state.blocks, i) - i); render(); scheduleSave(); undoToast("블록을 지웠어요"); },
      turnInto: function (id, anchor) { var i = indexOf(id); if (i >= 0) openSlash(anchor, i); },
      setType: function (id, type) { var i = indexOf(id); if (i < 0) return; slashIndex = i; applySlash(type); },
      color: function (id, anchor) { var b = state.blocks[indexOf(id)]; if (b) lazy("block-style").then(function (s) { s.open(anchor, b); }); },
      comment: function (id) { if (pageContext) pageContext.comments(id); },
      copyLink: function (id) { return navigator.clipboard.writeText(location.origin + "/edit/" + encodeURIComponent(slug) + "/#block-" + encodeURIComponent(id)); },
      blockMenu: function (id, anchor) { var i = indexOf(id); if (i >= 0) openCtx(anchor, i); },
      focus: function (id) { focusBlock(id); }
    },
    getSelection: function () {
      var selection = window.getSelection();
      var node = selection && selection.anchorNode;
      var element = node && (node.nodeType === 1 ? node : node.parentElement);
      var block = element && element.closest(".blk[data-id]");
      return { text: selection ? selection.toString() : "", blockId: block ? block.dataset.id : null, blockIds: Array.from(selectedIds) };
    }
  };

  function setSave(text, on) {
    // data-text keeps the source string: the English layer (i18n-app.js) rewrites the visible text, and save-queue.js
    // compares against the source so the two do not keep overwriting each other.
    els.save.dataset.text = text;
    els.save.textContent = text;
    els.save.classList.toggle("on", !!on);
  }
  // After a big edit (delete / move) offer one-click undo for 5 s; Ctrl+Z does the same.
  function undoToast(text) { lazy("legacy-block-menu").then(function (menu) { menu.toast(text, function () { restoreEdit(undoStack, redoStack); }); }).catch(featureError); }

  var saveTimer = null;
  var activeSave = null;
  var hasToc = false;
  var undoStack = [], redoStack = [], previousSnapshot = null, restoring = false;
  var transaction = null;
  var selectionTools = null;
  function snapshot() { return JSON.stringify({ title: state.title, blocks: state.blocks }); }
  function captureSelection() { return selectionTools.capture(Array.from(selectedIds)); }
  function restoreSelection(bookmark) {
    if (!bookmark) return;
    selectedIds.clear();
    bookmark.selectedBlockIds.forEach(function (id) { if (document.getElementById("block-" + id)) selectedIds.add(id); });
    if (selectionTools) selectionTools.restore(bookmark);
  }
  function transact(label, mutate, options) {
    if (transaction) {
      try {
        if (mutate.constructor.name === "AsyncFunction") throw Error("synchronous only");
        var nested = mutate(transaction.api); if (nested && typeof nested.then === "function") throw Error("synchronous only");
      }
      catch (error) { transaction.error = error; throw error; }
      return false;
    }
    var before = snapshot(), selection = options && options.beforeSelection || captureSelection();
    var tx = { error: null, selection: selection, api: { setSelection: function (value) { tx.selection = value; } } };
    transaction = tx;
    try {
      if (mutate.constructor.name === "AsyncFunction") throw Error("synchronous only");
      var result = mutate(tx.api);
      if (result && typeof result.then === "function") throw Error("synchronous only");
      if (tx.error) throw tx.error;
      state.blocks = structure(state.blocks);
    } catch (error) {
      var original = JSON.parse(before); state.title = original.title; state.blocks = original.blocks;
      transaction = null; render(); restoreSelection(selection); throw error;
    }
    transaction = null;
    if (snapshot() === before) return false;
    undoStack.push({ document: before, selection: selection, label: label });
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    if (!(options && options.render && options.render())) render();
    restoreSelection(tx.selection);
    restoring = true;
    try { scheduleSave(); } finally { restoring = false; }
    return true;
  }
  function restoreEdit(from, to) {
    if (!from.length) return;
    if (from[from.length - 1].run) return window.AcardEditor.commands.restoreExternal(from, to);
    var entry = from.pop();
    to.push(typeof entry === "string" ? snapshot() : { document: snapshot(), selection: captureSelection(), label: entry.label });
    var value = JSON.parse(typeof entry === "string" ? entry : entry.document);
    var hadSubpages = subpagesOf(state.blocks);
    state.title = value.title; state.blocks = value.blocks;
    syncSubpages(hadSubpages, subpagesOf(state.blocks));
    previousSnapshot = snapshot();
    restoring = true;
    try { render(); scheduleSave(); } finally { restoring = false; }
    if (typeof entry !== "string") restoreSelection(entry.selection);
  }
  // edited: the block whose text just changed (wireText). The TOC lists headings only, so typing in any other
  // block (or on a page without a TOC) does not repaint it; structural edits pass nothing and always repaint.
  function scheduleSave(edited) {
    if (transaction) return;
    startupEdited = true;
    var current = snapshot();
    if (!restoring && previousSnapshot && current !== previousSnapshot) {
      undoStack.push(previousSnapshot);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
    }
    previousSnapshot = current;
    state.dirty = true;
    if (hasToc && !(edited && edited.id && !/^heading[1-4]$/.test(edited.type))) paintTocs();
    emitFeature("change", { title: state.title, blocks: state.blocks, base_updated: state.baseUpdated });
    setSave("저장 중…", true);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save().catch(function (error) { setSave("저장 실패: " + error.message, true); }); }, 700);
  }

  function save() {
    if (transaction) throw Error("busy");
    if (state.saving) return activeSave.then(function () { return state.dirty ? save() : undefined; });
    if (!state.dirty) return Promise.resolve();
    if (!Number.isSafeInteger(state.baseUpdated)) return serverPage.then(function () {
      if (!Number.isSafeInteger(state.baseUpdated)) throw Error("불러오지 못했어요 · 읽기 전용. 새로고침해 주세요.");
      return save();
    });
    state.saving = true;
    var payload = JSON.parse(JSON.stringify({ title: state.title, blocks: state.blocks, base_updated: state.baseUpdated }));
    emitFeature("beforeSave", payload);
    activeSave = created.then(function () {
      return window.AcardEditor.transport(slug, payload).then(apiResponse);
    })
      .then(function (result) {
        state.baseUpdated = result.updated;
        state.dirty = JSON.stringify({ title: payload.title, blocks: payload.blocks }) !== snapshot();
        state.lastSaved = new Date();
        setSave("저장됨 " + state.lastSaved.toTimeString().slice(0, 5), false);
        loadBacklinks();
        emitFeature("saved", payload);
      })
      .catch(function (error) {
        state.dirty = true;
        setSave("저장 실패: " + error.message, true);
        emitFeature("saveFailed", error);
        throw error;
      })
      .finally(function () { state.saving = false; });
    return activeSave.then(function () { return state.dirty ? save() : undefined; });
  }

  function uid() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function indexOf(id) { return state.blocks.findIndex(function (block) { return block.id === id; }); }

  function newBlock(type) {
    return { id: uid(), type: type || "paragraph", text: "", checked: false, indent: 0, meta: null };
  }

  function render() {
    if (transaction) return;
    if (document.activeElement !== els.title) els.title.value = state.title;
    var shaped = structure(state.blocks);
    if (shaped !== state.blocks) state.blocks = shaped;
    els.blocks.innerHTML = "";
    hasToc = state.blocks.some(function (block) { return block.type === "toc"; });
    var parents = [];
    state.blocks.forEach(function (block, index) {
      while (parents.length && model.depth(parents[parents.length - 1].block) >= model.depth(block)) parents.pop();
      var row = blockEl(block, index);
      var parent = parents.length ? parents[parents.length - 1].host : els.blocks;
      parent.appendChild(row);
      var childHost = document.createElement("div");
      childHost.className = block.type === "columns" ? "children cols cols-ed" : "children";
      if (block.type === "columns") childHost.style.setProperty("--cols", columnTemplate(block));
      row.querySelector(".body").appendChild(childHost);
      parents.push({ block: block, host: childHost });
    });
    mountLinkedDatabases();
  }

  function blockEl(block, index) {
    var row = document.createElement("div");
    row.className = "blk " + cls(block.type) + (block.checked ? " on" : "") + (block.indent ? " ind" + block.indent : "");
    row.dataset.id = block.id;
    row.id = "block-" + block.id;
    row.dataset.index = String(index);
    row.classList.toggle("selected", selectedIds.has(block.id));
    // Lists keep their marker and type; only rows with descendants gain the existing twist.
    var list = coreEditing && /^(bulleted|numbered)$/.test(block.type) && state.blocks[index + 1] && model.depth(state.blocks[index + 1]) > model.depth(block);
    var tgh = list || /^heading[1-4]$/.test(block.type) && block.meta && block.meta.toggle === true;
    var expanded = list ? !block.meta || block.meta.open !== false : !!(block.meta && block.meta.open);
    if (tgh) row.classList.add("tgh");
    if ((block.type === "toggle" || tgh) && !expanded) row.classList.add("collapsed");
    if (block.meta && block.meta.subpage) row.classList.add("subpage");
    // Block color (notion-parity C6): same bc-* class as the reader; the rules come with the lazy block-style chunk.
    var color = block.type !== "progress" && block.meta && /^(gray|brown|orange|yellow|green|blue|purple|pink|red)(_background)?$/.exec(block.meta.color);
    if (color) { row.classList.add("bc-" + color[0]); lazy("block-style").catch(function () {}); }
    // AI marks (acard-human-edit): the block's own mark; the marks chunk draws it and any marked text pieces.
    if (block.meta && /^(lock|ref|edit)$/.test(block.meta.ai)) row.dataset.ai = block.meta.ai;
    if (row.dataset.ai || (block.meta && Array.isArray(block.meta.richText) && block.meta.richText.some(function (run) { return run && run.ai; }))) lazy("ai-marks-ui").catch(function () {});

    var gutter = document.createElement("div");
    gutter.className = "gutter";
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.title = "아래에 블록 추가";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", function () { insertAfter(Number(row.dataset.index), newBlock()); });
    var menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.title = "블록 메뉴";
    menuBtn.textContent = "⋮⋮";
    menuBtn.className = "drag-handle";
    wireDrag(menuBtn, row, block);
    menuBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (!humanEdit()) return openCtx(menuBtn, Number(row.dataset.index));
      lazy("context-menu").then(function (menu) { menu.openBlock(block.id, menuBtn); }, function () { openCtx(menuBtn, Number(row.dataset.index)); });
    });
    gutter.appendChild(addBtn);
    gutter.appendChild(menuBtn);
    var select = document.createElement("input"); select.type = "checkbox"; select.className = "block-select"; select.checked = selectedIds.has(block.id); select.setAttribute("aria-label", "블록 선택");
    select.addEventListener("change", function () { if (select.checked) selectedIds.add(block.id); else selectedIds.delete(block.id); row.classList.toggle("selected", select.checked); });
    var hit = document.createElement("label"); hit.className = "block-hit"; hit.appendChild(select);
    gutter.appendChild(hit);
    row.appendChild(gutter);

    var body = document.createElement("div");
    body.className = "body";

    if (block.type === "bulleted" || block.type === "numbered") {
      var marker = document.createElement("div");
      marker.className = "marker";
      row.appendChild(marker);
    }

    if (block.type === "to_do") {
      var box = document.createElement("button");
      box.type = "button";
      box.className = "todo-box" + (block.checked ? " on" : "");
      box.setAttribute("aria-label", "완료 표시");
      box.textContent = block.checked ? "✓" : "";
      box.addEventListener("click", function () {
        block.checked = !block.checked;
        row.classList.toggle("on", block.checked);
        box.classList.toggle("on", block.checked);
        box.textContent = block.checked ? "✓" : "";
        scheduleSave();
      });
      body.appendChild(box);
    }

    if (block.type === "divider") {
      body.className = "body divider-body";
      row.appendChild(body);
      return row;
    }

    if (block.type === "columns" || block.type === "column") {
      row.classList.add(block.type === "columns" ? "colset" : "colcell");
      if (block.type === "columns") body.appendChild(columnsBar(block, index));
      else { gutter.remove(); columnResizer(row, index); }
      row.appendChild(body);
      return row;
    }

    if (block.type === "database") {
      body.appendChild(dbBlock(block, index));
      row.appendChild(body);
      return row;
    }

    if (block.type === "db_ref") {
      body.appendChild(dbRefBlock(block));
      row.appendChild(body);
      return row;
    }

    if (block.type === "synced") {
      var sh = document.createElement("div");
      sh.textContent = "불러오는 중…";
      lazy("synced-blocks").then(function (s) { s.mount(sh, block); }, function () { sh.textContent = "동기화 블록을 불러오지 못했어요."; });
      body.appendChild(sh);
      row.appendChild(body);
      return row;
    }

    if (block.type === "component") {
      var uh = document.createElement("div");
      uh.textContent = "불러오는 중…";
      lazy("components").then(function (c) { c.mount(uh, block, scheduleSave); }, function () { uh.textContent = "컴포넌트 편집기를 불러오지 못했어요."; });
      body.appendChild(uh);
      row.appendChild(body);
      return row;
    }


    if (/^(diagram|chart|visual|html|part)$/.test(block.type)) {
      var vh = document.createElement("div");
      vh.textContent = "불러오는 중…";
      lazy(block.type == "part" ? "parts" : "visuals").then(function (v) { v.mount(vh, block, scheduleSave); }, function () { vh.textContent = "시각 자료 편집기를 불러오지 못했어요."; });
      body.appendChild(vh);
      row.appendChild(body);
      return row;
    }

    if (MEDIA_TYPES[block.type]) {
      body.appendChild(mediaBlock(block, index));
      row.appendChild(body);
      return row;
    }

    if (LAYOUT_TYPES[block.type]) {
      body.appendChild(layoutBlock(block, index));
      row.appendChild(body);
      return row;
    }

    var host = body;
    if (block.type === "toggle" || tgh) {
      var trow = document.createElement("div");
      trow.className = "trow";
      var twist = document.createElement("button");
      twist.type = "button";
      twist.className = "twist";
      twist.textContent = "▶";
      twist.classList.toggle("open", expanded);
      twist.setAttribute("aria-expanded", String(expanded));
      twist.setAttribute("aria-label", "토글 펴기");
      twist.addEventListener("click", function () {
        var open = row.classList.toggle("collapsed");
        twist.classList.toggle("open", !open);
        block.meta = Object.assign({}, block.meta, { open: !open });
        twist.setAttribute("aria-expanded", String(!open));
        scheduleSave();
      });
      trow.appendChild(twist);
      body.appendChild(trow);
      host = trow;
    }

    if (block.type === "callout") {
      var icon = document.createElement("button");
      icon.type = "button"; icon.className = "co-ico";
      icon.textContent = (block.meta && block.meta.icon) || "✦";
      icon.setAttribute("aria-label", "콜아웃 아이콘 바꾸기");
      icon.addEventListener("click", function () {
        lazy("icon-picker").then(function (picker) {
          picker.open(icon, block.meta && block.meta.icon, function (next) {
            var meta = Object.assign({}, block.meta);
            if (next) meta.icon = next; else delete meta.icon;
            block.meta = meta; render(); scheduleSave();
          });
        });
      });
      body.appendChild(icon);
    }

    var text = document.createElement("div");
    text.className = "text";
    text.contentEditable = "true";
    text.spellcheck = false;
    text.dataset.ph = PH[block.type] || "";
    if (block.meta && Array.isArray(block.meta.richText) && block.type !== "code") text.innerHTML = model.richHtml(block.meta.richText, block.text, true);
    else text.textContent = block.text;
    wireText(text, block, row, index);
    host.appendChild(text);
    row.appendChild(body);
    return row;
  }

  function cls(type) {
    return ({ heading1: "h1", heading2: "h2", heading3: "h3", heading4: "h4", to_do: "todo" })[type] || type;
  }

  function wireText(text, block, row, index) {
    text.addEventListener("focus", loadEasy, { once: true });
    if (coreEditing) text.addEventListener("focus", function () { loadEditing().catch(featureError); }, { once: true });
    text.addEventListener("input", function (ev) {
      var index = Number(row.dataset.index);
      block.text = text.textContent;
      if (block.type !== "code") block.meta = Object.assign({}, block.meta, { richText: model.readRich(text) });
      if (!ev.isComposing) {
        if (block.type === "paragraph" && /^\/[^\s/]{0,12}$/.test(text.textContent)) { openSlash(text, index, text.textContent.slice(1)); loadEasy().then(function () { if (slashIndex == index) openSlash(text, index, text.textContent.slice(1)); }); }
        else if (!els.slash.hidden && slashIndex === index) hideSlash();
        if (easy && easy.shortcut(text.textContent, block, index)) return;
        if (formatContext) formatContext.mention(text, block);
      }
      scheduleSave(block);
    });
    text.addEventListener("paste", function (ev) {
      ev.preventDefault();
      var data = ev.clipboardData || window.clipboardData, paste = data.getData("text/plain"), next = window.AcardEditorNext;
      var insert = function () { document.execCommand("insertText", false, paste.replace(/\r?\n+/g, " ")); };
      // issue 108: markdown -> blocks paste lives in the lazy editor-next chunk. A multi-line paste that lands before it has
      // started (a new page, right after the title) used to be joined into one paragraph here; it now waits for the chunk.
      if (next && next.on && !next.started && /\n/.test(paste)) return lazy("editor-next").then(function (f) { f.start(); f.paste(block.id, data.getData("text/html"), paste) || insert(); }, function () { text.focus(); insert(); });
      insert();
    });
    text.addEventListener("keydown", function (ev) {
      if (ev.isComposing || ev.keyCode === 229) return;
      var index = Number(row.dataset.index);
      var mod = ev.ctrlKey || ev.metaKey;
      if (coreEditing && els.slash.hidden && (ev.key.length > 1 || mod)) {
        if (selectionTools && window.AcardEditor.commands?.textKey) { if (window.AcardEditor.commands.textKey(ev, block.id)) return; }
        else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); runBlockCommand("splitCurrent", [block.id]); return; }
      }
      if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "d") {
        ev.preventDefault();
        focusBlock(duplicate(index).id);
        return;
      }
      if (mod && ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
        ev.preventDefault();
        moveSibling(index, ev.key === "ArrowUp" ? -1 : 1);
        focusBlock(block.id);
        return;
      }
      if (!els.slash.hidden && ["Enter", "ArrowUp", "ArrowDown"].indexOf(ev.key) >= 0) return;
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        hideSlash();
        if (easy && easy.pipeTable(text.textContent, block)) { render(); scheduleSave(); return; }
        if (!text.textContent && ["bulleted", "numbered", "to_do"].indexOf(block.type) >= 0) {
          block.type = "paragraph"; render(); focusBlock(block.id); scheduleSave(); return;
        }
        insertAfter(index, newBlock(block.type === "code" ? "code" : (block.type === "bulleted" || block.type === "numbered" || block.type === "to_do" ? block.type : "paragraph")), block.indent);
      } else if (ev.key === "Backspace" && text.textContent === "" && state.blocks.length > 1) {
        ev.preventDefault();
        if (model.endOf(state.blocks, index) > index + 1) return;
        var column = cm.columnOf(state.blocks, index);
        // The only block of a column stays (empty); the column itself never disappears from Backspace.
        if (column && model.endOf(state.blocks, index) === model.endOf(state.blocks, state.blocks.indexOf(column)) && state.blocks[index - 1] === column) return;
        var prev = state.blocks[index - 1];
        if (prev && (prev.type === "column" || prev.type === "columns")) prev = null;
        state.blocks.splice(index, model.endOf(state.blocks, index) - index);
        render();
        if (prev) focusBlock(prev.id);
        scheduleSave();
      } else if (ev.key === "Tab" && humanEdit() && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && block.type === "paragraph" && !text.textContent) {
        // Tab on an empty line opens the feature palette (acard-human-edit); lists, tables and lines with text keep indenting.
        ev.preventDefault();
        lazy("tab-palette").then(function (p) { p.open(block.id, text); }, function () {});
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        if (cm.canIndent(state.blocks, index, ev.shiftKey ? -1 : 1)) model.indent(state.blocks, index, ev.shiftKey ? -1 : 1);
        render();
        focusBlock(block.id);
        scheduleSave();
      } else if (ev.key === "ArrowUp" && !text.textContent) {
        var up = nearText(index, -1);
        if (up) { ev.preventDefault(); focusBlock(up.id); }
      } else if (ev.key === "ArrowDown") {
        var down = nearText(index, 1);
        if (down) { ev.preventDefault(); focusBlock(down.id); }
      } else if (ev.key === "Escape") {
        hideSlash();
      }
    });
  }

  // The next block in the given direction that has a text field (columns and column rows have none).
  function nearText(index, step) {
    for (var i = index + step; i >= 0 && i < state.blocks.length; i += step) {
      if (state.blocks[i].type !== "columns" && state.blocks[i].type !== "column") return state.blocks[i];
    }
    return null;
  }

  function columnTemplate(block) {
    var n = Math.max(1, state.blocks.filter(function (item, i) { return item.type === "column" && cm.parentOf(state.blocks, i) === block; }).length);
    var widths = block.meta && Array.isArray(block.meta.widths) && block.meta.widths.length === n ? block.meta.widths : cm.equalWidths(n);
    return widths.map(function (w) { return Math.max(0.05, Number(w) || 0) + "fr"; }).join(" ");
  }

  // The border between a column and the next one is a handle: dragging it moves width between the two (meta.widths,
  // sum 1, at least 0.15 each); the grid follows the pointer and the page saves on release.
  function columnResizer(row, index) {
    var head = cm.parentOf(state.blocks, index);
    if (!head || head.type !== "columns") return;
    var groups = cm.columnGroups(state.blocks, state.blocks.indexOf(head));
    var at = groups.findIndex(function (group) { return group.index === index; });
    if (at < 0 || at >= groups.length - 1) return;
    var grip = document.createElement("div");
    grip.className = "colresize";
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-label", "열 너비 조절");
    var drag = null;
    grip.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      var host = row.parentElement;
      var widths = head.meta && Array.isArray(head.meta.widths) && head.meta.widths.length === groups.length ? head.meta.widths.slice() : cm.equalWidths(groups.length);
      drag = { x: ev.clientX, width: host.getBoundingClientRect().width, host: host, start: widths, now: widths };
      grip.setPointerCapture(ev.pointerId);
    });
    grip.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var pair = drag.start[at] + drag.start[at + 1];
      var left = Math.min(pair - 0.15, Math.max(0.15, drag.start[at] + (ev.clientX - drag.x) / drag.width));
      drag.now = drag.start.slice();
      drag.now[at] = Math.round(left * 10000) / 10000;
      drag.now[at + 1] = Math.round((pair - left) * 10000) / 10000;
      drag.host.style.setProperty("--cols", drag.now.map(function (w) { return w + "fr"; }).join(" "));
    });
    function done() {
      if (!drag) return;
      head.meta = Object.assign({}, head.meta, { widths: drag.now });
      drag = null;
      scheduleSave();
    }
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
    row.appendChild(grip);
  }

  // Moves the block at index to the end of the column before (-1) or after (1) the one it sits in.
  function moveToColumn(index, step) {
    var column = cm.columnOf(state.blocks, index);
    if (!column) return;
    var head = cm.parentOf(state.blocks, state.blocks.indexOf(column));
    var groups = cm.columnGroups(state.blocks, state.blocks.indexOf(head));
    var at = groups.findIndex(function (group) { return group.index === state.blocks.indexOf(column); });
    var next = groups[at + step];
    if (!next) return;
    if (model.move(state.blocks, index, next.end, model.depth(column) + 1)) { render(); scheduleSave(); }
  }

  // The small bar above columns: add a column (up to 4) or remove the last empty-able one (down to 2).
  function columnsBar(block, index) {
    var bar = document.createElement("div");
    bar.className = "colbar";
    var groups = cm.columnGroups(state.blocks, index);
    function button(label, aria, act) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "minibtn"; b.textContent = label; b.setAttribute("aria-label", aria);
      b.addEventListener("click", function () { act(); block.meta = Object.assign({}, block.meta, { widths: cm.equalWidths(cm.columnGroups(state.blocks, state.blocks.indexOf(block)).length) }); render(); scheduleSave(); });
      bar.appendChild(b);
    }
    if (groups.length < 4) button("+ 열", "열 추가", function () {
      var last = groups[groups.length - 1], column = newBlock("column"), para = newBlock();
      column.indent = model.depth(block) + 1; para.indent = column.indent + 1;
      state.blocks.splice(last ? last.end : index + 1, 0, column, para);
    });
    if (groups.length > 2) button("− 열", "마지막 열 지우기 (안의 블록은 앞 열로)", function () {
      var last = groups[groups.length - 1];
      state.blocks.splice(last.index, 1);
    });
    return bar;
  }

  function focusBlock(id) {
    var row = els.blocks.querySelector('[data-id="' + id + '"]');
    if (!row) return;
    var text = row.querySelector(".text");
    if (!text) return;
    text.focus();
    var range = document.createRange();
    range.selectNodeContents(text);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertAfter(index, block, indent) {
    block.indent = typeof indent === "number" ? indent : 0;
    state.blocks.splice(model.endOf(state.blocks, index), 0, block);
    render();
    focusBlock(block.id);
    scheduleSave();
  }

  function dbRefBlock(block) {
    var meta = block.meta || {};
    var wrap = document.createElement("div");
    wrap.className = "dbrefblock";
    var title = document.createElement("div");
    title.className = "dbrefname";
    title.textContent = meta.title || meta.database || "연결된 데이터베이스 없음";
    wrap.appendChild(title);
    if (meta.database) {
      var link = document.createElement("a");
      link.className = "dbreflink";
      link.href = "/edit/" + encodeURIComponent(meta.database) + "/";
      link.textContent = "데이터베이스 열기 ↗";
      wrap.appendChild(link);
      var host = document.createElement("div");
      host.className = "dbrefhost";
      host.id = "db-ref-" + block.id;
      host.dataset.dbref = meta.database;
      wrap.appendChild(host);
    }
    return wrap;
  }

  function mountLinkedDatabases() {
    var hosts = Array.prototype.slice.call(document.querySelectorAll("[data-dbref]"));
    hosts.forEach(function (host) {
      var target = host.getAttribute("data-dbref");
      if (window.DoriDB) {
        window.DoriDB.load(target, { mountId: host.id }).catch(function () {});
        return;
      }
      api("/db/" + encodeURIComponent(target)).then(function (data) {
        var title = document.createElement("div");
        title.className = "dbrefname";
        title.textContent = data.database.title + " · " + data.rows.length + "행";
        host.appendChild(title);
        var table = document.createElement("table");
        table.className = "dbtable compact";
        var columns = window.DoriDBModel ? window.DoriDBModel.visibleProperties(data.properties, data.views[0]) : data.properties;
        var head = document.createElement("tr");
        columns.forEach(function (prop) {
          var th = document.createElement("th");
          th.textContent = prop.name;
          head.appendChild(th);
        });
        table.appendChild(head);
        data.rows.slice(0, 30).forEach(function (row) {
          var tr = document.createElement("tr");
          columns.forEach(function (prop) {
            var td = document.createElement("td");
            var value = prop.type === "title" ? (row.pageTitle || "") : (row.computed && row.computed[prop.id] !== undefined ? row.computed[prop.id] : row.props[prop.id]);
            td.textContent = window.DoriDBModel ? window.DoriDBModel.displayValue(prop, value) : String(value === null || value === undefined ? "" : value);
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        host.appendChild(table);
      }).catch(function () {});
    });
  }

  function dbBlock(block, index) {
    var meta = block.meta || {};
    var columns = Array.isArray(meta.columns) ? meta.columns.slice() : [];
    var rows = Array.isArray(meta.rows) ? meta.rows.slice() : [];
    if (!columns.length) columns = dbCols();
    var view = meta.view === "board" ? "board" : "table";

    var wrap = document.createElement("div");
    wrap.className = "dbblock";

    var head = document.createElement("div");
    head.className = "dbhead";
    var seg = document.createElement("div");
    seg.className = "seg";
    [["table", "표"], ["board", "보드"]].forEach(function (pair) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = pair[1];
      button.className = view === pair[0] ? "on" : "";
      button.addEventListener("click", function () {
        meta.view = pair[0];
        block.meta = meta;
        render();
        scheduleSave();
      });
      seg.appendChild(button);
    });
    var name = document.createElement("span");
    name.className = "dbname";
    name.textContent = "행 " + rows.length + " · 열 " + columns.length;
    head.appendChild(seg);
    head.appendChild(name);
    wrap.appendChild(head);

    function commit() {
      block.meta = { columns: columns, rows: rows, view: view };
      scheduleSave();
    }

    if (view === "board") {
      var statusCol = columns.indexOf("상태") >= 0 ? "상태" : columns[0];
      var board = document.createElement("div");
      board.className = "board";
      var groups = [];
      rows.forEach(function (row) {
        var key = String(row[statusCol] || "없음");
        if (groups.indexOf(key) < 0) groups.push(key);
      });
      if (!groups.length) groups = ["없음"];
      groups.forEach(function (key) {
        var col = document.createElement("div");
        col.className = "boardcol";
        var h = document.createElement("h4");
        h.textContent = key + " (" + rows.filter(function (row) { return String(row[statusCol] || "없음") === key; }).length + ")";
        col.appendChild(h);
        rows.forEach(function (row) {
          if (String(row[statusCol] || "없음") !== key) return;
          var card = document.createElement("div");
          card.className = "boardcard";
          var titleCol = columns[0] === statusCol && columns.length > 1 ? columns[1] : columns[0];
          var title = document.createElement("div");
          title.className = "cell";
          title.contentEditable = "true";
          title.textContent = row[titleCol] || "";
          title.addEventListener("input", function () { row[titleCol] = title.textContent; commit(); });
          card.appendChild(title);
          var sub = document.createElement("div");
          sub.className = "sub";
          sub.textContent = columns.filter(function (name) { return name !== titleCol && name !== statusCol; })
            .map(function (name) { return name + ": " + (row[name] || "-"); }).join(" · ");
          card.appendChild(sub);
          var move = document.createElement("select");
          move.setAttribute("aria-label", "상태 옮기기");
          groups.forEach(function (option) {
            var o = document.createElement("option");
            o.value = option;
            o.textContent = option;
            if (option === key) o.selected = true;
            move.appendChild(o);
          });
          move.addEventListener("change", function () {
            row[statusCol] = move.value;
            commit();
            render();
          });
          card.appendChild(move);
          col.appendChild(card);
        });
        board.appendChild(col);
      });
      wrap.appendChild(board);
      return wrap;
    }

    var table = document.createElement("table");
    table.className = "dbtable";
    var thead = document.createElement("thead");
    var hrow = document.createElement("tr");
    // #73: no "[ ]" column -> a box per row anyway; the first tick adds a 완료 column.
    var CHK = /^\[( |x|X)?\]$/;
    var noBoxCol = rows.length && !columns.some(function (c) { return rows.some(function (r) { return CHK.test(String(r[c] || "").trim()); }); });
    if (noBoxCol) hrow.appendChild(document.createElement("th"));
    columns.forEach(function (column, columnIndex) {
      var th = document.createElement("th");
      var cell = document.createElement("div");
      cell.className = "cell";
      cell.contentEditable = "true";
      cell.textContent = column;
      cell.addEventListener("input", function () {
        var value = cell.textContent.trim() || dataName("열");
        var old = columns[columnIndex];
        if (value === old) return;
        columns[columnIndex] = value;
        rows.forEach(function (row) { if (old !== value) { row[value] = row[old] || ""; delete row[old]; } });
        commit();
      });
      th.appendChild(cell);
      hrow.appendChild(th);
    });
    var blank = document.createElement("th");
    hrow.appendChild(blank);
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    rows.forEach(function (row, rowIndex) {
      var tr = document.createElement("tr");
      if (noBoxCol) {
        var addTd = document.createElement("td"), addBox = document.createElement("button");
        addBox.type = "button"; addBox.className = "cell et-check";
        addBox.setAttribute("role", "checkbox"); addBox.setAttribute("aria-label", "완료");
        addBox.onclick = function () {
          var name = dataName("완료");
          while (columns.indexOf(name) >= 0) name += "_";
          columns.unshift(name);
          rows.forEach(function (r) { r[name] = "[ ]"; });
          row[name] = "[x]";
          commit(); render();
        };
        addTd.appendChild(addBox); tr.appendChild(addTd);
      }
      columns.forEach(function (column) {
        var td = document.createElement("td");
        var cell = document.createElement("div");
        // #34: a "[ ]" / "[x]" cell is a checkbox; Backspace turns it back into text.
        var box = CHK.exec(String(row[column] || "").trim());
        if (box) {
          var on = !!box[1] && box[1] !== " ";
          cell = document.createElement("button");
          cell.type = "button"; cell.className = "cell et-check" + (on ? " on" : "");
          cell.setAttribute("role", "checkbox"); cell.setAttribute("aria-checked", String(on)); cell.setAttribute("aria-label", column);
          cell.onclick = function () { row[column] = on ? "[ ]" : "[x]"; commit(); render(); };
          cell.onkeydown = function (ev) { if (/^(Backspace|Delete)$/.test(ev.key)) { row[column] = ""; commit(); render(); } };
          td.appendChild(cell); tr.appendChild(td);
          return;
        }
        cell.className = "cell";
        cell.contentEditable = "true";
        cell.textContent = row[column] || "";
        cell.addEventListener("input", function () { row[column] = cell.textContent; commit(); });
        td.appendChild(cell);
        tr.appendChild(td);
      });
      var delTd = document.createElement("td");
      var del = document.createElement("button");
      del.type = "button";
      del.className = "rowdel";
      del.textContent = "✕";
      del.setAttribute("aria-label", "행 지우기");
      del.addEventListener("click", function () {
        rows.splice(rowIndex, 1);
        commit();
        render();
      });
      delTd.appendChild(del);
      tr.appendChild(delTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    var add = document.createElement("div");
    add.className = "dbadd";
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "+ 행 추가";
    addBtn.addEventListener("click", function () {
      var row = {};
      columns.forEach(function (column) { row[column] = ""; });
      rows.push(row);
      commit();
      render();
    });
    var colBtn = document.createElement("button");
    colBtn.type = "button";
    colBtn.textContent = "+ 열 추가";
    colBtn.addEventListener("click", function () {
      var base = dataName("열");
      var n = 2;
      while (columns.indexOf(base + n) >= 0) n += 1;
      columns.push(base + n);
      commit();
      render();
    });
    add.appendChild(addBtn);
    add.appendChild(colBtn);
    wrap.appendChild(add);
    return wrap;
  }

  function featureError(error) { setSave(error.message, true); }
  function openLightbox(src, alt) { lazy("image-tools").then(function (tools) { tools.open(src, alt); }).catch(featureError); }

  function pickFile(accept, cb) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) cb(input.files[0]);
    });
    input.click();
  }


  function uploadInto(block, file) { return lazy("image-tools").then(function (tools) { return tools.uploadInto(block, file, created); }).catch(featureError); }

  function focusedIndex() {
    var row = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".blk") : null;
    return row && row.dataset && row.dataset.index ? Number(row.dataset.index) : -1;
  }

  function handleIncomingFiles(files) {
    var index = focusedIndex();
    var target = null;
    var nextIndex = index;
    if (index >= 0) {
      var current = state.blocks[index];
      if (current && current.type === "image" && !(current.meta && current.meta.src)) {
        target = current;
      } else {
        target = newBlock("image");
        target.meta = { src: "", width: 100 };
        state.blocks.splice(index + 1, 0, target);
        nextIndex = index + 1;
      }
    } else {
      target = newBlock("image");
      target.meta = { src: "", width: 100 };
      state.blocks.push(target);
      nextIndex = state.blocks.length - 1;
    }
    render();
    scheduleSave();
    var row = els.blocks.querySelector('[data-index="' + nextIndex + '"]');
    if (row) row.scrollIntoView({ block: "nearest" });
    uploadInto(target, files[0]);
  }

  els.blocks.addEventListener("paste", function (ev) {
    var files = ev.clipboardData && ev.clipboardData.files;
    if (files && files.length) { ev.preventDefault(); handleIncomingFiles(files); }
  });
  els.blocks.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  els.blocks.addEventListener("drop", function (ev) {
    var files = ev.dataTransfer && ev.dataTransfer.files;
    if (files && files.length) { ev.preventDefault(); handleIncomingFiles(files); }
  });

  function mediaBlock(block, index) {
    var meta = block.meta || (block.meta = {});
    var wrap = document.createElement("div");
    wrap.className = "mediablock mb-" + block.type;

    if (block._busy) {
      var busy = document.createElement("div");
      busy.className = "mbusy";
      busy.textContent = "올리는 중…";
      wrap.appendChild(busy);
      return wrap;
    }

    if (block.type === "image") {
      if (meta.src) {
        var fig = document.createElement("figure");
        fig.className = "img";
        fig.style.width = (Number(meta.width) || 100) + "%";
        var view = document.createElement("a");
        view.className = "imgview";
        view.href = meta.src;
        var img = document.createElement("img");
        img.src = meta.src;
        img.alt = block.text || "이미지";
        img.loading = "lazy";
        img.decoding = "async";
        if (meta.iw > 0 && meta.ih > 0) { img.width = meta.iw; img.height = meta.ih; img.style.height = "auto"; }
        view.appendChild(img);
        view.addEventListener("click", function (ev) { ev.preventDefault(); openLightbox(img.src, img.alt); });
        fig.appendChild(view);
        var cap = document.createElement("figcaption");
        cap.contentEditable = "true";
        cap.spellcheck = false;
        cap.dataset.ph = "캡션 (선택)";
        cap.textContent = block.text || "";
        cap.addEventListener("input", function () { block.text = cap.textContent; scheduleSave(); });
        fig.appendChild(cap);
        var tools = document.createElement("div");
        tools.className = "imgtools";
        var slider = document.createElement("input");
        slider.type = "range";
        slider.min = "10"; slider.max = "100"; slider.step = "5";
        slider.value = String(Number(meta.width) || 100);
        slider.setAttribute("aria-label", "이미지 폭");
        slider.addEventListener("input", function () { meta.width = Number(slider.value); fig.style.width = slider.value + "%"; block.meta = meta; scheduleSave(); });
        tools.appendChild(slider);
        var swap = document.createElement("button");
        swap.type = "button";
        swap.className = "minibtn";
        swap.textContent = "바꾸기";
        swap.addEventListener("click", function () { pickFile("image/*", function (f) { uploadInto(block, f); }); });
        tools.appendChild(swap);
        wrap.appendChild(fig);
        wrap.appendChild(tools);
      } else {
        var tile = document.createElement("button");
        tile.type = "button";
        tile.className = "upload-tile";
        tile.innerHTML = '<span class="big">▣</span><span class="t">이미지 올리기</span><span class="hint">클릭하거나, 끌어다 놓거나 붙여넣기</span>';
        tile.addEventListener("click", function () { pickFile("image/*", function (f) { uploadInto(block, f); }); });
        wrap.appendChild(tile);
      }
      return wrap;
    }

    var row = document.createElement("div");
    row.className = "mbrow";
    var icon = document.createElement("span");
    icon.className = "mico";
    icon.textContent = { video: "▶", audio: "♪", file: "🗎", embed: "⧉", bookmark: "🔖" }[block.type] || "◦";
    row.appendChild(icon);
    var input = document.createElement("input");
    input.type = "text";
    input.className = "murl";
    input.placeholder = { video: "영상 주소 (YouTube·Vimeo·파일)", audio: "소리 파일 주소", file: "파일 주소", embed: "임베드 주소", bookmark: "링크 주소" }[block.type] || "주소";
    input.value = String(meta.url || "");
    input.addEventListener("input", function () { meta.url = input.value.trim(); block.meta = meta; scheduleSave(); });
    row.appendChild(input);
    if (block.type === "video" || block.type === "audio" || block.type === "file") {
      var up = document.createElement("button");
      up.type = "button";
      up.className = "minibtn";
      up.textContent = block.type === "file" ? "파일 올리기" : "파일로 넣기";
      up.addEventListener("click", function () {
        var accept = { video: "video/*", audio: "audio/*", file: "application/pdf,text/plain,image/*" }[block.type] || "*/*";
        pickFile(accept, function (f) { uploadInto(block, f); });
      });
      row.appendChild(up);
    }
    wrap.appendChild(row);
    if (block.type === "embed") wrap.appendChild(embedSizer(block, meta));
    if (block.type === "bookmark") {
      var note = document.createElement("div");
      note.className = "mbnote";
      note.textContent = meta.title ? String(meta.title) + " · " + String(meta.site || "") : "주소를 넣으면 미리보기 정보를 가져와요.";
      wrap.appendChild(note);
      input.addEventListener("change", function () {
        var url = meta.url;
        if (!/^https?:\/\//.test(url)) return;
        note.textContent = "미리보기를 가져오는 중…";
        net("/api/link-preview?url=" + encodeURIComponent(url))
          .then(function (r) { return r.json(); })
          .then(function (body) {
            meta.title = body.title || "";
            meta.description = body.description || "";
            meta.image = body.image || "";
            meta.site = body.site || "";
            note.textContent = meta.title ? String(meta.title) + " · " + String(meta.site || "") : "미리보기 정보가 없어요.";
            block.meta = meta;
            scheduleSave();
          })
          .catch(function () { note.textContent = "미리보기를 가져올 수 없었어요."; });
      });
    }
    return wrap;
  }

  // notion-parity C11: an https embed shows a sandboxed preview with a bottom handle; dragging sets meta.height (120..2000 px,
  // the reader clamps the same way). Acard's own origins are not previewed (block-html.js embedMode refuses them too).
  function embedSizer(block, meta) {
    var box = document.createElement("div");
    box.className = "embed-size";
    if (!/^https:\/\/(?![^/]*(acard\.dev|pages\.dev|localhost)[/:]?)/i.test(meta.url || "")) return box;
    var h = Number(meta.height) || 0;
    box.style.height = (h || 320) + "px";
    var frame = document.createElement("iframe");
    frame.src = meta.url; frame.title = "임베드 미리보기"; frame.loading = "lazy";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
    frame.referrerPolicy = "no-referrer";
    var grip = document.createElement("span");
    grip.className = "embed-grip"; grip.setAttribute("role", "slider"); grip.setAttribute("aria-label", "임베드 높이");
    grip.setAttribute("aria-valuenow", String(h || 320)); grip.tabIndex = 0;
    function set(px) { px = Math.max(120, Math.min(2000, Math.round(px))); box.style.height = px + "px"; grip.setAttribute("aria-valuenow", String(px)); return px; }
    function done(px) { block.meta = Object.assign({}, block.meta, { height: px }); scheduleSave(); }
    grip.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      var y0 = ev.clientY, h0 = box.offsetHeight, px = h0;
      grip.setPointerCapture(ev.pointerId); box.classList.add("sizing");
      function move(e) { px = set(h0 + e.clientY - y0); }
      function up() { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); box.classList.remove("sizing"); done(px); }
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("keydown", function (ev) {
      var d = { ArrowDown: 20, ArrowUp: -20 }[ev.key];
      if (d) { ev.preventDefault(); done(set(box.offsetHeight + d)); }
    });
    box.appendChild(frame); box.appendChild(grip);
    return box;
  }

  function layoutBlock(block, index) {
    var meta = block.meta || (block.meta = {});
    var wrap = document.createElement("div");
    wrap.className = "layoutblock lb-" + block.type;

    if (block.type === "table") {
      wrap.textContent = "표를 불러오는 중…";
      var etRows = block.meta && Array.isArray(block.meta.rows) ? block.meta.rows.length : 2;
      wrap.style.minHeight = (159 + 42 * etRows) + "px";
      lazy("easy-table").then(function (t) { wrap.textContent = ""; t.mount(wrap, block, scheduleSave); wrap.style.minHeight = ""; }, function () { wrap.textContent = "표 편집기를 불러오지 못했어요."; });
      return wrap;
    }

    if (block.type === "equation") {
      var src = document.createElement("textarea");
      src.className = "eqsrc";
      src.rows = 2;
      src.spellcheck = false;
      src.placeholder = "E = mc^2";
      src.value = block.text || "";
      var prev = document.createElement("div");
      prev.className = "eqprev";
      var paint = function () {
        prev.innerHTML = window.EquationHtml ? window.EquationHtml.equationHtml(block.text || "") : "";
      };
      src.addEventListener("input", function () { block.text = src.value; paint(); scheduleSave(); });
      paint();
      wrap.appendChild(prev);
      wrap.appendChild(src);
      return wrap;
    }

    if (block.type === "button") {
      var line = document.createElement("div");
      line.className = "btnline";
      var label = document.createElement("div");
      label.className = "text";
      label.contentEditable = "true";
      label.spellcheck = false;
      label.dataset.ph = "버튼 글자";
      label.textContent = block.text || "";
      label.addEventListener("input", function () { block.text = label.textContent; scheduleSave(); });
      var url = document.createElement("input");
      url.type = "text";
      url.className = "murl";
      url.placeholder = "이동할 주소";
      url.value = String(meta.url || "");
      url.addEventListener("input", function () { meta.url = url.value.trim(); block.meta = meta; scheduleSave(); });
      line.appendChild(label);
      line.appendChild(url);
      var acts = document.createElement("button");
      acts.type = "button";
      acts.className = "minibtn btnacts";
      acts.textContent = "동작 " + (Array.isArray(meta.actions) ? meta.actions.length : 0);
      acts.addEventListener("click", function () { lazy("button-editor").then(function (ed) { ed.open(acts, block, function () { acts.textContent = "동작 " + ((block.meta && block.meta.actions) || []).length; scheduleSave(); }); }); });
      line.appendChild(acts);
      wrap.appendChild(line);
      return wrap;
    }

    if (block.type === "progress") {
      var box = document.createElement("div");
      box.className = "progress " + String(meta.color || "blue");
      var head = document.createElement("div");
      head.className = "phead";
      var label = document.createElement("div");
      label.className = "text";
      label.contentEditable = "true";
      label.spellcheck = false;
      label.dataset.ph = "진행률 라벨";
      label.textContent = block.text || "";
      label.addEventListener("input", function () { block.text = label.textContent; scheduleSave(); });
      var val = document.createElement("span");
      val.className = "pval";
      val.textContent = (Number(meta.value) || 0) + "%";
      head.appendChild(label);
      head.appendChild(val);
      var bar = document.createElement("div");
      bar.className = "pbar";
      var fill = document.createElement("span");
      fill.style.width = (Number(meta.value) || 0) + "%";
      bar.appendChild(fill);
      var tools = document.createElement("div");
      tools.className = "lbtools";
      var range = document.createElement("input");
      range.type = "range";
      range.min = "0"; range.max = "100"; range.step = "5";
      range.value = String(Number(meta.value) || 0);
      range.setAttribute("aria-label", "진행률 값");
      range.addEventListener("input", function () {
        meta.value = Number(range.value);
        val.textContent = range.value + "%";
        fill.style.width = range.value + "%";
        block.meta = meta;
        scheduleSave();
      });
      var color = document.createElement("select");
      color.setAttribute("aria-label", "진행률 색");
      [["blue", "파랑"], ["red", "빨강"], ["green", "초록"], ["orange", "주황"], ["purple", "보라"]].forEach(function (pair) {
        var o = document.createElement("option");
        o.value = pair[0]; o.textContent = pair[1];
        if (pair[0] === (meta.color || "blue")) o.selected = true;
        color.appendChild(o);
      });
      color.addEventListener("change", function () { meta.color = color.value; box.className = "progress " + color.value; block.meta = meta; scheduleSave(); });
      tools.appendChild(range);
      tools.appendChild(color);
      box.appendChild(head);
      box.appendChild(bar);
      wrap.appendChild(box);
      wrap.appendChild(tools);
      return wrap;
    }

    if (block.type === "toc") {
      // The editor draws the same heading list as the reader and repaints it as headings change (#26).
      var nav = document.createElement("nav");
      nav.className = "tocblock";
      nav.setAttribute("aria-label", "목차");
      paintToc(nav);
      wrap.appendChild(nav);
      return wrap;
    }
    var note = document.createElement("div");
    note.className = "lbnote";
    note.textContent = "읽기 화면에서 상위 페이지 경로가 여기에 표시돼요.";
    wrap.appendChild(note);
    return wrap;
  }

  var HEADING_LEVEL = { heading1: 2, heading2: 3, heading3: 4, heading4: 5 };
  function paintToc(nav) {
    // The visuals chunk spreads each HTML block into its headings (ids lead to anchors by its frame) once it has loaded.
    var heads = (window.AcardHtmlHeadings ? window.AcardHtmlHeadings(state.blocks) : state.blocks).filter(function (b) { return HEADING_LEVEL[b.type] && String(b.text || "").trim(); });
    var key = JSON.stringify(heads.map(function (b) { return [b.id, b.type, b.text]; }));
    if (nav.dataset.key === key) return;
    nav.dataset.key = key;
    nav.textContent = "";
    var head = document.createElement("div");
    head.className = "tochead";
    var h = document.createElement("h3");
    h.textContent = "목차";
    head.appendChild(h);
    if (heads.length) { var n = document.createElement("span"); n.className = "tcount"; n.textContent = String(heads.length); head.appendChild(n); }
    nav.appendChild(head);
    var ul = document.createElement("ul");
    heads.forEach(function (b) {
      var li = document.createElement("li");
      li.className = "lvl" + HEADING_LEVEL[b.type];
      var a = document.createElement("a");
      a.href = "#block-" + b.id;
      a.textContent = b.text;
      a.addEventListener("click", function (ev) { ev.preventDefault(); var row = document.getElementById("block-" + b.id); if (row) { row.scrollIntoView({ block: "center" }); focusBlock(b.id); } });
      li.appendChild(a);
      ul.appendChild(li);
    });
    if (!heads.length) { var empty = document.createElement("li"); empty.className = "tempty"; empty.textContent = "아래에 제목이 없어요"; ul.appendChild(empty); }
    nav.appendChild(ul);
  }
  function paintTocs() {
    Array.prototype.forEach.call(els.blocks.querySelectorAll(".lb-toc .tocblock"), paintToc);
  }

  // The slash item 하위 페이지 makes a child page under this one, linked from the block where the slash was typed (#26).
  // The link is a normal paragraph with a page mention, so the reader, export and backlinks already understand it.
  function subpageLink(block, page) {
    block.type = "paragraph";
    block.text = page.title;
    block.meta = { subpage: page.slug, richText: [{ text: page.title, mention: { type: "page", slug: page.slug } }] };
  }
  function createSubpage(block) {
    block.text = "";
    if (block.meta) delete block.meta.richText;
    render();
    setSave("하위 페이지 만드는 중…", true);
    var id = block.id;
    api("/pages", { method: "POST", body: JSON.stringify({ title: "제목 없음", parent: slug }) }).then(function (page) {
      // By id: the new page's live notice can make live.js swap state.blocks for a fresh server copy before this returns.
      var at = state.blocks.findIndex(function (b) { return b.id === id; });
      if (at < 0) { at = state.blocks.length; state.blocks.push(newBlock()); state.blocks[at].id = id; }
      block = state.blocks[at];
      subpageLink(block, { slug: page.slug, title: page.title || "제목 없음" });
      var next = newBlock();
      state.blocks.splice(model.endOf(state.blocks, at), 0, next);
      render();
      focusBlock(next.id);
      scheduleSave();
      refreshTree();
    }).catch(function (error) { setSave("하위 페이지를 만들지 못했어요: " + error.message, true); });
  }
  function subpagesOf(blocks) {
    var out = {};
    blocks.forEach(function (b) { if (b.meta && b.meta.subpage) out[b.meta.subpage] = true; });
    return out;
  }
  // Undo of a 하위 페이지 insert puts the new page in the trash; redo brings it back.
  // One queue: a quick Ctrl+Z then Ctrl+Shift+Z must reach the server as trash then restore, never restore first.
  var subpageQueue = Promise.resolve();
  function syncSubpages(before, after) {
    var steps = [];
    Object.keys(before).forEach(function (s) { if (!after[s]) steps.push([s, "trash"]); });
    Object.keys(after).forEach(function (s) { if (!before[s]) steps.push([s, "restore"]); });
    if (!steps.length) return;
    steps.forEach(function (step) {
      subpageQueue = subpageQueue.then(function () {
        return api("/page/" + encodeURIComponent(step[0]) + "/" + step[1], { method: "POST", body: "{}" })
          .catch(function (error) { setSave("하위 페이지를 정리하지 못했어요: " + error.message, true); });
      });
    });
    subpageQueue = subpageQueue.then(refreshTree);
  }
  function refreshTree() {
    loadTree();
    document.dispatchEvent(new CustomEvent("acard:tree-fresh"));
  }
  // A child renamed on its own page shows the new title here the next time the tree is read.
  function syncSubpageTitles() {
    var titles = {};
    state.pages.forEach(function (p) { titles[p.slug] = p.title; });
    var changed = false;
    state.blocks.forEach(function (b) {
      var s = b.meta && b.meta.subpage;
      if (s && titles[s] && titles[s] !== b.text) { subpageLink(b, { slug: s, title: titles[s] }); changed = true; }
    });
    if (!changed) return;
    render();
    previousSnapshot = snapshot();
    state.dirty = true;
    save().catch(function () {});
  }

  var slashIndex = -1;
  var slashSel = 0;

  var slashItems = [];

  function openSlash(anchor, index, query) {
    slashIndex = index;
    slashSel = 0;
    // The lazy easy-insert chunk draws the grouped menu with previews; this plain list is only the first-keystroke fallback.
    if (easy && easy.menu) { slashItems = easy.menu(els.slash, BLOCK_TYPES.concat(componentItems), query || "", anchor, applySlash); return; }
    slashItems = slashMatches(query);
    var rect = anchor.getBoundingClientRect();
    els.slash.style.left = Math.min(rect.left, window.innerWidth - 280) + "px";
    els.slash.style.top = Math.min(rect.bottom + 6, window.innerHeight - 330) + "px";
    els.slash.innerHTML = "<h3>블록 고르기</h3>";
    slashItems.forEach(function (entry, i) {
      var button = document.createElement("button");
      button.type = "button";
      button.dataset.i = String(i);
      if (i === 0) button.className = "sel";
      button.innerHTML = '<span class="ico">' + entry.ico + "</span><span>" + entry.label + "</span><span class=\"k\">" + entry.hint + "</span>";
      button.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        applySlash(entry.type);
      });
      els.slash.appendChild(button);
    });
    els.slash.hidden = false;
  }

  function hideSlash() {
    els.slash.hidden = true;
    slashIndex = -1;
  }
  // The gutter "+" opens the insert menu through easy-insert; load it while the pointer is on the way.
  els.blocks.addEventListener("pointerover", function (ev) { if (!easy && ev.target.closest(".gutter")) loadEasy(); });

  function applySlash(type) {
    var index = slashIndex;
    hideSlash();
    if (index < 0) return;
    var block = state.blocks[index];
    if (!block) return;
    if (type === "subpage") {
      if (easy) easy.remember(type);
      createSubpage(block);
      return;
    }
    if (type === "columns") {
      // /열 나누기 makes two columns with an empty paragraph each, at the nearest depth columns may sit at.
      if (easy) easy.remember(type);
      var made = cm.newColumns(model.depth(block), 2, newBlock);
      var empty = !block.text || /^\/[^\s/]{0,12}$/.test(block.text);
      state.blocks.splice.apply(state.blocks, [empty ? index : index + 1, empty ? 1 : 0].concat(made));
      render(); focusBlock(made[2].id); scheduleSave();
      return;
    }
    if (easy && easy.apply(block, type)) return;
    var ui = /^component:([a-z][a-z0-9-]{1,39})$/.exec(type);
    if (ui) {
      if (easy) easy.remember(type);
      block.type = "component";
      block.meta = { ui: ui[1] };
      block.text = "";
      render(); scheduleSave();
      return;
    }
    var th = /^toggle_(heading[1-3])$/.exec(type);
    if (th) { type = th[1]; block.meta = Object.assign({}, block.meta, { toggle: true, open: true }); }
    block.type = type;
    if (type === "db_ref") {
      var target = window.prompt("연결할 데이터베이스 슬러그 (예: mcp-master-facet)");
      if (!target || !target.trim()) { block.type = "paragraph"; return; }
      block.meta = { database: target.trim() };
      block.text = "";
    }
    if (easy) easy.remember(type);
    if (/^\/[^\s/]{0,12}$/.test(block.text)) { block.text = ""; if (block.meta) delete block.meta.richText; }
    if (type === "database") {
      block.meta = { columns: dbCols(), rows: [], view: "table" };
      block.text = "";
    } else if (BLOCK_DEFAULTS[type]) {
      block.meta = BLOCK_DEFAULTS[type]().meta;
    } else if (MEDIA_TYPES[type] || type === "toc" || type === "breadcrumb") {
      block.text = "";
    }
    render();
    if (type !== "divider" && type !== "database" && !MEDIA_TYPES[type] && type !== "toc" && type !== "breadcrumb") focusBlock(block.id);
    scheduleSave();
  }

  document.addEventListener("keydown", function (ev) {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (coreEditing && selectedIds.size && window.AcardEditor.commands?.blockKey?.(ev)) return;
    if (selectedIds.size && (ev.key === "Delete" || ev.key === "Backspace") && !ev.target.closest('[contenteditable="true"],input,textarea')) {
      ev.preventDefault();
      var remove = new Set();
      state.blocks.forEach(function (block, index) { if (selectedIds.has(block.id)) for (var i = index; i < model.endOf(state.blocks, index); i += 1) remove.add(state.blocks[i].id); });
      state.blocks = state.blocks.filter(function (block) { return !remove.has(block.id); }); selectedIds.clear(); render(); scheduleSave(); undoToast("블록 " + remove.size + "개를 지웠어요"); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) restoreEdit(redoStack, undoStack); else restoreEdit(undoStack, redoStack);
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") { ev.preventDefault(); restoreEdit(redoStack, undoStack); return; }
    if (els.slash.hidden) return;
    var buttons = Array.prototype.slice.call(els.slash.querySelectorAll("button"));
    // Hover on desktop moves the highlight too, so the keyboard continues from the highlighted item.
    var at = buttons.findIndex(function (button) { return button.classList.contains("sel"); });
    if (at >= 0) slashSel = at;
    if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && buttons.length) {
      ev.preventDefault();
      slashSel = (slashSel + (ev.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      if (easy && easy.select) easy.select(els.slash, slashSel);
      else buttons.forEach(function (button, i) { button.classList.toggle("sel", i === slashSel); });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      var entry = slashItems[slashSel];
      if (entry) applySlash(entry.type);
    } else if (ev.key === "Escape") {
      hideSlash();
    }
  });

  function openCtx(anchor, index) {
    lazy("legacy-block-menu").then(function (menu) {
      menu.open(anchor, index, { els, state, slug, move, indent, duplicate, undoToast, setSave, openSlash, cm, moveToColumn, render, scheduleSave, lazy, pageContext, model });
    }).catch(featureError);
  }

  function duplicate(index) {
    var copies = JSON.parse(JSON.stringify(state.blocks.slice(index, model.endOf(state.blocks, index))));
    copies.forEach(function (copy) { copy.id = uid(); });
    state.blocks.splice.apply(state.blocks, [model.endOf(state.blocks, index), 0].concat(copies));
    render();
    scheduleSave();
    return copies[0];
  }

  // Ctrl/Cmd+Shift+Up/Down: past the previous / next sibling only, so a first or last child stays in its parent.
  function moveSibling(index, delta) {
    var depth = model.depth(state.blocks[index]);
    var target = delta < 0 ? index - 1 : model.endOf(state.blocks, index);
    while (delta < 0 && target >= 0 && model.depth(state.blocks[target]) > depth) target -= 1;
    if (target < 0 || target >= state.blocks.length || model.depth(state.blocks[target]) !== depth) return;
    if (delta > 0) target = model.endOf(state.blocks, target);
    if (!model.move(state.blocks, index, target, depth)) return;
    render();
    scheduleSave();
  }

  function move(index, delta) {
    var target = delta < 0 ? index - 1 : model.endOf(state.blocks, index);
    if (target < 0 || target >= state.blocks.length) return;
    if (delta > 0) target = model.endOf(state.blocks, target);
    if (!model.move(state.blocks, index, target, model.depth(state.blocks[index]))) return;
    render();
    scheduleSave();
  }

  function indent(index, delta) {
    if (!cm.canIndent(state.blocks, index, delta) || !model.indent(state.blocks, index, delta)) return;
    render();
    scheduleSave();
  }

  function moveSelection(index, target, targetDepth) {
    if (!selectedIds.has(state.blocks[index].id) || selectedIds.size < 2) return model.move(state.blocks, index, target, targetDepth);
    var roots = [], covered = new Set();
    state.blocks.forEach(function (block, i) {
      if (!selectedIds.has(block.id) || covered.has(i)) return;
      var end = model.endOf(state.blocks, i);
      roots.push({ start: i, end: end, blocks: state.blocks.slice(i, end) });
      for (var n = i; n < end; n += 1) covered.add(n);
    });
    if (covered.has(target)) return false;
    var position = target - Array.from(covered).filter(function (i) { return i < target; }).length;
    var remaining = state.blocks.filter(function (_block, i) { return !covered.has(i); });
    var max = position ? model.depth(remaining[position - 1]) + 1 : 0;
    var depth = Math.min(targetDepth, max), moving = [];
    roots.forEach(function (branch) { var offset = depth - model.depth(branch.blocks[0]); branch.blocks.forEach(function (block) { block.indent = model.depth(block) + offset; moving.push(block); }); });
    remaining.splice.apply(remaining, [position, 0].concat(moving)); state.blocks = remaining; return true;
  }

  function wireDrag(handle, row, block) {
    var start = null, target = null, dragged = false;
    handle.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      start = { x: ev.clientX, y: ev.clientY };
      dragged = false;
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener("pointermove", function (ev) {
      if (!start || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      dragged = true;
      row.classList.add("dragging");
      aim(ev);
      // M07 edge autoscroll lives in the lazy block-commands chunk (core editing).
      window.AcardEditor.commands?.dragEdge?.({ clientX: ev.clientX, clientY: ev.clientY }, aim, function () { return !!start; });
    });
    function aim(ev) {
      if (target) target.classList.remove("drop-before", "drop-after", "drop-into");
      var hit = document.elementFromPoint(ev.clientX, ev.clientY);
      target = hit && hit.closest(".blk");
      if (!target || target === row || row.contains(target)) { target = null; return; }
      // A column row itself (its empty space or border) takes the block at the end of that column (notion-parity C13).
      if (target.classList.contains("colcell")) { target.classList.add("drop-into"); return; }
      var rect = target.getBoundingClientRect();
      target.classList.add(ev.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
    }
    function finish(ev) {
      row.classList.remove("dragging");
      if (target) {
        var index = state.blocks.findIndex(function (item) { return item.id === block.id; });
        var destination = Number(target.dataset.index);
        var after = target.classList.contains("drop-after");
        var into = target.classList.contains("drop-into");
        var targetDepth = model.depth(state.blocks[destination]) + (into ? 1 : 0);
        target.classList.remove("drop-before", "drop-after", "drop-into");
        if (ev.type !== "pointercancel") {
          if (coreEditing) runBlockCommand("dropBlocks", [selectedIds.has(block.id) ? Array.from(selectedIds) : [block.id], state.blocks[destination].id, into ? "parentId" : after ? "afterId" : "beforeId"]);
          else if (moveSelection(index, after || into ? model.endOf(state.blocks, destination) : destination, targetDepth)) { render(); scheduleSave(); }
        }
      }
      start = null; target = null;
    }
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("click", function (ev) { if (dragged) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
  }

  // Right-click tools (lazy context-menu chunk): the first right-click on a block loads it and opens there; the chunk then
  // takes every later one. Shift+right-click keeps the browser menu. Shift+F10 / the menu key work the same way.
  function humanEdit() { return document.documentElement.getAttribute("data-human-edit") === "on"; }
  function firstMenu(ev, x, y) {
    if (!humanEdit() || (window.AcardEditor.contextMenu && window.AcardEditor.contextMenu.openAt)) return;
    var target = ev.target.nodeType === 1 ? ev.target : ev.target.parentElement;
    if (!target || !target.closest("#blocks .blk[data-id]") || target.closest("input, textarea, select, iframe")) return;
    ev.preventDefault();
    lazy("context-menu").then(function (menu) { menu.openAt(target, x, y); }, function () {});
  }
  els.blocks.addEventListener("contextmenu", function (ev) { if (!ev.shiftKey) firstMenu(ev, ev.clientX, ev.clientY); });
  els.blocks.addEventListener("keydown", function (ev) {
    if (!((ev.key === "F10" && ev.shiftKey) || ev.key === "ContextMenu")) return;
    var rect = ev.target.getBoundingClientRect();
    firstMenu(ev, rect.left + 24, rect.top + 24);
  });

  document.addEventListener("click", function (ev) {
    if (!els.slash.hidden && !els.slash.contains(ev.target) && !els.ctx.contains(ev.target)) hideSlash();
    if (!els.ctx.hidden && !els.ctx.contains(ev.target)) els.ctx.hidden = true;
  });

  function loadTree() {
    return api("/tree").then(function (data) {
      state.pages = data.pages || [];
      renderTree();
      syncSubpageTitles();
    }).catch(function () {});
  }

  function renderTree() {
    var known = {};
    state.pages.forEach(function (page) { known[page.slug] = true; });
    var roots = state.pages.filter(function (page) { return !page.parent || !known[page.parent]; });
    els.tree.innerHTML = "";
    var favorites = state.pages.filter(function (page) { return page.favorite; });
    if (favorites.length) {
      var heading = document.createElement("h3"); heading.textContent = "즐겨찾기"; els.tree.appendChild(heading);
      els.tree.appendChild(treeList(favorites, true));
    }
    els.tree.appendChild(treeList(roots));
  }

  function treeList(pages, flat) {
    var ul = document.createElement("ul");
    ul.className = "tree";
    pages.forEach(function (page) {
      var li = document.createElement("li");
      var row = document.createElement("div");
      row.className = "row";
      var link = document.createElement("a");
      link.href = "/edit/" + encodeURIComponent(page.slug) + "/";
      link.textContent = (page.icon && !/^\/media\//.test(page.icon) ? page.icon + " " : "") + page.title;
      if (page.slug === slug) link.className = "on";
      if (page.kind === "db") {
        var mark = document.createElement("span");
        mark.className = "dbmark";
        mark.textContent = "표";
        link.appendChild(mark);
      }
      var more = document.createElement("button");
      more.type = "button";
      more.className = "more";
      more.textContent = "⋯";
      more.setAttribute("aria-label", "페이지 메뉴");
      // The document click handler closes the menu, so this click must not reach it (same as the block menu).
      more.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); pageMenu(more, page); });
      row.appendChild(link);
      row.appendChild(more);
      li.appendChild(row);
      var children = state.pages.filter(function (child) { return child.parent === page.slug; });
      if (children.length && !flat) li.appendChild(treeList(children));
      ul.appendChild(li);
    });
    return ul;
  }

  function pageMenu(anchor, page) {
    lazy("editor-page-menu").then(function (menu) {
      menu.open(anchor, page, { els: els, state: state, slug: slug, api: api, loadTree: loadTree, renderTree: renderTree, setSave: setSave });
    }).catch(featureError);
  }

  function loadBacklinks() {
    return api("/backlinks?slug=" + encodeURIComponent(slug)).then(function (data) {
      var list = data.backlinks || [];
      if (!list.length) { els.backlinks.hidden = true; return; }
      els.backlinks.innerHTML = "<h3>이 페이지를 가리키는 곳</h3>";
      list.forEach(function (entry) { var a = document.createElement("a"); a.href = "/edit/" + encodeURIComponent(entry.slug) + "/"; a.textContent = entry.title || entry.slug; els.backlinks.appendChild(a); });
      els.backlinks.hidden = false;
    }).catch(function () {});
  }

  els.title.addEventListener("input", function () { state.title = els.title.value; scheduleSave(); });
  // editor.html focuses a new page's title before this script loads; an Enter pressed in that gap is held there
  // (data-enter-pending) and finished here, so typing straight on goes to the body instead of the title (#80).
  window.AcardTitleKeys = true;
  els.title.addEventListener("keydown", function (ev) {
    if (ev.isComposing || ev.keyCode === 229 || els.blocks.hidden) return;
    if (ev.key !== "Enter" && !(ev.key === "ArrowDown" && els.title.selectionStart === els.title.value.length && els.title.selectionEnd === els.title.value.length)) return;
    ev.preventDefault();
    titleToBody();
  });
  function titleToBody() {
    var text = els.blocks.querySelector('[contenteditable="true"]');
    if (!text) {
      state.blocks.unshift(newBlock());
      render();
      scheduleSave();
      text = els.blocks.querySelector('[contenteditable="true"]');
    }
    text.focus();
    var range = document.createRange();
    range.selectNodeContents(text);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  document.getElementById("add-block").addEventListener("click", function () {
    var block = newBlock();
    state.blocks.push(block);
    render();
    focusBlock(block.id);
    scheduleSave();
  });

  // New pages open untitled with the cursor in the title field (no blocking window.prompt - #18).
  function newPage() {
    location.href = "/edit/" + ("page-" + Math.random().toString(36).slice(2, 8)) + "/?new&create";
  }
  document.getElementById("new-page").addEventListener("click", newPage);

  els.menu.addEventListener("click", function () {
    var open = els.sidebar.classList.toggle("open");
    els.menu.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // Desktop sidebar collapse, same key as the reader (app.js); #side-open brings it back (#27).
  var SIDE_KEY = "dori-notes-sidebar:" + identity, sideCollapse = document.getElementById("collapse"), sideOpen = document.getElementById("side-open");
  function paintSide(c) {
    document.documentElement.classList.toggle("side-collapsed", c);
    if (sideCollapse) sideCollapse.setAttribute("aria-expanded", c ? "false" : "true");
  }
  function toggleSide() {
    var c = !document.documentElement.classList.contains("side-collapsed"), a = document.activeElement;
    try { if (identity) localStorage.setItem(SIDE_KEY, c ? "1" : "0"); } catch (e) {}
    paintSide(c);
    if (a === sideCollapse || a === sideOpen) (c ? sideOpen : sideCollapse).focus();
  }
  try { paintSide(localStorage.getItem(SIDE_KEY) === "1"); } catch (e) {}
  if (sideCollapse) sideCollapse.addEventListener("click", toggleSide);
  if (sideOpen) sideOpen.addEventListener("click", toggleSide);
  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "\\") { ev.preventDefault(); toggleSide(); }
  });

  // --- 더보기 메뉴 ---
  var moreBtn = document.getElementById("more");
  var moreMenu = document.getElementById("more-menu");
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener("click", function () {
      var open = moreMenu.hidden;
      moreMenu.hidden = !open;
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", function (ev) {
      if (moreMenu.hidden) return;
      if (!moreBtn.contains(ev.target) && !moreMenu.contains(ev.target)) {
        moreMenu.hidden = true;
        moreBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  // --- 키보드 단축키 ---
  var shortcutsEl = document.getElementById("shortcuts");
  var shortcutsOpen = document.getElementById("shortcuts-open");
  var shortcutsClose = document.getElementById("shortcuts-close");
  if (shortcutsOpen) shortcutsOpen.addEventListener("click", function () {
    if (moreMenu) moreMenu.hidden = true;
    shortcutsEl.hidden = false;
    var close = document.getElementById("shortcuts-close");
    if (close) close.focus({ preventScroll: true });
  });
  if (shortcutsClose) shortcutsClose.addEventListener("click", function () { shortcutsEl.hidden = true; });
  if (shortcutsEl) shortcutsEl.addEventListener("mousedown", function (ev) {
    if (ev.target === shortcutsEl) shortcutsEl.hidden = true;
  });

  // --- 빠른 검색 팔레트 ---
  var palette = document.getElementById("palette"), paletteFeature, paletteRequest = 0, paletteOpening = false;
  function openPalette() {
    if (!palette) return;
    var request = ++paletteRequest;
    paletteOpening = true;
    lazy("page-search").then(function (feature) {
      paletteFeature = feature;
      if (request === paletteRequest) { paletteOpening = false; feature.open(net, identity); }
    }, function (error) {
      if (request === paletteRequest) { closePalette(); setSave(error.message || String(error), true); }
    });
  }
  function closePalette() {
    paletteRequest++; paletteOpening = false;
    if (paletteFeature) paletteFeature.close(); else if (palette) palette.hidden = true;
  }
  var paletteOpenBtn = document.getElementById("palette-open");
  if (paletteOpenBtn) paletteOpenBtn.addEventListener("click", openPalette);

  // --- 전역 단축키 ---
  document.addEventListener("keydown", function (ev) {
    var mod = ev.ctrlKey || ev.metaKey;
    // 블록 서식: Ctrl/Cmd + B(굵게) / I(기울임) / U(밑줄) / Shift+U(취소선) / E(코드)
    var sel = mod && /^[biueBIUE]$/.test(ev.key) && window.getSelection();
    var inText = sel && sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest(".text");
    if (inText) {
      ev.preventDefault();
      if (ev.key === "b" || ev.key === "B") document.execCommand("bold");
      else if (ev.key === "i" || ev.key === "I") document.execCommand("italic");
      else if (ev.key === "u" || ev.key === "U" && ev.shiftKey) document.execCommand("strikeThrough");
      else if (ev.key === "u" || ev.key === "U") document.execCommand("underline");
      else if (ev.key === "e" || ev.key === "E") document.execCommand("insertHTML", false, "<code>" + (sel.toString() || "코드") + "</code>");
      scheduleSave();
      return;
    }
    // Ctrl/Cmd + N: 새 페이지
    if (mod && (ev.key === "n" || ev.key === "N")) {
      ev.preventDefault();
      newPage();
      return;
    }
    if (mod && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      if (paletteOpening || !palette.hidden) closePalette(); else openPalette();
      return;
    }
    if (mod && ev.key === "/") {
      ev.preventDefault();
      if (!shortcutsEl.hidden) shortcutsEl.hidden = true; else shortcutsEl.hidden = false;
      return;
    }
    if (ev.key === "Escape") {
      closePalette();
      shortcutsEl.hidden = true;
      if (moreMenu) moreMenu.hidden = true;
    }
  });

  document.getElementById("theme").addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme") || "auto";
    var next = current === "auto" ? "dark" : current === "dark" ? "light" : "auto";
    document.documentElement.setAttribute("data-theme", next);
    try { if (identity) localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });

  function beforeUnload(ev) {
    if (!state.dirty) return;
    save().catch(function (error) { setSave("저장 실패: " + error.message, true); });
    ev.preventDefault();
    ev.returnValue = "";
  }

  var previewHash;
  var startupEdited = false;
  function previewPage(data) {
    if (startupEdited) return;
    previewHash = JSON.stringify(data);
    state.title = data.page.title;
    state.blocks = data.blocks || [];
    els.title.value = state.title;
    render();
  }
  // Seed sync takes seconds and rarely changes anything; load the page now and refetch only if sync imported or updated pages.
  var pageUrl = "/page/" + encodeURIComponent(slug);
  var synced = api("/sync", { method: "POST" }).catch(function () { return null; });
  // ?create (editor.html focuses the title first): create the page here; saves wait for it (#30).
  var params = new URLSearchParams(location.search), fresh = params.has("create");
  var created = fresh ? api("/pages", { method: "POST", body: JSON.stringify({ title: "제목 없음", slug: slug, parent: params.get("parent") || null }) }).then(function (page) {
    if (page.slug !== slug) { location.replace("/edit/" + encodeURIComponent(page.slug) + "/?new"); throw Error("moved"); }
    history.replaceState(history.state, "", location.pathname + "?new");
    loadTree();
    return page.page;
  }) : Promise.resolve();
  var serverPage = (fresh ? created : api(pageUrl)).then(function (data) {
    state.baseUpdated = data.page.updated;
    window.AcardEditor.base = { title: data.page.title, blocks: JSON.parse(JSON.stringify(data.blocks || [])), updated: data.page.updated };
    return data;
  });
  if (fresh) {
    state.title = els.title.value || "제목 없음";
    state.blocks = [{ id: "b1", type: "paragraph", text: "", checked: false, indent: 0, meta: null }];
    render();
    if (els.title.dataset && els.title.dataset.enterPending) { delete els.title.dataset.enterPending; titleToBody(); }
    else els.title.focus();
    if (state.title !== "제목 없음") scheduleSave();
  }
  loadTree();
  synced.then(function (sync) {
    if (!sync || !(sync.imported || sync.updated)) return;
    loadTree();
    // A seed update can rewrite this page; take the new copy only if the owner has not typed yet.
    serverPage.then(function (first) { return api(pageUrl).then(function (next) { if (!state.dirty && JSON.stringify(next) !== JSON.stringify(first)) location.reload(); }); }).catch(function () {});
  });
  serverPage.catch(function () {});
  new Promise(function (resolve) {
    document.addEventListener("DOMContentLoaded", resolve, { once: true });
  }).then(function () {
    if (fresh) return serverPage;
    return lazy("recent-cache").then(function (cache) {
      return cache.load(serverPage, previewPage, function (data) { state.pages = data.pages || []; renderTree(); });
    }, function () { return serverPage; });
  })
    .then(function (data) {
      // Cache preview and network completion may straddle an edit, even its acknowledgement.
      // A startup snapshot is not newer typing and must never become a rebased draft.
      if (fresh || startupEdited) { data = Object.assign({}, data, { page: Object.assign({}, data.page, { title: state.title }), blocks: state.blocks }); previewHash = JSON.stringify(data); }
      state.title = data.page.title;
      state.kind = data.page.kind;
      state.dbRow = data.dbRow || null;
      var same = previewHash === JSON.stringify(data) && state.blocks.length;
      if (!same) state.blocks = (data.blocks || []).length ? data.blocks : [newBlock()];
      previousSnapshot = snapshot();
      els.title.value = state.title;
      els.title.placeholder = "제목 없음";
      els.title.removeAttribute("aria-busy");
      els.title.readOnly = false;
      if (fresh) els.title.value = state.title === "제목 없음" ? "" : state.title;
      else if (/[?&]new(&|=|$)/.test(location.search) && state.title === "제목 없음") {
        els.title.value = "";
        els.title.focus();
      }
      document.getElementById("viewlink").href = "/" + (slug === "index" ? "home" : slug) + "/";
      document.title = state.title + " 고치기 · " + window.DoriSite.name;
      els.meta.textContent = (data.page.source === "markdown" ? "AI가 쓴 페이지" : "직접 고친 페이지") + " · 블록 " + state.blocks.length + "개";
      if (!same) render();
      if (state.kind === "db" && typeof window.DoriDB?.load === "function") {
        els.blocks.hidden = true;
        document.getElementById("add-block").hidden = true;
        var dbRoot = document.createElement("div");
        dbRoot.id = "db-root";
        els.blocks.parentNode.insertBefore(dbRoot, els.blocks);
        window.DoriDB.load(slug, { initial: data.database, mountId: "db-root", titleInput: els.title });
      } else if (state.dbRow && data.database && typeof window.DoriDB?.loadRow === "function") {
        var rowProps = document.createElement("div");
        rowProps.id = "db-row-props";
        els.blocks.parentNode.insertBefore(rowProps, els.blocks);
        window.DoriDB.loadRow(data.database.database.slug, state.dbRow, "db-row-props", { initial: data.database });
      }
      pageContext = { api: api, slug: slug, state: state, save: save, setSave: setSave, loadTree: loadTree };
      window.mountEditorPages(pageContext);
      formatContext = { state: state, scheduleSave: scheduleSave };
      window.mountEditorFormat(formatContext);
      if (location.hash.indexOf("#block-") === 0) {
        var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target) { var parent = target.parentElement; while (parent) { parent.classList.remove("collapsed"); parent = parent.parentElement; } target.scrollIntoView(); }
      }
      loadBacklinks();
      setSave("저장됨", false);
      featureReady = true;
      emitFeature("ready", window.AcardEditor);
      if (coreEditing) lazy("synced-blocks").catch(featureError);
    })
    .catch(function (error) {
      setSave(state.cacheLocked && !navigator.onLine ? "오프라인 · 읽기 전용. 다시 연결한 뒤 새로고침해 주세요." : "불러오기 실패: " + error.message, true);
    });
})();
