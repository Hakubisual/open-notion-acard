// Right-click tool menu (acard-human-edit, design/human-edit/ref-menu-block.png and ref-menu-selection.png).
// Right-click on a block = that block's tools; right-click on dragged text = tools for that piece only. Shift+right-click
// keeps the browser's own menu. Shift+F10 / the context-menu key opens it at the caret; the block handle and a long press
// (phones) open the block menu. Other features add items with AcardEditor.contextMenu.register(item).
(function () {
  "use strict";
  var editor = window.AcardEditor;
  if (!editor) return;
  var registry = [];
  var box = null, sub = null, back = null, current = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var ICON = {
    turn: "M4 6h16M4 12h10M4 18h6", color: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.9-.6-1.4-.6-2.2 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.7-9-8.7z",
    copy: "M8 8h11v11H8zM5 16V5h11", up: "M12 19V5M5 12l7-7 7 7", down: "M12 5v14M5 12l7 7 7-7", link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    comment: "M4 5h16v11H9l-5 4z", spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", pen: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3", ref: "M14 3H6v18h12V7zM14 3v4h4",
    short: "M4 8h16M4 16h9", table: "M4 5h16v14H4zM4 10h16M10 5v14", chart: "M5 20V10M10 20V4M15 20v-7M20 20v-11", flow: "M6 6h4v4H6zM14 14h4v4h-4zM8 10v6h6",
    indent: "M4 6h16M10 12h10M4 18h16M4 10l3 2-3 2"
  };
  function icon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "cm-ico"); svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON[name] || ""); svg.appendChild(path);
    return svg;
  }

  function close(restore) {
    if (sub) { sub.remove(); sub = null; }
    if (!box) return;
    box.remove(); box = null;
    document.body.classList.remove("cm-open");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("scroll", onScroll, true);
    if (restore !== false && back && back.focus) back.focus();
    var closed = current; current = null;
    if (closed && closed.onClose) closed.onClose();
  }
  function outside(ev) { if (box && !box.contains(ev.target) && !(sub && sub.contains(ev.target))) close(false); }
  function onScroll() { close(false); }

  function place(menu, x, y) {
    document.body.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + "px";
  }

  function marksUi() { return editor.lazy("ai-marks-ui"); }
  function blockById(id) { return editor.state.blocks.find(function (b) { return b.id === id; }); }
  function markOf(id) { var b = blockById(id), doc = document.getElementById("doc"); return b && window.AiMarks ? window.AiMarks.effective(b, (doc && doc.dataset.aiDefault) || "edit") : "edit"; }
  function rowOf(id) { return document.querySelector('#blocks .blk[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); }

  var BUILTIN = [
    { id: "turn", scope: "block", group: "edit", label: "종류 바꾸기", icon: "turn", sub: true, run: function (c) { editor.commands.turnInto(c.blockId, c.anchor); } },
    { id: "color", scope: "block", group: "edit", label: "색", icon: "color", sub: true, run: function (c) { editor.commands.color(c.blockId, c.anchor); } },
    { id: "dup", scope: "block", group: "move", label: "복제", icon: "copy", shortcut: "Ctrl+D", run: function (c) { var b = editor.commands.duplicate(c.blockId); if (b) editor.commands.focus(b.id); } },
    { id: "up", scope: "block", group: "move", label: "위로 옮기기", icon: "up", shortcut: "Ctrl+Shift+↑", run: function (c) { editor.commands.move(c.blockId, -1); } },
    { id: "down", scope: "block", group: "move", label: "아래로 옮기기", icon: "down", shortcut: "Ctrl+Shift+↓", run: function (c) { editor.commands.move(c.blockId, 1); } },
    { id: "link", scope: "block", group: "move", label: "블록 링크 복사", icon: "link", run: function (c) { return editor.commands.copyLink(c.blockId).then(function () { editor.setSave("블록 링크 복사됨", false); }); } },
    { id: "comment", scope: "block", group: "move", label: "댓글", icon: "comment", run: function (c) { editor.commands.comment(c.blockId); } },
    { id: "marks", scope: "block", group: "ai", label: "AI 표시", icon: "spark", radio: true },
    { id: "del", scope: "block", group: "danger", label: "삭제", icon: "trash", shortcut: "Del", danger: true, run: function (c) { editor.commands.remove(c.blockId); } },
    { id: "s-lock", scope: "selection", group: "marks", label: "이 부분 고정", icon: "lock", run: function (c) { return marksUi().then(function (m) { m.setRange(c.blockId, c.selection.start, c.selection.end, "lock"); }); } },
    { id: "s-ref", scope: "selection", group: "marks", label: "이 부분 참고", icon: "ref", run: function (c) { return marksUi().then(function (m) { m.setRange(c.blockId, c.selection.start, c.selection.end, "ref"); }); } },
    { id: "s-clear", scope: "selection", group: "marks", label: "이 부분 표시 풀기", icon: "pen", when: function (c) { return hasSpan(c); }, run: function (c) { return marksUi().then(function (m) { m.setRange(c.blockId, c.selection.start, c.selection.end, "edit"); }); } }
  ];
  var GROUP_TITLE = { ai: "AI", marks: "AI 표시", plugin: "플러그인" };
  var ORDER = ["format", "edit", "move", "ai", "marks", "insert", "plugin", "danger"];

  function hasSpan(c) {
    var b = blockById(c.blockId);
    return !!(b && window.AiMarks && window.AiMarks.spans(b).some(function (s) { return s[0] < c.selection.end && s[0] + s[1] > c.selection.start; }));
  }

  function items(ctx) {
    return BUILTIN.concat(registry).filter(function (item) {
      if (item.scope !== ctx.scope) return false;
      try { return !item.when || item.when(ctx); } catch (_) { return false; }
    }).sort(function (a, b) { return ORDER.indexOf(a.group || "plugin") - ORDER.indexOf(b.group || "plugin"); });
  }

  function menuButton(item, ctx) {
    var b = el("button", "cm-item" + (item.danger ? " danger" : ""));
    b.type = "button"; b.setAttribute("role", "menuitem"); b.tabIndex = -1;
    b.appendChild(item.icon && ICON[item.icon] ? icon(item.icon) : el("span", "cm-ico"));
    b.appendChild(el("span", "cm-label", item.label));
    if (item.shortcut) b.appendChild(el("kbd", "cm-key", item.shortcut));
    if (item.sub || item.radio) { b.appendChild(el("span", "cm-more", "›")); b.setAttribute("aria-haspopup", "menu"); }
    b.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (item.radio) { openMarks(b, ctx); return; }
      close(false);
      Promise.resolve().then(function () { return item.run(ctx); }).catch(function (error) { editor.setSave(String(error && error.message || error), true); });
    });
    b.addEventListener("pointerenter", function () { if (item.radio) openMarks(b, ctx); else if (sub) { sub.remove(); sub = null; } });
    return b;
  }

  // AI 표시 ▸ : 바꿔도 됨 / 고정 / 참고 for this block.
  function openMarks(anchor, ctx) {
    if (sub) sub.remove();
    sub = el("div", "cm cm-sub"); sub.setAttribute("role", "menu"); sub.setAttribute("aria-label", "AI 표시");
    var now = markOf(ctx.blockId);
    [["edit", "바꿔도 됨"], ["lock", "고정"], ["ref", "참고"]].forEach(function (pair) {
      var r = el("button", "cm-item cm-radio"); r.type = "button"; r.setAttribute("role", "menuitemradio"); r.tabIndex = -1;
      r.setAttribute("aria-checked", String(now === pair[0]));
      r.appendChild(el("span", "cm-dot")); r.appendChild(el("span", "cm-label", pair[1]));
      r.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      r.addEventListener("click", function () { close(false); marksUi().then(function (m) { m.setBlock(ctx.blockId, pair[0]); }); });
      sub.appendChild(r);
    });
    sub.addEventListener("keydown", keys);
    var rect = anchor.getBoundingClientRect();
    place(sub, rect.right + 4, rect.top - 6);
    if (sub.offsetLeft < rect.right) sub.style.left = Math.max(8, rect.left - sub.offsetWidth - 4) + "px";
    return sub;
  }

  function formatRow(ctx) {
    var row = el("div", "cm-format"); row.setAttribute("role", "group"); row.setAttribute("aria-label", "서식");
    [["굵게", "B", "bold"], ["기울임", "I", "italic"], ["밑줄", "U", "underline"], ["취소선", "S", "strikeThrough"], ["코드", "</>", "code"], ["링크", "🔗", "link"], ["수식", "√x", "equation"]].forEach(function (f) {
      var b = el("button", "cm-fmt", f[1]); b.type = "button"; b.title = f[0]; b.setAttribute("aria-label", f[0]); b.tabIndex = -1;
      b.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      b.addEventListener("click", function () { restoreRange(ctx); close(false); format(f[2], ctx); });
      row.appendChild(b);
    });
    return row;
  }
  function restoreRange(ctx) { if (!ctx.range) return; var s = getSelection(); s.removeAllRanges(); s.addRange(ctx.range); }
  function wrap(tag, attrs) {
    var s = getSelection(); if (!s.rangeCount) return;
    var r = s.getRangeAt(0), host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    host = host && host.closest(".text[contenteditable]"); if (!host) return;
    var span = document.createElement(tag); Object.keys(attrs || {}).forEach(function (k) { span.setAttribute(k, attrs[k]); });
    span.appendChild(r.extractContents()); r.insertNode(span);
    host.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function format(kind, ctx) {
    if (kind === "bold") return wrap("strong");
    if (kind === "italic") return wrap("em");
    if (kind === "underline") return wrap("u");
    if (kind === "strikeThrough") return wrap("s");
    if (kind === "code") return wrap("code");
    if (kind === "link") { var url = window.prompt("링크 주소 (https:// 또는 /)", "https://"); var safe = url && window.EditorModel.safeHref(url.trim()); if (safe) wrap("a", { href: safe }); return; }
    if (kind === "equation") { var b = blockById(ctx.blockId); if (b) editor.insertBlocksAfter(ctx.blockId, [{ type: "equation", text: ctx.selection.text, indent: b.indent }]); }
  }

  function build(ctx) {
    close(false);
    back = document.activeElement;
    current = ctx;
    box = el("div", "cm"); box.setAttribute("role", "menu");
    box.setAttribute("aria-label", ctx.label || (ctx.scope === "selection" ? "선택한 부분 도구" : "블록 도구"));
    box.appendChild(el("h3", "cm-head", ctx.label || (ctx.scope === "selection" ? "선택한 부분" : "블록")));
    if (ctx.scope === "selection") box.appendChild(formatRow(ctx));
    var last = null;
    items(ctx).forEach(function (item) {
      var g = item.group || "plugin";
      if (last !== null && g !== last) box.appendChild(el("hr", "cm-sep"));
      if (g !== last && GROUP_TITLE[g]) box.appendChild(el("h4", "cm-group", GROUP_TITLE[g]));
      last = g;
      var button = menuButton(item, ctx);
      if (ctx.scope === "paste") button.dataset.urlChoice = item.id.replace("paste-url-", "");
      box.appendChild(button);
    });
    if (ctx.scope !== "paste" && !matchMedia("(pointer: coarse)").matches) box.appendChild(el("p", "cm-hint", "브라우저 메뉴: Shift+오른쪽 클릭"));
    box.addEventListener("keydown", keys);
    place(box, ctx.x, ctx.y);
    document.body.classList.add("cm-open");
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", onScroll, true);
    var first = box.querySelector("button"); if (first) first.focus();
  }

  function keys(ev) {
    var menu = ev.currentTarget, list = Array.prototype.slice.call(menu.querySelectorAll("button"));
    var at = list.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); list[(at + (ev.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus(); }
    else if (ev.key === "Home" || ev.key === "End") { ev.preventDefault(); list[ev.key === "Home" ? 0 : list.length - 1].focus(); }
    else if (ev.key === "ArrowRight" && document.activeElement && document.activeElement.getAttribute("aria-haspopup")) { ev.preventDefault(); document.activeElement.click(); var s = sub && sub.querySelector("button"); if (s) s.focus(); }
    else if (ev.key === "ArrowLeft" && menu === sub) { ev.preventDefault(); var owner = box && box.querySelector('[aria-haspopup="menu"]:not(.cm-sub *)'); sub.remove(); sub = null; if (owner) owner.focus(); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (menu === sub) { sub.remove(); sub = null; if (box) box.querySelector("button").focus(); } else close(); }
    else if (ev.key === "Tab") { ev.preventDefault(); }
  }

  // Selection inside one block's text: plain-text offsets, so the server range check and the marks match the stored text.
  function selectionIn(text) {
    var s = getSelection();
    if (!s.rangeCount || s.isCollapsed) return null;
    var r = s.getRangeAt(0);
    if (!text.contains(r.startContainer) || !text.contains(r.endContainer)) return null;
    var pre = document.createRange(); pre.selectNodeContents(text); pre.setEnd(r.startContainer, r.startOffset);
    var start = pre.toString().length, value = r.toString();
    if (!value.trim()) return null;
    return { text: value, start: start, end: start + value.length, range: r.cloneRange(), rect: r.getBoundingClientRect() };
  }

  function contextAt(target, x, y) {
    var row = target && target.closest && target.closest("#blocks .blk[data-id]");
    if (!row) return null;
    var text = row.querySelector(":scope > .body > .text, :scope > .body > .trow > .text");
    var sel = text ? selectionIn(text) : null;
    return { scope: sel ? "selection" : "block", blockId: row.dataset.id, block: blockById(row.dataset.id), selection: sel ? { text: sel.text, start: sel.start, end: sel.end } : null,
      range: sel ? sel.range : null, anchorRect: sel ? sel.rect : row.getBoundingClientRect(), anchor: row.querySelector(".drag-handle") || row, x: x, y: y };
  }

  var openSeq = 0;
  function open(ctx) {
    if (!ctx) return;
    var mine = ++openSeq;
    var go = function () { if (mine === openSeq) build(ctx); };
    marksUi().then(function (m) { return m.ready; }).then(go, go);
  }

  // Mouse: right-click on a block (Shift keeps the browser menu, and so does a click inside a code editor or form field).
  document.addEventListener("contextmenu", function (ev) {
    if (ev.shiftKey || ev.defaultPrevented) return;
    if (ev.target.closest && ev.target.closest("input, textarea, select, iframe, .cm, [data-native-menu]")) return;
    var ctx = contextAt(ev.target, ev.clientX, ev.clientY);
    if (!ctx) return;
    ev.preventDefault();
    open(ctx);
  });

  // Keyboard: Shift+F10 or the context-menu key in a block opens the menu at the caret.
  document.addEventListener("keydown", function (ev) {
    if (!((ev.key === "F10" && ev.shiftKey) || ev.key === "ContextMenu")) return;
    var s = getSelection(), node = s.anchorNode, target = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!target || !target.closest("#blocks")) return;
    ev.preventDefault();
    var rect = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : target.getBoundingClientRect();
    var row = target.closest(".blk"), r2 = row ? row.getBoundingClientRect() : rect;
    open(contextAt(target, (rect.width || rect.left) ? rect.left : r2.left + 24, (rect.bottom || r2.top + 24) + 4));
  }, true);

  // Phones: a long press on the block handle opens the block menu (text keeps the system's own selection handles).
  var press = null;
  document.addEventListener("pointerdown", function (ev) {
    if (ev.pointerType !== "touch") return;
    var handle = ev.target.closest && ev.target.closest("#blocks .drag-handle");
    if (!handle) return;
    press = setTimeout(function () { press = null; var rect = handle.getBoundingClientRect(); open(contextAt(handle, rect.right + 4, rect.bottom + 4)); }, 450);
  }, true);
  ["pointerup", "pointercancel", "pointermove"].forEach(function (name) { document.addEventListener(name, function (ev) { if (press && (name !== "pointermove" || Math.abs(ev.movementX) + Math.abs(ev.movementY) > 6)) { clearTimeout(press); press = null; } }, true); });

  // Page default (AI 기본 표시) from the marks pill.
  function openPageMarks(anchor) {
    close(false);
    back = anchor;
    box = el("div", "cm"); box.setAttribute("role", "menu"); box.setAttribute("aria-label", "AI 기본 표시");
    box.appendChild(el("h3", "cm-head", "AI 기본 표시"));
    var now = (document.getElementById("doc").dataset.aiDefault) || "edit";
    [["edit", "AI가 바꿔도 됨 (기본)"], ["lock", "고정"], ["ref", "참고"], ["smart", "자동 — 제목·출처·인용·표는 고정, 메모는 참고"]].forEach(function (pair) {
      var r = el("button", "cm-item cm-radio"); r.type = "button"; r.setAttribute("role", "menuitemradio"); r.setAttribute("aria-checked", String(now === pair[0]));
      r.appendChild(el("span", "cm-dot")); r.appendChild(el("span", "cm-label", pair[1]));
      r.addEventListener("click", function () { close(); marksUi().then(function (m) { return m.setPage(pair[0]); }); });
      box.appendChild(r);
    });
    box.addEventListener("keydown", keys);
    var rect = anchor.getBoundingClientRect();
    place(box, rect.left, rect.bottom + 4);
    document.addEventListener("pointerdown", outside, true);
    box.querySelector("button").focus();
  }

  var api = {
    register: function (item) {
      if (!item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.run !== "function" || !["block", "selection", "paste"].includes(item.scope)) throw new TypeError("contextMenu.register needs {id, label, scope: 'block'|'selection'|'paste', run}");
      registry = registry.filter(function (x) { return x.id !== item.id; }).concat([item]);
      return function () { registry = registry.filter(function (x) { return x !== item; }); };
    },
    openBlock: function (id, anchor) { var rect = anchor.getBoundingClientRect(); open(contextAt(anchor.closest(".blk") || rowOf(id), rect.right + 4, rect.top)); },
    openAt: function (target, x, y) { open(contextAt(target, x, y)); },
    openPageMarks: openPageMarks,
    openPaste: function (ctx) { build(Object.assign({}, ctx, { scope: "paste", label: "주소 붙여넣기" })); },
    close: close,
    get current() { return current ? { scope: current.scope, blockId: current.blockId, selection: current.selection } : null; }
  };
  editor.contextMenu = Object.assign(editor.contextMenu || {}, { register: api.register, openBlock: api.openBlock, openAt: api.openAt, openPageMarks: openPageMarks, close: close });
  Object.defineProperty(editor.contextMenu, "current", { configurable: true, get: function () { return api.current; } });
  (editor.contextMenu.queue || []).forEach(function (item) { try { api.register(item); } catch (_) {} });
  editor.provide("context-menu", api);
})();
