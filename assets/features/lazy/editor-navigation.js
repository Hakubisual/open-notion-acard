(function () {
  "use strict";
  var editor = window.AcardEditor, host = document.getElementById("blocks");
  if (!editor || !host) return;
  var panel, list, empty, stats, close, opener, highlighted, inputTarget = null;
  var entries = new Map(), visibleHeadings = 0, firstRow = host.firstElementChild;
  var preference = "acard-editor-spellcheck", spellcheck = false;
  try { spellcheck = localStorage.getItem(preference) === "true"; } catch (error) {}

  function applySpellcheck(root) {
    if (root.matches && root.matches(".text")) root.spellcheck = spellcheck;
    root.querySelectorAll(".text").forEach(function (text) { text.spellcheck = spellcheck; });
  }
  // Once the visuals chunk has loaded, an HTML block's headings are listed too (entry.block = the HTML block's id).
  function headings() {
    var blocks = editor.state.blocks;
    return (window.AcardHtmlHeadings ? window.AcardHtmlHeadings(blocks) : blocks).filter(function (block) { return /^heading[1-4]$/.test(block.type); });
  }
  function addHeading(block, before) {
    var item = document.createElement("li"), link = document.createElement("a");
    item.className = "editor-navigation-level-" + block.type.slice(-1);
    item.hidden = !block.text.trim();
    link.href = "#block-" + encodeURIComponent(block.block || block.id);
    link.textContent = block.text.trim();
    link.addEventListener("click", function (event) {
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!jumpToBlock(block.block || block.id)) return;
      history.replaceState(history.state, "", link.hash);
      // An HTML block heading: then bring its anchor beside the block's frame to the top.
      var spot = block.block && document.getElementById("block-" + block.id);
      if (spot) spot.scrollIntoView({ behavior: "instant" });
    });
    item.appendChild(link); list.insertBefore(item, before || null);
    if (!block.block) entries.set(block.id, link);
  }
  function paintOutline() {
    if (!panel || panel.hidden) return;
    entries.clear(); list.replaceChildren(); visibleHeadings = 0;
    headings().forEach(function (block) { addHeading(block); if (block.text.trim()) visibleHeadings++; });
    empty.hidden = visibleHeadings > 0;
  }
  function closeOutline(restore) {
    if (!panel) return;
    panel.hidden = true;
    if (restore && opener && opener.isConnected) opener.focus({ preventScroll: true });
  }
  function mount() {
    if (panel) return;
    panel = document.createElement("aside"); panel.className = "editor-navigation"; panel.id = "editor-navigation"; panel.hidden = true;
    panel.setAttribute("aria-labelledby", "editor-navigation-title");
    var header = document.createElement("div"), title = document.createElement("h2");
    header.className = "editor-navigation-header"; title.id = "editor-navigation-title"; title.textContent = "목차";
    close = document.createElement("button"); close.type = "button"; close.className = "mini"; close.textContent = "닫기";
    close.addEventListener("click", function () { closeOutline(true); });
    header.append(title, close);
    var nav = document.createElement("nav"); nav.setAttribute("aria-label", "페이지 목차");
    list = document.createElement("ol"); empty = document.createElement("p"); empty.className = "editor-navigation-empty"; empty.textContent = "제목 블록을 추가하면 목차에 표시돼요.";
    nav.append(list, empty);
    stats = document.createElement("p"); stats.className = "editor-navigation-stats";
    panel.append(header, nav, stats);
    panel.addEventListener("keydown", function (event) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeOutline(true); } });
    document.body.appendChild(panel);
  }
  function countWords(texts) {
    var words = 0, characters = 0, charactersWithoutSpaces = 0;
    var segmenter = new Intl.Segmenter("ko", { granularity: "word" });
    // Characters are Unicode code points (not graphemes); \s removes spaces, tabs and
    // newlines. Stored/selected newlines count, but no block separators are inserted.
    texts.forEach(function (text) {
      characters += Array.from(text).length;
      charactersWithoutSpaces += Array.from(text.replace(/\s/gu, "")).length;
      for (var part of segmenter.segment(text)) if (part.isWordLike) words++;
    });
    return { words: words, characters: characters, charactersWithoutSpaces: charactersWithoutSpaces, readingMinutes: Math.ceil(words / 200) };
  }
  function selectionStats() {
    // An unrelated input can retain a stale DOM selection in the editor.
    var active = document.activeElement;
    if (active && (active.matches("input:not([type=checkbox]), textarea") || active.matches("[contenteditable]") && (!active.matches(".text") || !host.contains(active)))) return null;
    var ids = new Set(editor.getSelection().blockIds);
    if (ids.size) {
      var texts = [], selectedDepth = null;
      editor.state.blocks.forEach(function (block) {
        var depth = Math.max(0, Math.trunc(Number(block.indent) || 0));
        if (selectedDepth !== null && depth <= selectedDepth) selectedDepth = null;
        if (selectedDepth === null && ids.has(block.id)) selectedDepth = depth;
        if (selectedDepth !== null) texts.push(block.text || "");
      });
      return texts.length ? Object.assign(countWords(texts), { scope: "blocks" }) : null;
    }
    var selection = window.getSelection();
    function inEditorText(node) {
      var element = node && (node.nodeType === 1 ? node : node.parentElement);
      var text = element && element.closest('.text[contenteditable="true"]');
      return text && host.contains(text);
    }
    if (!selection || selection.isCollapsed || !inEditorText(selection.anchorNode) || !inEditorText(selection.focusNode)) return null;
    return Object.assign(countWords([selection.toString()]), { scope: "text" });
  }
  function openOutline() {
    // Capture before mounting/focusing the panel changes the active selection.
    var selected = selectionStats();
    mount();
    if (panel.hidden) opener = document.activeElement;
    panel.hidden = false; paintOutline();
    // Body text only; the page title is excluded from document and block counts.
    var result = countWords(editor.state.blocks.map(function (block) { return block.text || ""; }));
    result.selection = selected;
    function summary(value) {
      return value.words + " 단어 · " + value.characters + "자 (공백 제외 " + value.charactersWithoutSpaces + "자) · 읽기 약 " + value.readingMinutes + "분";
    }
    var documentStats = document.createElement("span"), selectedStats = document.createElement("span");
    documentStats.dataset.scope = "document"; documentStats.textContent = "문서: " + summary(result);
    selectedStats.dataset.scope = "selection"; selectedStats.textContent = "선택: " + (selected ? summary(selected) : "없음");
    stats.replaceChildren(documentStats, document.createElement("br"), selectedStats);
    close.focus({ preventScroll: true });
    return result;
  }
  function jumpToBlock(id) {
    var row = document.getElementById("block-" + id);
    if (!row || !host.contains(row)) return false;
    var changed = false;
    for (var parent = row.parentElement; parent && parent !== host; parent = parent.parentElement) {
      if (!parent.matches(".blk[data-id]")) continue;
      var block = editor.state.blocks.find(function (entry) { return entry.id === parent.dataset.id; });
      if (!block || !(block.type === "toggle" || /^heading[1-4]$/.test(block.type) && block.meta && block.meta.toggle || editor.coreEditing && /^(bulleted|numbered)$/.test(block.type))) continue;
      if (!block.meta || !block.meta.open) { block.meta = Object.assign({}, block.meta, { open: true }); changed = true; }
      parent.classList.remove("collapsed");
      var twist = parent.querySelector(":scope > .body > .trow > .twist");
      if (twist) { twist.classList.add("open"); twist.setAttribute("aria-expanded", "true"); }
    }
    if (changed) editor.scheduleSave();
    if (window.matchMedia("(max-width: 899px)").matches) closeOutline(false);
    if (highlighted) highlighted.classList.remove("editor-navigation-target");
    highlighted = row; row.classList.add("editor-navigation-target");
    var text = row.querySelector(":scope > .body > .text, :scope > .body > .trow > .text");
    if (!text) row.tabIndex = -1;
    (text || row).focus({ preventScroll: true });
    row.scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  }
  function followHash() {
    if (location.hash.indexOf("#block-") !== 0) return;
    var id;
    try { id = decodeURIComponent(location.hash.slice(7)); } catch (error) { return; }
    jumpToBlock(id);
  }
  function rendered() {
    if (firstRow === host.firstElementChild) return false;
    firstRow = host.firstElementChild;
    renderObserver.takeRecords();
    applySpellcheck(host); paintOutline(); return true;
  }
  // The current renderer replaces #blocks' direct children. Do not observe text mutations
  // or the subtree: a keystroke must never trigger a full-page spellcheck/outline scan.
  var renderObserver = new MutationObserver(function (records) {
    if (rendered()) return;
    records.forEach(function (record) { record.addedNodes.forEach(function (node) { if (node.nodeType === 1) applySpellcheck(node); }); });
    paintOutline();
  });
  renderObserver.observe(host, { childList: true });
  document.addEventListener("input", function (event) {
    inputTarget = event.target;
    queueMicrotask(function () { inputTarget = null; });
  }, true);
  editor.on("change", function () {
    var target = inputTarget; inputTarget = null;
    if (rendered() || !panel || panel.hidden) return;
    if (target) {
      var row = target.closest(".blk[data-id]"), block = row && editor.state.blocks[Number(row.dataset.index)];
      if (!block || block.id !== row.dataset.id) return;
      // HTML source typing can add or rename the headings it lists; that block is the only one re-read.
      if (block.type === "html") { paintOutline(); return; }
      var link = entries.get(block.id), heading = /^heading[1-4]$/.test(block.type) && block.text.trim();
      if (link) {
        var wasVisible = !link.parentElement.hidden;
        link.textContent = block.text.trim(); link.parentElement.hidden = !heading;
        visibleHeadings += Number(!!heading) - Number(wasVisible);
      }
      // Empty headings retain their ordered hidden slot, so their first character
      // never scans other outline entries or document blocks.
      empty.hidden = visibleHeadings > 0;
      return;
    }
    // Command/structural changes have no input target. Reconcile only while visible.
    paintOutline();
  });
  var api = {
    openOutline: openOutline,
    jumpToBlock: jumpToBlock,
    wordStats: openOutline,
    toggleFocus: function () { return host.classList.toggle("editor-navigation-focus"); },
    setSpellcheck: function (enabled) {
      spellcheck = !!enabled;
      try { localStorage.setItem(preference, String(spellcheck)); } catch (error) {}
      applySpellcheck(host); return spellcheck;
    },
    jumpToTop: function () { var block = editor.state.blocks[0]; return block ? jumpToBlock(block.id) : false; },
    jumpToBottom: function () { var blocks = editor.state.blocks, block = blocks[blocks.length - 1]; return block ? jumpToBlock(block.id) : false; }
  };
  Object.assign(editor.commands || (editor.commands = {}), api);
  editor.provide("editor-navigation", api);
  applySpellcheck(host);
  window.addEventListener("hashchange", followHash);
  editor.on("ready", function () { rendered(); followHash(); });
})();
