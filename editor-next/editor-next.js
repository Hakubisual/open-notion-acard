(function () {
  "use strict";
  // Network seam (open-notion-acard #1): a host page can set window.AcardEditorProvider = { fetch(url, options) } before
  // this script loads to route the editor's requests elsewhere. Without it every call is the browser fetch to /api.
  function net(url, options) {
    var provider = window.AcardEditorProvider;
    return provider && typeof provider.fetch === "function" ? provider.fetch(url, options) : fetch(url, options);
  }
  var editor = window.AcardEditor, model = window.EditorModel;
  var blocksEl = document.getElementById("blocks");
  var started = false;

  function state() { return editor.state; }
  function blockOf(el) {
    var row = el && el.closest && el.closest(".blk[data-id]");
    if (!row) return null;
    var id = row.dataset.id;
    var index = state().blocks.findIndex(function (b) { return b.id === id; });
    return index < 0 ? null : { block: state().blocks[index], index: index, row: row };
  }
  function focusText(id, atStart) {
    var row = blocksEl.querySelector('.blk[data-id="' + id + '"]');
    var text = row && row.querySelector(".text");
    if (!text) return;
    text.focus();
    var range = document.createRange();
    range.selectNodeContents(text);
    range.collapse(!!atStart);
    var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function commit() { editor.render(); editor.scheduleSave(); }
  function textNodes(host) {
    var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), out = [], node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }
  function point(host, offset) {
    var nodes = textNodes(host), seen = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      if (offset <= seen + len) return { node: nodes[i], offset: offset - seen };
      seen += len;
    }
    return nodes.length ? { node: nodes[nodes.length - 1], offset: nodes[nodes.length - 1].nodeValue.length } : { node: host, offset: 0 };
  }
  function caret() {
    var sel = getSelection();
    if (!sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    var start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var host = start && start.closest('.text, table [contenteditable="true"]');
    if (!host || !blocksEl.contains(host)) return null;
    var before = range.cloneRange();
    before.selectNodeContents(host);
    before.setEnd(range.endContainer, range.endOffset);
    return { sel: sel, range: range, host: host, before: before.toString(), collapsed: range.collapsed };
  }
  function replaceBeforeCaret(info, count, node) {
    var end = info.before.length, from = point(info.host, end - count), to = point(info.host, end);
    var range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    range.deleteContents();
    range.insertNode(node);
    var after = document.createTextNode("");
    if (node.nodeType === 1) node.after(after);
    var place = document.createRange();
    if (node.nodeType === 1) place.setStart(after, 0); else place.setStart(node, node.nodeValue.length);
    place.collapse(true);
    info.sel.removeAllRanges(); info.sel.addRange(place);
    closedMark = node.nodeType === 1 ? after : null;
    info.host.dispatchEvent(new Event("input", { bubbles: true }));
  }
  var closedMark = null;
  function onBeforeInput(ev) {
    var spot = closedMark;
    closedMark = null;
    if (!spot || !spot.parentNode || ev.inputType !== "insertText" || !ev.data || ev.isComposing) return;
    var sel = getSelection();
    if (!sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0), prev = spot.previousSibling;
    var atSpot = range.startContainer === spot || (prev && prev.contains(range.startContainer) && range.startOffset === (range.startContainer.nodeValue || "").length);
    if (!atSpot) return;
    ev.preventDefault();
    spot.nodeValue += ev.data;
    range = document.createRange(); range.setStart(spot, spot.nodeValue.length); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    closedMark = spot;
    spot.parentNode.closest(".text").dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ev.data }));
  }

  // --- Paste: HTML and multi-line text become blocks (Notion, web pages, Google Docs) ---
  var MARK_TAGS = { B: "bold", STRONG: "bold", I: "italic", EM: "italic", U: "underline", S: "strike", DEL: "strike", STRIKE: "strike", CODE: "code" };
  var SKIP = { SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1, TEMPLATE: 1, NOSCRIPT: 1 };
  function runsOf(node, marks, runs, skipLists) {
    if (node.nodeType === 3) { var t = node.nodeValue.replace(/\s+/g, " "); if (t) runs.push(Object.assign({ text: t }, marks)); return runs; }
    if (node.nodeType !== 1 || SKIP[node.tagName]) return runs;
    if (skipLists && /^(UL|OL)$/.test(node.tagName)) return runs;
    if (node.tagName === "BR") { runs.push(Object.assign({ text: "\n" }, marks)); return runs; }
    if (node.tagName === "INPUT") return runs;
    var next = Object.assign({}, marks), style = node.getAttribute("style") || "";
    if (MARK_TAGS[node.tagName]) next[MARK_TAGS[node.tagName]] = true;
    if (/font-weight:\s*(bold|[6-9]00)/.test(style)) next.bold = true;
    if (/font-style:\s*italic/.test(style)) next.italic = true;
    if (/line-through/.test(style)) next.strike = true;
    if (node.tagName === "A" && model.safeHref(node.getAttribute("href") || "")) next.href = node.getAttribute("href");
    Array.prototype.forEach.call(node.childNodes, function (child) { runsOf(child, next, runs, skipLists); });
    return runs;
  }
  function cleanRuns(runs) {
    var out = [];
    runs.forEach(function (run) {
      var last = out[out.length - 1];
      if (last && JSON.stringify(Object.assign({}, last, { text: "" })) === JSON.stringify(Object.assign({}, run, { text: "" }))) last.text += run.text;
      else out.push(Object.assign({}, run));
    });
    if (out.length) { out[0].text = out[0].text.replace(/^\s+/, ""); out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, ""); }
    return model.richText(out.filter(function (run) { return run.text; }), "");
  }
  function textBlock(type, runs, extra) {
    runs = cleanRuns(runs);
    var text = runs.map(function (r) { return r.text; }).join("");
    var block = Object.assign({ type: type, text: text, indent: 0 }, extra || {});
    if (runs.some(function (r) { return Object.keys(r).length > 1; })) block.meta = Object.assign({}, block.meta, { richText: runs });
    return block;
  }
  function hasBlockChild(el) {
    return Array.prototype.some.call(el.children, function (c) { return /^(P|DIV|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|HR|FIGURE|DETAILS|ASIDE|SECTION|ARTICLE|IMG)$/.test(c.tagName); });
  }
  function htmlBlocks(root) {
    var out = [];
    function list(el, depth) {
      var todoList = /to-do|task|checklist/i.test(el.className || "");
      Array.prototype.forEach.call(el.children, function (li) {
        // Google Docs writes a nested list beside its parent item, not inside it.
        if (/^(UL|OL)$/.test(li.tagName)) return list(li, depth + 1);
        if (li.tagName !== "LI") return;
        var box = li.querySelector('input[type="checkbox"], .checkbox');
        var todo = todoList || (box && box.closest("li") === li);
        var type = todo ? "to_do" : el.tagName === "OL" ? "numbered" : "bulleted";
        var checked = !!(box && (box.checked || /checkbox-on|checked/.test(box.className || "")));
        var block = textBlock(type, runsOf(li, {}, [], true), { indent: depth });
        if (todo) block.checked = checked;
        if (block.text) out.push(block);
        Array.prototype.forEach.call(li.children, function (child) { if (/^(UL|OL)$/.test(child.tagName)) list(child, depth + 1); });
      });
    }
    function walk(node, depth) {
      if (node.nodeType === 3) { if (node.nodeValue.trim()) out.push(textBlock("paragraph", [{ text: node.nodeValue }], { indent: depth })); return; }
      if (node.nodeType !== 1 || SKIP[node.tagName]) return;
      var tag = node.tagName, push = function (block) { block.indent = depth; if (block.text || block.type !== "paragraph") out.push(block); };
      // Word writes list items as paragraphs: mso-list:lN levelK gives the level, a mso-list:Ignore span holds the marker.
      var wordLevel = tag === "P" && /mso-list:\s*l\d+\s+level(\d+)/.exec(node.getAttribute("style") || "");
      if (wordLevel) {
        var marker = node.querySelector('[style*="mso-list:Ignore"]'), mark = marker ? marker.textContent.trim() : "";
        if (marker) marker.remove();
        return out.push(textBlock(/^[\dA-Za-z]{1,3}[.)]$/.test(mark) ? "numbered" : "bulleted", runsOf(node, {}, []), { indent: depth + Number(wordLevel[1]) - 1 }));
      }
      if (/^H[1-6]$/.test(tag)) return push(textBlock("heading" + Math.min(3, Number(tag[1])), runsOf(node, {}, [])));
      if (tag === "UL" || tag === "OL") return list(node, depth);
      if (tag === "BLOCKQUOTE") return push(Object.assign(textBlock("quote", runsOf(node, {}, [])), {}));
      if (tag === "ASIDE" || (tag === "FIGURE" && /(^|\s)callout(\s|$)/.test(node.className || ""))) {
        var icon = node.querySelector(".icon");
        var bodyEl = tag === "FIGURE" ? (node.lastElementChild || node) : node;
        return push(textBlock("callout", runsOf(bodyEl, {}, []), { meta: icon && icon.textContent.trim() ? { tone: "note", icon: icon.textContent.trim() } : { tone: "note" } }));
      }
      if (tag === "PRE") {
        var lang = /language-([\w-]+)/.exec((node.querySelector("code") || node).className || "");
        return push({ type: "code", text: node.textContent.replace(/\n$/, ""), meta: lang ? { lang: lang[1] } : null });
      }
      if (tag === "HR") return push({ type: "divider", text: "" });
      if (tag === "IMG") {
        var src = node.getAttribute("src") || "";
        if (/^(https:|\/media\/)/.test(src)) push({ type: "image", text: node.getAttribute("alt") || "", meta: { src: src, width: 100 } });
        return;
      }
      if (tag === "TABLE") {
        var rows = Array.prototype.map.call(node.querySelectorAll("tr"), function (tr) {
          return Array.prototype.map.call(tr.children, function (cell) { return cell.textContent.replace(/\s+/g, " ").trim(); });
        }).filter(function (r) { return r.length; });
        if (!rows.length) return;
        var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
        var pad = function (r) { while (r.length < width) r.push(""); return r; };
        var columns = pad(rows.shift()).map(function (c, i) { return c || "열" + (i + 1); });
        return push({ type: "table", text: columns.join(" | "), meta: { columns: columns, rows: rows.map(pad), header: true } });
      }
      if (tag === "DETAILS") {
        var summary = node.querySelector("summary");
        push(textBlock("toggle", summary ? runsOf(summary, {}, []) : [{ text: "" }], { meta: { open: node.open } }));
        Array.prototype.forEach.call(node.childNodes, function (child) { if (child !== summary) walk(child, depth + 1); });
        return;
      }
      if ((tag === "P" || tag === "DIV" || tag === "LI" || tag === "SPAN") && !hasBlockChild(node)) {
        var parts = [[]];
        runsOf(node, {}, []).forEach(function (run) {
          var pieces = run.text.split("\n");
          pieces.forEach(function (piece, i) { if (i) parts.push([]); if (piece) parts[parts.length - 1].push(Object.assign({}, run, { text: piece })); });
        });
        parts.forEach(function (runs) { if (runs.length) push(textBlock("paragraph", runs)); });
        return;
      }
      var inline = document.createElement("p");
      function flushInline() {
        if (inline.childNodes.length) { walk(inline, depth); inline = document.createElement("p"); }
      }
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 1 && (/^(P|DIV|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|HR|FIGURE|DETAILS|ASIDE|SECTION|ARTICLE|IMG)$/.test(child.tagName) || hasBlockChild(child))) {
          flushInline(); walk(child, depth);
        } else inline.appendChild(child.cloneNode(true));
      });
      flushInline();
    }
    walk(root, 0);
    return out;
  }
  function textBlocks(text) {
    var lines = text.replace(/\r\n?/g, "\n").split("\n"), out = [], i = 0;
    while (i < lines.length) {
      var raw = lines[i].replace(/\t/g, "  "), line = raw.trim(), depth = Math.floor((/^ */.exec(raw)[0].length) / 2), m;
      i += 1;
      if (!line) continue;
      if (/^```/.test(line)) {
        var body = [];
        while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i += 1; }
        i += 1;
        out.push({ type: "code", text: body.join("\n"), meta: line.slice(3).trim() ? { lang: line.slice(3).trim() } : null, indent: depth });
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) out.push({ type: "divider", text: "", indent: depth });
      else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) out.push({ type: "heading" + Math.min(3, m[1].length), text: m[2], indent: depth });
      else if ((m = /^[-*+]\s+\[( |x|X)\]\s*(.*)$/.exec(line))) out.push({ type: "to_do", text: m[2], checked: m[1] !== " ", indent: depth });
      else if ((m = /^[-*+•]\s+(.*)$/.exec(line))) out.push({ type: "bulleted", text: m[1], indent: depth });
      else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) out.push({ type: "numbered", text: m[1], indent: depth });
      else if ((m = /^>\s?(.*)$/.exec(line))) out.push({ type: "quote", text: m[1], indent: depth });
      else out.push({ type: "paragraph", text: line, indent: depth });
    }
    return out;
  }
  function insertBlocks(at, blocks) {
    if (editor.coreEditing && editor.commands && editor.commands.insertBlocks) {
      if (editor.commands.insertBlocks(blocks, editor.captureSelection())) return;
    }
    var cur = at.block;
    var base = model.depth(cur);
    blocks.forEach(function (b) { b.indent = base + (b.indent || 0); });
    var first = blocks[0];
    if (!cur.text && cur.type === "paragraph" && !/image|table|divider|code/.test(first.type)) {
      cur.type = first.type; cur.text = first.text; cur.checked = !!first.checked; cur.meta = first.meta || null; cur.indent = first.indent;
      blocks = blocks.slice(1);
    }
    var ids = blocks.length ? editor.insertBlocksAfter(cur.id, blocks) : (commit(), [cur.id]);
    focusText(ids[ids.length - 1]);
    editor.setSave("붙여넣은 블록 " + (blocks.length + (ids[0] === cur.id ? 1 : 0)) + "개", false);
  }
  function onPaste(ev) {
    var data = ev.clipboardData;
    if (!data) return;
    if (data.files && data.files.length) { ev.preventDefault(); ev.stopImmediatePropagation(); return addFiles(Array.prototype.slice.call(data.files), ev.target); }
    var cell = ev.target.closest && ev.target.closest(".editable-table .cell");
    if (cell && !cell.closest(".easy-table")) return pasteGrid(ev, cell);
    var host = ev.target.closest && ev.target.closest(".text");
    var at = host && blockOf(host);
    if (!at) return;
    var html = data.getData("text/html"), plain = data.getData("text/plain");
    ev.preventDefault(); ev.stopImmediatePropagation();
    pasteInto(at, host, html, plain);
  }
  var MARKDOWN_SIGNS = /(^|\n)(> \[!|- \[[ xX]\] |\x60{3}|---\n)|\*\*\S|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\([^)\s]+\)|==\S/;
  function pasteInto(at, host, html, plain) {
    if (at.block.type === "code") return document.execCommand("insertText", false, plain);
    if (editor.coreEditing && !(editor.commands && editor.commands.insertBlocks)) {
      var selection = getSelection(), held = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      var documentBefore = JSON.stringify(state().blocks);
      Promise.all([editor.lazy("block-commands"), editor.lazy("editor-selection")]).then(function () {
        var current = getSelection(), range = current.rangeCount && current.getRangeAt(0);
        if (!held || !host.isConnected || JSON.stringify(state().blocks) !== documentBefore || !range || range.compareBoundaryPoints(0, held) || range.compareBoundaryPoints(2, held)) {
          editor.setSave("내용이 바뀌었어요. 동작을 다시 눌러 주세요.", true); return;
        }
        pasteInto(at, host, html, plain);
      }).catch(function (error) { editor.setSave(error.message, true); });
      return;
    }
    var info = caret(), url = plain.trim();
    if (info && !info.collapsed && /^https?:\/\/\S+$/.test(url) && model.safeHref(url)) {
      var a = document.createElement("a"); a.href = url; a.appendChild(info.range.extractContents());
      info.range.insertNode(a); host.dispatchEvent(new Event("input", { bubbles: true })); return;
    }
    if (/^https?:\/\/\S+$/.test(url) && (!info || info.collapsed)) {
      if (editor.coreEditing && info) {
        var offset = info.before.length, before = JSON.stringify(state().blocks);
        editor.lazy("paste-md").then(function (api) { return api.offerUrl(url, at.block.id, offset, before); }).catch(function (error) { editor.setSave(error.message, true); });
        return;
      }
      editor.lazy("paste-md").then(function (api) { api.offerImage(at, url, showNotice); });
    }
    // issue 134: markdown from Obsidian or an AI chat (callouts, [[links]], **bold**, front matter) goes through the
    // import reader in the lazy paste-md chunk; a short plain paste stays instant.
    if (!html && MARKDOWN_SIGNS.test(plain) && editor.lazy) {
      var beforePaste = editor.coreEditing ? JSON.stringify(state().blocks) : null;
      editor.lazy("paste-md").then(function (api) {
        if (beforePaste !== null && JSON.stringify(state().blocks) !== beforePaste) { editor.setSave("내용이 바뀌었어요. 동작을 다시 눌러 주세요.", true); return; }
        var pasted = api.pasteBlocks(plain, (state().pages || []).map(function (p) { return { slug: p.slug, title: p.title }; }));
        if (pasted.length) insertBlocks(at, pasted); else document.execCommand("insertText", false, plain);
      }, function () { insertBlocks(at, textBlocks(plain)); });
      return;
    }
    var blocks = html ? htmlBlocks(new DOMParser().parseFromString(html, "text/html").body) : textBlocks(plain);
    if (!blocks.length) return document.execCommand("insertText", false, plain.replace(/\r?\n+/g, " "));
    if (blocks.length === 1 && /^(paragraph|heading[123]|bulleted|numbered|quote)$/.test(blocks[0].type) && (at.block.text || blocks[0].type === "paragraph")) {
      var one = blocks[0];
      if (one.meta && one.meta.richText) document.execCommand("insertHTML", false, model.richHtml(one.meta.richText, one.text));
      else document.execCommand("insertText", false, one.text);
      return;
    }
    insertBlocks(at, blocks);
  }

  function mountAttachments() {
    var bar = document.getElementById("more-menu");
    if (!bar || bar.querySelector(".att-btn")) return;
    var b = document.createElement("button"); b.type = "button"; b.className = "menuitem att-btn"; b.textContent = "첨부";
    var box = document.createElement("dialog"); box.className = "editor-panel att-panel"; document.body.appendChild(box);
    b.addEventListener("click", function () {
      bar.hidden = true;
      document.getElementById("more").setAttribute("aria-expanded", "false");
      editor.api("/page/" + encodeURIComponent(editor.slug) + "/attachments").then(function (data) {
        box.replaceChildren();
        var h = document.createElement("h2"); h.textContent = "첨부 (" + data.attachments.length + ")"; box.appendChild(h);
        var close = document.createElement("button"); close.type = "button"; close.className = "mini"; close.textContent = "닫기"; close.onclick = function () { box.close(); }; box.appendChild(close);
        if (!data.attachments.length) { var p = document.createElement("p"); p.textContent = "이 페이지에 올린 파일이 없어요."; box.appendChild(p); }
        var list = document.createElement("ul"); list.className = "att-list";
        data.attachments.forEach(function (f) {
          var li = document.createElement("li"), a = document.createElement("a"); a.href = f.url; a.target = "_blank"; a.rel = "noopener";
          if (/^image\//.test(f.mime)) { var img = document.createElement("img"); img.src = f.url; img.alt = f.name; img.loading = "lazy"; a.appendChild(img); }
          var s = document.createElement("span"); s.textContent = f.name + " · " + Math.max(1, Math.round(f.bytes / 1024)) + " KB"; a.appendChild(s);
          li.appendChild(a); list.appendChild(li);
        });
        box.appendChild(list);
        if (!box.open) box.showModal();
      }).catch(function (e) { editor.setSave("첨부 목록을 불러오지 못했어요: " + e.message, true); });
    });
    bar.appendChild(b);
  }

  // --- Tables: Tab / arrows between cells, Ctrl+Enter adds a row, TSV / HTML grids paste across cells ---
  function tableAt(cell) {
    var at = blockOf(cell), table = cell.closest("table");
    var cells = Array.prototype.slice.call(table.querySelectorAll('[contenteditable="true"]'));
    var tr = cell.closest("tr"), td = cell.closest("td, th");
    var rowIndex = tr.parentElement.tagName === "THEAD" ? -1 : Array.prototype.indexOf.call(tr.parentElement.children, tr);
    return { at: at, table: table, cells: cells, index: cells.indexOf(cell), row: rowIndex, col: Array.prototype.indexOf.call(tr.children, td) };
  }
  function focusCell(blockId, row, col) {
    var rowEl = blocksEl.querySelector('.blk[data-id="' + blockId + '"]');
    var table = rowEl && rowEl.querySelector("table");
    if (!table) return;
    var tr = row < 0 ? table.querySelector("thead tr") : table.querySelectorAll("tbody tr")[row];
    var cell = tr && tr.children[col] && tr.children[col].querySelector('[contenteditable="true"]');
    if (cell) { cell.focus(); var r = document.createRange(); r.selectNodeContents(cell); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  function addRow(at, after) {
    var meta = at.block.meta;
    meta.rows.splice(after + 1, 0, meta.columns.map(function () { return ""; }));
    at.block.meta = meta; commit();
  }
  function tableKeys(ev, cell) {
    var t = tableAt(cell), simple = !!cell.closest(".editable-table") && t.at && t.at.block.type === "table";
    if (ev.key === "Tab") {
      ev.preventDefault(); ev.stopImmediatePropagation();
      var next = t.index + (ev.shiftKey ? -1 : 1);
      if (next >= t.cells.length && simple) { addRow(t.at, t.at.block.meta.rows.length - 1); return focusCell(t.at.block.id, t.at.block.meta.rows.length - 1, 0); }
      if (t.cells[next]) { t.cells[next].focus(); getSelection().selectAllChildren(t.cells[next]); getSelection().collapseToEnd(); }
    } else if (simple && ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      addRow(t.at, t.row); focusCell(t.at.block.id, t.row + 1, t.col);
    } else if (simple && (ev.key === "ArrowDown" || ev.key === "ArrowUp") && !ev.shiftKey) {
      var target = t.row + (ev.key === "ArrowDown" ? 1 : -1);
      if (target >= -1 && target < t.at.block.meta.rows.length) { ev.preventDefault(); ev.stopImmediatePropagation(); focusCell(t.at.block.id, target, t.col); }
    } else if (simple && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (t.row >= 0 && t.row < t.at.block.meta.rows.length - 1) focusCell(t.at.block.id, t.row + 1, t.col);
    }
  }
  function pasteGrid(ev, cell) {
    var t = tableAt(cell), data = ev.clipboardData;
    if (!t.at || t.at.block.type !== "table") return;
    var html = data.getData("text/html"), grid = null;
    if (html && /<table/i.test(html)) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      grid = Array.prototype.map.call(doc.querySelectorAll("tr"), function (tr) { return Array.prototype.map.call(tr.children, function (c) { return c.textContent.replace(/\s+/g, " ").trim(); }); });
    } else {
      var plain = data.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\n$/, "");
      if (plain.indexOf("\t") >= 0 || plain.indexOf("\n") >= 0) grid = plain.split("\n").map(function (line) { return line.split("\t"); });
    }
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (!grid) return document.execCommand("insertText", false, data.getData("text/plain"));
    var meta = t.at.block.meta;
    grid.forEach(function (cells, r) {
      cells.forEach(function (value, c) {
        var row = t.row + r, col = t.col + c;
        while (col >= meta.columns.length) { meta.columns.push("열" + (meta.columns.length + 1)); meta.rows.forEach(function (x) { x.push(""); }); }
        if (row < 0) { meta.columns[col] = value || meta.columns[col]; return; }
        while (row >= meta.rows.length) meta.rows.push(meta.columns.map(function () { return ""; }));
        meta.rows[row][col] = value;
      });
    });
    t.at.block.meta = meta; commit();
    editor.setSave("표에 " + grid.length + "줄을 붙여넣었어요", false);
  }

  // --- Markdown shortcuts and typography while typing ---
  var BLOCK_RULES = [
    [/^####\s$/, "heading4"], [/^###\s$/, "heading3"], [/^##\s$/, "heading2"], [/^#\s$/, "heading1"],
    [/^[-*+]\s$/, "bulleted"], [/^1[.)]\s$/, "numbered"], [/^\[( |x)?\]\s$/, "to_do"], [/^>\s$/, "quote"]
  ];
  var TYPO = [["->", "→"], ["<-", "←"], ["=>", "⇒"], ["!=", "≠"], ["<=", "≤"], [">=", "≥"], ["...", "…"], ["(c)", "©"], ["(r)", "®"], ["(tm)", "™"], ["1/2", "½"], ["+/-", "±"]];
  var INLINE = [[/(^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "strong"], [/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "em"], [/(^|[^`])`([^`]+)`$/, "code"], [/(^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/, "s"]];
  var applying = false;
  function dropPrefix(meta, count) {
    if (!meta || !Array.isArray(meta.richText)) return null;
    var runs = [];
    meta.richText.forEach(function (run) {
      var cut = Math.min(count, run.text.length); count -= cut;
      if (run.text.length > cut) runs.push(Object.assign({}, run, { text: run.text.slice(cut) }));
    });
    return runs.some(function (run) { return Object.keys(run).length > 1; }) ? { richText: runs } : null;
  }
  function onInput(ev) {
    if (applying || ev.isComposing) return;
    var info = caret();
    if (!info || !info.collapsed || !info.host.classList.contains("text")) return refreshEmoji(info);
    var at = blockOf(info.host);
    if (!at || at.block.type === "code") return refreshEmoji(null);
    applying = true;
    try {
      if (ev.inputType === "insertText" && ev.data === " " && info.before.length <= 4) {
        for (var i = 0; i < BLOCK_RULES.length; i++) {
          if (!BLOCK_RULES[i][0].test(info.before)) continue;
          var type = BLOCK_RULES[i][1], from = at.block.type;
          if (from !== "paragraph" && !(type === "to_do" && from === "bulleted")) break;
          at.block.type = type;
          at.block.checked = /\[x\]/.test(info.before);
          at.block.text = at.block.text.slice(info.before.length);
          at.block.meta = dropPrefix(at.block.meta, info.before.length);
          commit(); focusText(at.block.id, true);
          return;
        }
      }
      if (at.block.type === "paragraph" && (info.before === "```" || info.before === "---") && at.block.text === info.before) {
        if (info.before === "```") { at.block.type = "code"; at.block.text = ""; at.block.meta = null; commit(); focusText(at.block.id, true); return; }
        at.block.type = "divider"; at.block.text = ""; at.block.meta = null;
        var ids = editor.insertBlocksAfter(at.block.id, [{ type: "paragraph", text: "" }]);
        focusText(ids[0]);
        return;
      }
      if (ev.inputType !== "insertText" || info.range.startContainer.parentElement.closest("code")) return refreshEmoji(info);
      for (var k = 0; k < INLINE.length; k++) {
        var m = INLINE[k][0].exec(info.before);
        if (!m) continue;
        var el = document.createElement(INLINE[k][1]); el.textContent = m[2];
        replaceBeforeCaret(info, m[0].length - m[1].length, el);
        return;
      }
      for (var j = 0; j < TYPO.length; j++) {
        var from2 = TYPO[j][0];
        if (info.before.slice(-from2.length) === from2) { replaceBeforeCaret(info, from2.length, document.createTextNode(TYPO[j][1])); return; }
      }
      if (/\S--$/.test(info.before)) { replaceBeforeCaret(info, 2, document.createTextNode("—")); return; }
      var code = /:([a-z0-9_+-]{2,}):$/.exec(info.before), hit = code && EMOJI.find(function (e) { return e[2] === code[1]; });
      if (hit) { replaceBeforeCaret(info, code[0].length, document.createTextNode(hit[0])); hideEmoji(); return; }
    } finally { applying = false; }
    refreshEmoji(caret());
  }

  // --- Emoji: ":" plus a Korean or English name ---
  var EMOJI = [
    ["😀", "웃음", "smile"], ["😂", "눈물나게 웃김", "joy"], ["🥲", "웃픔", "smiling_tear"], ["😊", "미소", "blush"], ["😍", "하트눈", "heart_eyes"],
    ["🤔", "생각", "thinking"], ["😮", "놀람", "open_mouth"], ["😢", "슬픔", "cry"], ["😡", "화남", "rage"], ["😴", "졸림", "sleeping"],
    ["🙏", "부탁", "pray"], ["👍", "좋아요", "thumbsup"], ["👎", "싫어요", "thumbsdown"], ["👏", "박수", "clap"], ["🙌", "만세", "raised_hands"],
    ["👀", "보는 중", "eyes"], ["💪", "힘내", "muscle"], ["👋", "인사", "wave"], ["🤝", "협업하기", "handshake"], ["👥", "사람들", "people"],
    ["❤️", "하트", "heart"], ["🔥", "불", "fire"], ["✨", "반짝", "sparkles"], ["⭐", "별", "star"], ["🎉", "축하", "tada"],
    ["✅", "완료하기", "white_check_mark"], ["❌", "취소", "x"], ["⚠️", "주의", "warning"], ["❓", "질문", "question"], ["❗", "중요", "exclamation"],
    ["📝", "메모하기", "memo"], ["📌", "고정", "pushpin"], ["📎", "첨부", "paperclip"], ["📅", "일정", "date"], ["⏰", "알람", "alarm_clock"],
    ["🚀", "시작하기", "rocket"], ["💡", "아이디어", "bulb"], ["🎯", "목표", "dart"], ["📈", "상승", "chart_up"], ["📉", "하락", "chart_down"],
    ["🐛", "버그", "bug"], ["🔧", "고치기", "wrench"], ["🔒", "잠금", "lock"], ["🔑", "열쇠", "key"], ["📦", "배포", "package"],
    ["💬", "댓글", "speech_balloon"], ["📢", "공지", "loudspeaker"], ["📚", "공부", "books"], ["💻", "컴퓨터", "computer"], ["📱", "휴대폰", "iphone"],
    ["☕", "커피", "coffee"], ["🍚", "밥", "rice"], ["🏠", "집", "house"], ["🌱", "새싹", "seedling"], ["☀️", "맑음", "sunny"],
    ["🌧️", "비", "rain"], ["❄️", "눈", "snowflake"], ["🐶", "강아지", "dog"], ["🐱", "고양이", "cat"], ["💯", "백점", "100"]
  ];
  var emojiEl = null, emojiItems = [], emojiSel = 0, emojiQuery = null;
  function hideEmoji() { if (emojiEl) emojiEl.hidden = true; emojiQuery = null; }
  function refreshEmoji(info) {
    var m = info && info.collapsed && /(?:^|\s):([^\s:]{1,20})$/.exec(info.before);
    if (!m || (info.host.closest(".blk") && blockOf(info.host) && blockOf(info.host).block.type === "code")) return hideEmoji();
    var q = m[1].toLowerCase();
    emojiItems = EMOJI.filter(function (e) { return e[1].indexOf(q) >= 0 || e[2].indexOf(q) === 0; }).slice(0, 6);
    if (!emojiItems.length) return hideEmoji();
    emojiQuery = { text: ":" + m[1] };
    emojiSel = 0;
    if (!emojiEl) {
      emojiEl = document.createElement("div"); emojiEl.className = "acard-emoji"; emojiEl.setAttribute("role", "listbox"); emojiEl.setAttribute("aria-label", "이모지");
      document.body.appendChild(emojiEl);
    }
    emojiEl.replaceChildren();
    emojiItems.forEach(function (e, i) {
      var b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "option");
      b.innerHTML = '<span class="ae-i"></span><span class="ae-n"></span>';
      b.firstChild.textContent = e[0]; b.lastChild.textContent = e[1];
      b.addEventListener("mousedown", function (ev) { ev.preventDefault(); emojiSel = i; pickEmoji(); });
      emojiEl.appendChild(b);
    });
    paintEmoji();
    var rect = info.range.getBoundingClientRect();
    if (!rect.height) rect = info.host.getBoundingClientRect();
    emojiEl.hidden = false;
    emojiEl.style.left = Math.max(8, Math.min(rect.left, innerWidth - emojiEl.offsetWidth - 8)) + "px";
    emojiEl.style.top = (rect.bottom + 6 + emojiEl.offsetHeight > innerHeight ? rect.top - emojiEl.offsetHeight - 6 : rect.bottom + 6) + "px";
  }
  function paintEmoji() { Array.prototype.forEach.call(emojiEl.children, function (b, i) { b.classList.toggle("on", i === emojiSel); b.setAttribute("aria-selected", String(i === emojiSel)); }); }
  function pickEmoji() {
    var info = caret(), item = emojiItems[emojiSel];
    if (!info || !item || !emojiQuery) return hideEmoji();
    applying = true;
    try { replaceBeforeCaret(info, emojiQuery.text.length, document.createTextNode(item[0])); } finally { applying = false; }
    hideEmoji();
  }

  // --- Keyboard: emoji list, tables, toggles ---
  function onKeyDown(ev) {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (emojiEl && !emojiEl.hidden) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); ev.stopImmediatePropagation(); emojiSel = (emojiSel + (ev.key === "ArrowDown" ? 1 : emojiItems.length - 1)) % emojiItems.length; return paintEmoji(); }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); ev.stopImmediatePropagation(); return pickEmoji(); }
      if (ev.key === "Escape") { ev.stopImmediatePropagation(); return hideEmoji(); }
    }
    var cell = ev.target.closest && ev.target.closest('table [contenteditable="true"]');
    if (cell && cell.closest(".easy-table")) return;
    if (cell && blocksEl.contains(cell)) return tableKeys(ev, cell);
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      var at = blockOf(ev.target);
      if (at && at.block.type === "toggle") { ev.preventDefault(); ev.stopImmediatePropagation(); var twist = at.row.querySelector(".twist"); if (twist) twist.click(); }
      else if (at && at.block.type === "to_do") { ev.preventDefault(); ev.stopImmediatePropagation(); var box = at.row.querySelector(".todo-box"); if (box) box.click(); }
    }
  }

  // --- Find and replace (Ctrl+F / Ctrl+H) ---
  var find = null;
  function findTargets() { return Array.prototype.slice.call(blocksEl.querySelectorAll('.text, table [contenteditable="true"]')); }
  function findMatches(query) {
    var out = [];
    if (!query) return out;
    var needle = find.caseSensitive ? query : query.toLowerCase();
    findTargets().forEach(function (host) {
      var text = host.textContent, hay = find.caseSensitive ? text : text.toLowerCase(), at = 0, i;
      while ((i = hay.indexOf(needle, at)) >= 0) {
        var a = point(host, i), b = point(host, i + needle.length), range = document.createRange();
        range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
        out.push({ host: host, start: i, range: range });
        at = i + Math.max(1, needle.length);
      }
    });
    return out;
  }
  function paintFind(scroll) {
    var query = find.input.value;
    find.matches = findMatches(query);
    if (find.current >= find.matches.length) find.current = find.matches.length ? find.matches.length - 1 : 0;
    find.count.textContent = find.matches.length ? (find.current + 1) + "/" + find.matches.length : (query ? "0/0" : "");
    find.count.classList.toggle("none", !!query && !find.matches.length);
    if (window.CSS && CSS.highlights && window.Highlight) {
      CSS.highlights.set("acard-find", new Highlight(...find.matches.map(function (m) { return m.range; })));
      CSS.highlights.set("acard-find-current", new Highlight(...(find.matches[find.current] ? [find.matches[find.current].range] : [])));
    }
    var cur = find.matches[find.current];
    if (cur && scroll) {
      var parent = cur.host.closest(".blk");
      while (parent) { parent.classList.remove("collapsed"); parent = parent.parentElement && parent.parentElement.closest(".blk"); }
      var rect = cur.range.getBoundingClientRect();
      if (rect.top < 80 || rect.bottom > innerHeight - 40) cur.host.scrollIntoView({ block: "center" });
    }
  }
  function stepFind(delta) {
    if (!find.matches.length) return;
    find.current = (find.current + delta + find.matches.length) % find.matches.length;
    paintFind(true);
  }
  function replaceMatch(match, value) {
    match.range.deleteContents();
    if (value) match.range.insertNode(document.createTextNode(value));
  }
  function replaceOne() {
    var cur = find.matches[find.current];
    if (!cur) return;
    var apply = function () { replaceMatch(cur, find.replace.value); cur.host.dispatchEvent(new Event("input", { bubbles: true })); };
    if (editor.coreEditing) editor.transact("replace text", apply); else apply();
    paintFind(true);
  }
  function replaceAll() {
    var count = find.matches.length, hosts = new Set();
    var apply = function () {
      find.matches.slice().reverse().forEach(function (m) { replaceMatch(m, find.replace.value); hosts.add(m.host); });
      hosts.forEach(function (host) { host.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    if (editor.coreEditing) editor.transact("replace all", apply); else apply();
    find.current = 0; paintFind(false);
    editor.setSave(count + "곳을 바꿨어요", false);
  }
  function field(label, cls) {
    var wrap = document.createElement("label"); wrap.className = "af-field " + cls;
    var name = document.createElement("span"); name.className = "af-label"; name.textContent = label;
    var box = document.createElement("span"); box.className = "af-box";
    var input = document.createElement("input"); input.type = "text"; input.setAttribute("aria-label", label); input.autocomplete = "off";
    var clear = document.createElement("button"); clear.type = "button"; clear.className = "af-clear"; clear.setAttribute("aria-label", label + " 지우기"); clear.textContent = "×";
    clear.addEventListener("click", function () { input.value = ""; input.dispatchEvent(new Event("input")); input.focus(); });
    box.appendChild(input); box.appendChild(clear); wrap.appendChild(name); wrap.appendChild(box);
    return { wrap: wrap, input: input, box: box };
  }
  function openFind(replaceFocus) {
    if (!find) {
      var panel = document.createElement("div"); panel.className = "acard-find"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "찾아 바꾸기");
      var close = document.createElement("button"); close.type = "button"; close.className = "af-close"; close.setAttribute("aria-label", "닫기"); close.textContent = "×";
      var f = field("찾기", "af-find"), r = field("바꾸기", "af-replace");
      var count = document.createElement("span"); count.className = "af-count"; count.setAttribute("aria-live", "polite");
      var prev = document.createElement("button"); prev.type = "button"; prev.className = "af-step"; prev.setAttribute("aria-label", "이전 찾기"); prev.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>';
      var next = document.createElement("button"); next.type = "button"; next.className = "af-step"; next.setAttribute("aria-label", "다음 찾기"); next.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
      var caseBtn = document.createElement("button"); caseBtn.type = "button"; caseBtn.className = "af-case"; caseBtn.textContent = "Aa"; caseBtn.title = "대소문자 구분"; caseBtn.setAttribute("aria-pressed", "false");
      var row = document.createElement("div"); row.className = "af-row";
      row.appendChild(f.wrap); row.appendChild(count); row.appendChild(prev); row.appendChild(next);
      var row2 = document.createElement("div"); row2.className = "af-row";
      row2.appendChild(r.wrap); row2.appendChild(caseBtn);
      var one = document.createElement("button"); one.type = "button"; one.className = "af-btn"; one.textContent = "바꾸기";
      var all = document.createElement("button"); all.type = "button"; all.className = "af-btn primary"; all.textContent = "모두 바꾸기";
      var actions = document.createElement("div"); actions.className = "af-actions"; actions.appendChild(one); actions.appendChild(all);
      panel.appendChild(close); panel.appendChild(row); panel.appendChild(row2); panel.appendChild(actions);
      document.body.appendChild(panel);
      find = { panel: panel, input: f.input, replace: r.input, count: count, matches: [], current: 0, caseSensitive: false };
      f.input.addEventListener("input", function () { find.current = 0; paintFind(true); });
      f.input.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); } });
      r.input.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); replaceOne(); } });
      prev.addEventListener("click", function () { stepFind(-1); });
      next.addEventListener("click", function () { stepFind(1); });
      one.addEventListener("click", replaceOne);
      all.addEventListener("click", replaceAll);
      caseBtn.addEventListener("click", function () { find.caseSensitive = !find.caseSensitive; caseBtn.setAttribute("aria-pressed", String(find.caseSensitive)); paintFind(true); });
      close.addEventListener("click", closeFind);
      panel.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { ev.preventDefault(); closeFind(); } });
      editor.on("change", function () { if (!find.panel.hidden) setTimeout(function () { paintFind(false); }, 0); });
    }
    var selected = String(getSelection());
    if (selected && selected.length < 80 && selected.indexOf("\n") < 0) find.input.value = selected;
    find.panel.hidden = false;
    (replaceFocus ? find.replace : find.input).focus();
    find.input.select();
    paintFind(true);
  }
  function closeFind() {
    find.panel.hidden = true;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete("acard-find"); CSS.highlights.delete("acard-find-current"); }
  }

  function addFiles(files, target, point) {
    var under = point && document.elementFromPoint(point.x, point.y);
    var at = blockOf(under && blocksEl.contains(under) ? under : target) || blockOf(document.activeElement);
    editor.lazy("paste-md").then(function (api) { return api.addFiles(files, at, net); }).catch(function (error) { editor.setSave(error.message, true); });
  }
  function onDrop(ev) {
    var files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || !files.length) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    blocksEl.classList.remove("af-dropping");
    addFiles(Array.prototype.slice.call(files), ev.target, { x: ev.clientX, y: ev.clientY });
  }

  // --- Drag: scroll near the edges while a block is dragged ---
  var scrollTimer = null, pointerY = 0;
  function edgeScroll() {
    if (!blocksEl.querySelector(".blk.dragging")) { scrollTimer = null; return; }
    var speed = pointerY < 70 ? -12 : pointerY > innerHeight - 70 ? 12 : 0;
    if (speed) (document.scrollingElement || document.documentElement).scrollBy(0, speed);
    var main = document.getElementById("doc");
    if (speed && main && main.scrollHeight > main.clientHeight) main.scrollBy(0, speed);
    scrollTimer = requestAnimationFrame(edgeScroll);
  }

  // --- Changes from agents or another tab: reload when idle, otherwise offer it ---
  var known = null, notice = null, RELOADED = "acard-editor-next-reloaded";
  function showNotice(text, action) {
    if (!notice) {
      notice = document.createElement("div"); notice.className = "acard-notice"; notice.setAttribute("role", "status");
      notice.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/></svg><span class="an-t"></span><button type="button" class="an-go"></button><button type="button" class="an-x" aria-label="닫기">×</button>';
      notice.querySelector(".an-x").addEventListener("click", function () { notice.hidden = true; });
      document.body.appendChild(notice);
    }
    notice.querySelector(".an-t").textContent = text;
    var go = notice.querySelector(".an-go");
    go.hidden = !action; go.textContent = action ? action.label : "";
    go.onclick = action ? function () { notice.hidden = true; action.run(); } : null;
    notice.hidden = false;
  }
  function apply() {
    try { sessionStorage.setItem(RELOADED, editor.slug); } catch (e) {}
    location.reload();
  }
  function check() {
    if (document.hidden || state().saving) return;
    editor.api("/page/" + encodeURIComponent(editor.slug)).then(function (data) {
      if (known === null || data.page.updated <= known) { if (known === null) known = data.page.updated; return; }
      var busy = state().dirty || state().saving || (document.activeElement && blocksEl.contains(document.activeElement));
      if (!busy) return apply();
      showNotice("다른 곳에서 이 페이지가 바뀌었어요", { label: "불러오기", run: function () { editor.save().then(apply); } });
      known = data.page.updated;
    }).catch(function () {});
  }

  // issue 108: a paste the classic editor held because it landed before this chunk started (editor.js holdPaste).
  function heldPaste(id, html, plain) {
    var row = blocksEl.querySelector('.blk[data-id="' + CSS.escape(id) + '"]');
    var host = row && row.querySelector(".text");
    var at = host && blockOf(host);
    if (!at) return false;
    var info = caret();
    if (!info || info.host !== host) focusText(id);
    pasteInto(at, host, html, plain);
    return true;
  }

  editor.provide("editor-next", { start: function () {
    if (started) return;
    started = true;
    if (window.AcardEditorNext) window.AcardEditorNext.started = true;
    blocksEl.addEventListener("paste", onPaste, true);
    mountAttachments();
    blocksEl.addEventListener("drop", onDrop, true);
    blocksEl.addEventListener("dragover", function (ev) { if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], "Files") >= 0) { ev.preventDefault(); blocksEl.classList.add("af-dropping"); } });
    blocksEl.addEventListener("dragleave", function (ev) { if (!blocksEl.contains(ev.relatedTarget)) blocksEl.classList.remove("af-dropping"); });
    blocksEl.addEventListener("beforeinput", onBeforeInput);
    blocksEl.addEventListener("input", onInput);
    blocksEl.addEventListener("compositionend", function () { setTimeout(function () { refreshEmoji(caret()); }, 0); });
    blocksEl.addEventListener("keydown", onKeyDown, true);
    var selTimer = null, pointerDown = false;
    document.addEventListener("pointerdown", function () { pointerDown = true; }, true);
    document.addEventListener("pointerup", function () { pointerDown = false; }, true);
    document.addEventListener("selectionchange", function () {
      if (emojiEl && !emojiEl.hidden) { var info = caret(); if (!info) hideEmoji(); }
      clearTimeout(selTimer);
      selTimer = setTimeout(function () {
        var sel = getSelection();
        if (pointerDown || !sel.rangeCount || sel.isCollapsed) return;
        var node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        if (node && node.closest(".text") && blocksEl.contains(node)) document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
      }, 250);
    });
    document.addEventListener("pointerdown", function (ev) { if (emojiEl && !emojiEl.contains(ev.target)) hideEmoji(); }, true);
    document.addEventListener("pointermove", function (ev) { pointerY = ev.clientY; if (!scrollTimer && blocksEl.querySelector(".blk.dragging")) scrollTimer = requestAnimationFrame(edgeScroll); }, true);
    document.addEventListener("keydown", function (ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      if (editor.coreEditing && (!ev.target.closest('#doc,.acard-find') || ev.key.toLowerCase() === "h")) return;
      if (mod && !ev.altKey && (ev.key === "f" || ev.key === "F" || ev.key === "h" || ev.key === "H") && !ev.isComposing) {
        ev.preventDefault(); ev.stopImmediatePropagation(); openFind(ev.key.toLowerCase() === "h");
      }
    }, true);
    var send = editor.transport;
    editor.transport = function (slug, payload) {
      return send.call(editor, slug, payload).then(function (res) {
        res.clone().json().then(function (body) { if (body && body.updated) known = Math.max(known || 0, body.updated); }).catch(function () {});
        return res;
      });
    };
    try { if (sessionStorage.getItem(RELOADED) === editor.slug) { sessionStorage.removeItem(RELOADED); showNotice("다른 곳에서 바뀐 내용을 불러왔어요"); } } catch (e) {}
    check();
    setInterval(check, 20000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
  }, paste: heldPaste, openFind: function () { openFind(false); }, htmlBlocks: function (html) { return htmlBlocks(new DOMParser().parseFromString(html, "text/html").body); }, textBlocks: textBlocks });
})();
