(function () {
  "use strict";
  var editor = window.AcardEditor, model = window.EditorModel, columns = window.ColumnsModel;
  if (!editor) return;
  function blocks() { return editor.state.blocks; }
  function id() { return editor.createBlock().id; }
  function at(key) { return blocks().findIndex(function (b) { return b.id === key; }); }
  function roots(ids) {
    var selected = new Set(ids), result = [], end = 0;
    blocks().forEach(function (b, i) { if (i >= end && selected.has(b.id)) { end = model.endOf(blocks(), i); result.push({ index: i, end: end, block: b }); } });
    return result;
  }
  function caret(blockId, offset) { return { anchor: { kind: "text", blockId: blockId, offset: offset }, focus: { kind: "text", blockId: blockId, offset: offset }, selectedBlockIds: [] }; }
  function runs(block) { return model.richText(block.meta && block.meta.richText, block.text); }
  function slice(input, start, end) {
    var offset = 0, out = [];
    input.forEach(function (run) { var left = Math.max(0, start - offset), right = Math.min(run.text.length, end - offset); if (right > left) out.push(Object.assign({}, run, { text: run.text.slice(left, right) })); offset += run.text.length; });
    return out;
  }
  function write(block, rich) { block.text = rich.map(function (run) { return run.text; }).join(""); block.meta = Object.assign({}, block.meta, { richText: rich }); }
  function textBlock(block) { return /^(paragraph|heading[1-4]|bulleted|numbered|to_do|toggle|quote|callout|code)$/.test(block.type); }
  var rangeAnchor = null, rangeFocus = null;
  function selected(ids) { editor.selectBlocks(ids); rangeAnchor = ids[0] || null; rangeFocus = ids[ids.length - 1] || null; }
  function moveSelected(ids, direction) {
    var groups = roots(ids); if (!groups.length) return false;
    var edge = direction < 0 ? groups[0] : groups[groups.length - 1];
    var index = direction < 0 ? edge.index - 1 : edge.end, depth = model.depth(edge.block);
    while (index >= 0 && index < blocks().length && model.depth(blocks()[index]) > depth) index += direction;
    if (index < 0 || index >= blocks().length || model.depth(blocks()[index]) !== depth) return false;
    return commands.moveBlocks(ids, direction < 0 ? { beforeId: blocks()[index].id } : { afterId: blocks()[index].id });
  }
  // Only a flat text-only permutation can reuse rows: other rows own index-bound widgets, and nested lists
  // derive their twist from their children. Keep these on the full renderer. The existing objects must survive
  // normalization unchanged; undo/redo, type changes and ordinary edits still use the full renderer.
  function moveRenderer() {
    if (!editor.coreEditing || blocks().some(function (b) { return model.depth(b) || !textBlock(b); })) return;
    var host = document.getElementById("blocks"), rows = new Map();
    blocks().forEach(function (b, i) { var row = host.children[i]; if (row && row.dataset.id === b.id) rows.set(b, row); });
    return function () {
      if (rows.size !== blocks().length || blocks().some(function (b) { return model.depth(b) || !rows.has(b); })) return false;
      var next = host.firstElementChild;
      blocks().forEach(function (b, i) {
        var row = rows.get(b);
        if (row !== next) host.insertBefore(row, next);
        else next = next.nextElementSibling;
        row.dataset.index = String(i);
      });
      return true;
    };
  }
  function choosePage(ids) {
    var dialog = document.createElement("dialog"); dialog.className = "editor-panel";
    var title = document.createElement("h2"); title.textContent = "다른 페이지로 이동";
    var close = document.createElement("button"); close.type = "button"; close.className = "mini"; close.textContent = "닫기"; close.onclick = function () { dialog.close(); };
    var label = document.createElement("label"); label.textContent = "대상 페이지";
    var select = document.createElement("select");
    // The page list from load time can be a cached preview; refresh it so a page made a moment ago is offered too.
    editor.api("/tree").then(function (data) { if (!dialog.open || !data || !data.pages) return; var keep = select.value; editor.state.pages = data.pages; select.textContent = ""; fill(); if (keep) select.value = keep; move.disabled = !select.options.length; }, function () {});
    function fill() { editor.state.pages.filter(function (page) { return page.slug !== editor.slug && page.kind !== "db"; }).forEach(function (page) { var option = document.createElement("option"); option.value = page.slug; option.textContent = page.title; select.appendChild(option); }); }
    fill();
    label.appendChild(select);
    var move = document.createElement("button"); move.type = "button"; move.className = "mini"; move.textContent = "옮기기"; move.disabled = !select.options.length;
    var status = document.createElement("p"); status.setAttribute("role", "status");
    move.onclick = async function () {
      move.disabled = true;
      try { await commands.moveBlocksToPage(ids, select.value); dialog.close(); editor.setSave("블록을 옮겼어요. Ctrl+Z로 되돌릴 수 있어요.", false); }
      catch (error) { status.textContent = error.message; move.disabled = false; }
    };
    dialog.append(title, close, label, move, status); dialog.addEventListener("close", function () { dialog.remove(); }); document.body.appendChild(dialog); dialog.showModal();
  }
  var commands = {
    splitCurrent: function (key) { return commands.splitBlock(key, editor.captureSelection()); },
    run: function (name, args, before) {
      if (JSON.stringify({ title: editor.state.title, blocks: blocks() }) !== before) throw Error("conflict");
      return editor.commands[name](...args);
    },
    restoreExternal: function (from, to) {
      var entry = from[from.length - 1]; if (entry.busy) return;
      entry.busy = true;
      return entry.run().then(function () { var index = from.indexOf(entry); if (index >= 0) from.splice(index, 1); to.push(entry); }, function (error) { editor.setSave(error.message, true); }).finally(function () { entry.busy = false; });
    },
    textKey: function (ev, key) {
      var index = at(key), block = blocks()[index], mod = ev.ctrlKey || ev.metaKey;
      if (!block || ev.isComposing || ev.keyCode === 229) return false;
      if (ev.key === "Tab") {
        if (document.documentElement.getAttribute("data-human-edit") === "on" && block.type === "paragraph" && !block.text && !ev.shiftKey && !mod && !ev.altKey) return false;
        return !/^(bulleted|numbered|to_do)$/.test(block.type);
      }
      if (ev.key === "ArrowUp" || ev.key === "ArrowDown") return true;
      if (!["escape", "enter", "backspace", "delete", "a", "d"].includes(ev.key.toLowerCase())) return false;
      if (/^[ad]$/i.test(ev.key) && !mod) return false;
      var selection = editor.captureSelection(), anchor = selection.anchor, focus = selection.focus;
      var collapsed = anchor && focus && anchor.blockId === focus.blockId && anchor.offset === focus.offset;
      if (ev.key === "Escape" || (mod && !ev.shiftKey && ev.key.toLowerCase() === "a" && anchor && focus && anchor.blockId === key && focus.blockId === key && Math.abs(anchor.offset - focus.offset) === block.text.length)) {
        ev.preventDefault(); selected([key]); var host = document.getElementById("blocks"); host.tabIndex = -1; host.focus({ preventScroll: true }); return true;
      }
      if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "d") { ev.preventDefault(); commands.duplicateBlocks([key]); return true; }
      if (ev.key === "Enter" && !ev.shiftKey && !mod && block.type !== "code" && !(!block.text && /^(bulleted|numbered|to_do)$/.test(block.type))) { ev.preventDefault(); commands.splitBlock(key, selection); return true; }
      if (collapsed && ev.key === "Backspace" && anchor.offset === 0 && index > 0) {
        if (model.depth(block) > model.depth(blocks()[index - 1])) {
          ev.preventDefault(); commands.indentBlocks([key], -1); return true;
        }
        var previous = index - 1;
        while (previous >= 0 && model.depth(blocks()[previous]) > model.depth(block)) previous--;
        if (previous >= 0 && model.depth(blocks()[previous]) === model.depth(block)) { ev.preventDefault(); commands.mergeBlocks([blocks()[previous].id, key]); return true; }
      }
      if (ev.key === "Backspace" && !block.text && model.endOf(blocks(), index) > index + 1) { ev.preventDefault(); return true; }
      if (collapsed && ev.key === "Delete" && anchor.offset === block.text.length) {
        var next = model.endOf(blocks(), index);
        if (next < blocks().length && model.depth(blocks()[next]) === model.depth(block)) { ev.preventDefault(); commands.mergeBlocks([key, blocks()[next].id]); return true; }
      }
      return false;
    },
    blockKey: function (ev) {
      var ids = editor.getSelection().blockIds, mod = ev.ctrlKey || ev.metaKey;
      if (!ids.length || ev.isComposing || ev.keyCode === 229 || ev.target.closest('[contenteditable="true"],textarea,input:not(.block-select)')) return false;
      if (ev.key === "Escape") { ev.preventDefault(); selected([]); var first = document.querySelector('[data-id="' + CSS.escape(ids[0]) + '"] .text'); if (first) first.focus(); return true; }
      if (ev.key === "Tab") { ev.preventDefault(); commands.indentBlocks(ids, ev.shiftKey ? -1 : 1); return true; }
      if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); commands.deleteBlocks(ids); return true; }
      if (mod && ev.key.toLowerCase() === "d") { ev.preventDefault(); commands.duplicateBlocks(ids); return true; }
      if (mod && ev.key.toLowerCase() === "a") { ev.preventDefault(); selected(blocks().map(function (b) { return b.id; })); return true; }
      if (ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
        ev.preventDefault(); var direction = ev.key === "ArrowUp" ? -1 : 1;
        var indexes = ids.map(at).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
        if (!indexes.length) return true;
        if (!mod) {
          if (!rangeAnchor || ids.indexOf(rangeAnchor) < 0) { rangeAnchor = ids[0]; rangeFocus = ids[ids.length - 1]; }
          var neighbor = at(rangeFocus) + direction;
          if (neighbor >= 0 && neighbor < blocks().length) commands.selectBlockRange(rangeAnchor, blocks()[neighbor].id);
        } else {
          moveSelected(ids, direction);
        }
        return true;
      }
      return false;
    },
    selectBlocks: selected,
    clearBlockSelection: function () { selected([]); },
    selectBlockRange: function (anchorId, focusId, additive) {
      var a = at(anchorId), b = at(focusId); if (a < 0 || b < 0) return false;
      var ids = blocks().slice(Math.min(a, b), Math.max(a, b) + 1).map(function (block) { return block.id; });
      editor.selectBlocks(additive ? editor.getSelection().blockIds.concat(ids) : ids); rangeAnchor = anchorId; rangeFocus = focusId; return true;
    },
    moveBlocks: function (ids, target) {
      var groups = roots(ids); if (!groups.length) return false;
      var key = target.beforeId || target.afterId || target.parentId, index = at(key);
      if (index < 0 || [target.beforeId, target.afterId, target.parentId].filter(Boolean).length !== 1) return false;
      var covered = new Set(); groups.forEach(function (g) { blocks().slice(g.index, g.end).forEach(function (b) { covered.add(b.id); }); });
      if (covered.has(key)) return false;
      var targetDepth = model.depth(blocks()[index]) + (target.parentId ? 1 : 0);
      if (groups.some(function (g) { return blocks().slice(g.index, g.end).some(function (b) { return model.depth(b) + targetDepth - model.depth(g.block) > 6; }); })) return false;
      var position = target.beforeId ? index : model.endOf(blocks(), index);
      var renderMove = targetDepth === 0 ? moveRenderer() : null;
      return editor.transact("move blocks", function () {
        var moving = [], before = blocks().slice(0, position).filter(function (b) { return !covered.has(b.id); }).length;
        groups.forEach(function (g) { var offset = targetDepth - model.depth(g.block); blocks().slice(g.index, g.end).forEach(function (b) { b.indent = model.depth(b) + offset; moving.push(b); }); });
        var remaining = blocks().filter(function (b) { return !covered.has(b.id); });
        remaining.splice.apply(remaining, [before, 0].concat(moving)); editor.state.blocks = remaining;
      }, { render: renderMove });
    },
    dropBlocks: function (ids, target, placement) { return commands.moveBlocks(ids, { [placement]: target }); },
    // M07: while a block drag rests within 48px of the window's top or bottom edge, scroll one frame at a time and re-aim
    // the drop at the block now under the pointer. One rAF loop per drag; stops on release or away from the edge.
    dragEdge: function (point, aim, active) {
      var d = commands.dragEdge.state || (commands.dragEdge.state = {});
      d.point = point; d.aim = aim; d.active = active;
      if (d.frame) return;
      var tick = function () {
        var y = d.point.clientY, step = y < 48 ? y - 48 : y > innerHeight - 48 ? y - innerHeight + 48 : 0;
        if (!d.active() || !step) { d.frame = 0; return; }
        // instant: the page sets scroll-behavior:smooth, and a smooth step restarted every frame barely moves.
        window.scrollBy({ top: Math.max(-24, Math.min(24, step / 2)), behavior: "instant" });
        d.aim(d.point);
        d.frame = requestAnimationFrame(tick);
      };
      d.frame = requestAnimationFrame(tick);
    },
    moveBlockUp: function (key) {
      var index = at(key); if (index < 0) return false;
      var depth = model.depth(blocks()[index]), previous = index - 1;
      while (previous >= 0 && model.depth(blocks()[previous]) > depth) previous--;
      return previous >= 0 && model.depth(blocks()[previous]) === depth ? commands.moveBlocks([key], { beforeId: blocks()[previous].id }) : false;
    },
    moveBlockDown: function (key) {
      var index = at(key); if (index < 0) return false;
      var next = model.endOf(blocks(), index);
      return next < blocks().length && model.depth(blocks()[next]) === model.depth(blocks()[index]) ? commands.moveBlocks([key], { afterId: blocks()[next].id }) : false;
    },
    moveBlocksToPage: async function (ids, target) {
      await editor.lazy("editor-selection");
      await editor.save();
      var sourceVersion = editor.state.baseUpdated, sourceText = JSON.stringify(blocks());
      var destination = await editor.api("/page/" + encodeURIComponent(target));
      if (editor.state.dirty || editor.state.saving || JSON.stringify(blocks()) !== sourceText) throw Error("내용이 바뀌었어요. 동작을 다시 눌러 주세요.");
      var doc = document.getElementById("doc"), wasInert = doc.inert;
      doc.inert = true;
      try {
        var moved = await editor.api("/page/" + encodeURIComponent(editor.slug) + "/move-blocks", { method: "POST", body: JSON.stringify({ target: target, ids: ids, source_updated: sourceVersion, target_updated: destination.page.updated }) });
        var current = await editor.api("/page/" + encodeURIComponent(editor.slug));
        if (editor.state.dirty || JSON.stringify(blocks()) !== sourceText) throw Error("이동은 저장됐어요. 현재 초안을 보관하고 새로고침해 주세요.");
        editor.adoptRemote({ title: current.page.title, blocks: current.blocks, updated: current.page.updated });
        var receipt = moved.receipt;
        editor.recordExternalEdit(async function () {
          if (editor.state.dirty || editor.state.saving) throw Error("수정 내용을 먼저 저장해 주세요.");
          var beforeInert = doc.inert; doc.inert = true;
          try {
            var result = await editor.api(receipt.inverse.path.replace(/^\/api/, ""), { method: "POST", body: JSON.stringify(receipt.inverse.body) });
            var latest = await editor.api("/page/" + encodeURIComponent(editor.slug));
            editor.adoptRemote({ title: latest.page.title, blocks: latest.blocks, updated: latest.page.updated });
            receipt = result.receipt;
          } finally { doc.inert = beforeInert; }
        });
        return receipt;
      } finally { doc.inert = wasInert; }
    },
    moveTo: choosePage,
    duplicateBlocks: function (ids) {
      var groups = roots(ids), added = [];
      editor.transact("duplicate blocks", function (tx) {
        for (var i = groups.length - 1; i >= 0; i--) {
          var g = groups[i], copy = JSON.parse(JSON.stringify(blocks().slice(g.index, g.end)));
          copy.forEach(function (b) { b.id = id(); });
          blocks().splice.apply(blocks(), [g.end, 0].concat(copy)); added.unshift(copy[0].id);
        }
        if (added.length) tx.setSelection({ anchor: null, focus: null, selectedBlockIds: added });
      });
      return added;
    },
    deleteBlocks: function (ids) {
      var groups = roots(ids); if (!groups.length) return false;
      return editor.transact("delete blocks", function (tx) {
        for (var i = groups.length - 1; i >= 0; i--) blocks().splice(groups[i].index, groups[i].end - groups[i].index);
        if (!blocks().length) blocks().push({ id: id(), type: "paragraph", text: "", indent: 0, checked: false, meta: null });
        var focus = blocks()[Math.min(groups[0].index, blocks().length - 1)]; tx.setSelection(caret(focus.id, 0));
      });
    },
    colorBlocks: function (ids, color) {
      var groups = roots(ids); if (!groups.length || typeof color !== "string") return false;
      return editor.transact("color blocks", function () {
        groups.forEach(function (g) { var meta = Object.assign({}, g.block.meta); if (color === "default") delete meta.color; else meta.color = color; g.block.meta = Object.keys(meta).length ? meta : null; });
      });
    },
    setTypeBlocks: function (ids, type) {
      var groups = roots(ids), heading = /^toggle_(heading[1-3])$/.exec(type);
      if (!groups.length || !/^(paragraph|heading[1-4]|toggle_heading[1-3]|bulleted|numbered|to_do|toggle|quote|callout|code)$/.test(type)) return false;
      return editor.transact("change block type", function () {
        groups.forEach(function (g) {
          if (!textBlock(g.block)) return;
          var meta = Object.assign({}, g.block.meta); delete meta.toggle; delete meta.open;
          if (heading) { meta.toggle = true; meta.open = true; }
          g.block.type = heading ? heading[1] : type; g.block.meta = Object.keys(meta).length ? meta : null;
        });
      });
    },
    indentBlocks: function (ids, delta) {
      if (delta !== 1 && delta !== -1) return false;
      var groups = roots(ids);
      return editor.transact("indent blocks", function () {
        groups.forEach(function (g) { var index = at(g.block.id); if (columns.canIndent(blocks(), index, delta)) model.indent(blocks(), index, delta); });
      });
    },
    setBlockType: function (ids, type) {
      if (!/^(paragraph|heading[1-4]|bulleted|numbered|to_do|toggle|quote|callout|code)$/.test(type)) return false;
      return editor.transact("change block type", function () { roots(ids).forEach(function (g) { if (textBlock(g.block)) g.block.type = type; }); });
    },
    setBlockColor: function (ids, color) {
      if (color !== "default" && !/^(gray|brown|orange|yellow|green|blue|purple|pink|red)(_background)?$/.test(color)) return false;
      return editor.transact("color blocks", function () { roots(ids).forEach(function (g) { g.block.meta = Object.assign({}, g.block.meta); if (color === "default") delete g.block.meta.color; else g.block.meta.color = color; }); });
    },
    insertBlocks: function (incoming, selection) {
      if (!incoming.length || !selection.anchor || !selection.focus || selection.anchor.kind !== "text" || selection.focus.kind !== "text") return false;
      var a = at(selection.anchor.blockId), f = at(selection.focus.blockId); if (a < 0 || f < 0) return false;
      var start = a <= f ? selection.anchor : selection.focus, end = a <= f ? selection.focus : selection.anchor;
      if (a === f && start.offset > end.offset) { var swap = start; start = end; end = swap; }
      var from = at(start.blockId), to = at(end.blockId), first = blocks()[from], last = blocks()[to];
      if (blocks().slice(from, to + 1).some(function (b) { return !textBlock(b); })) return false;
      var prefix = slice(runs(first), 0, start.offset), suffix = slice(runs(last), end.offset, last.text.length);
      return editor.transact("paste blocks", function (tx) {
        var base = model.depth(first), copies = incoming.map(function (b) { var copy = Object.assign(editor.createBlock(), JSON.parse(JSON.stringify(b))); copy.id = id(); copy.indent = base + (b.indent || 0); return copy; });
        var keepFirst = prefix.length > 0 || model.endOf(blocks(), from) > from + 1;
        if (keepFirst) write(first, prefix);
        if (from !== to) blocks().splice(from + 1, to - from);
        var position = keepFirst ? model.endOf(blocks(), from) : from;
        if (!keepFirst) blocks().splice(from, 1);
        var lastCopy = copies[copies.length - 1], offset = (lastCopy.text || "").length;
        if (suffix.length) {
          var tail = Object.assign(editor.createBlock(), { text: "", indent: base }); write(tail, suffix); copies.push(tail);
        }
        blocks().splice.apply(blocks(), [position, 0].concat(copies));
        tx.setSelection(caret(lastCopy.id, offset));
      }, { beforeSelection: selection });
    },
    splitBlock: function (key, selection) {
      var index = at(key), block = blocks()[index];
      if (!block || !textBlock(block) || !selection.anchor || !selection.focus || selection.anchor.blockId !== key || selection.focus.blockId !== key) return false;
      var start = Math.min(selection.anchor.offset, selection.focus.offset), end = Math.max(selection.anchor.offset, selection.focus.offset), rich = runs(block);
      if (start < 0 || end > block.text.length) return false;
      return editor.transact("split block", function (tx) {
        var next = { id: id(), type: /^(bulleted|numbered|to_do|code)$/.test(block.type) ? block.type : "paragraph", text: "", checked: false, indent: block.indent, meta: block.meta && block.meta.ai ? { ai: block.meta.ai } : null };
        write(next, slice(rich, end, block.text.length)); write(block, slice(rich, 0, start));
        blocks().splice(model.endOf(blocks(), index), 0, next); tx.setSelection(caret(next.id, 0));
      }, { beforeSelection: selection });
    },
    mergeBlocks: function (ids) {
      var indexes = ids.map(at); if (indexes.length < 2 || indexes.some(function (i) { return i < 0; })) return false;
      indexes.sort(function (a, b) { return a - b; });
      for (var i = 1; i < indexes.length; i++) if (indexes[i] !== model.endOf(blocks(), indexes[i - 1]) || model.depth(blocks()[indexes[i]]) !== model.depth(blocks()[indexes[0]])) return false;
      if (indexes.some(function (i) { return !textBlock(blocks()[i]) || blocks()[i].type === "code"; })) return false;
      if (indexes.some(function (i) { return (blocks()[i].meta && blocks()[i].meta.ai || "") !== (blocks()[indexes[0]].meta && blocks()[indexes[0]].meta.ai || ""); })) return false;
      var first = blocks()[indexes[0]], offset = first.text.length;
      return editor.transact("merge blocks", function (tx) {
        var rich = runs(first);
        indexes.slice(1).forEach(function (i) { rich = rich.concat(runs(blocks()[i])); }); write(first, rich);
        for (var n = indexes.length - 1; n > 0; n--) blocks().splice(indexes[n], 1);
        tx.setSelection(caret(first.id, offset));
      });
    },
    pastePlain: function (text, selection) {
      if (!selection.anchor || !selection.focus || selection.anchor.kind !== "text" || selection.focus.kind !== "text") return false;
      var a = at(selection.anchor.blockId), f = at(selection.focus.blockId); if (a < 0 || f < 0) return false;
      var start = a <= f ? selection.anchor : selection.focus, end = a <= f ? selection.focus : selection.anchor;
      if (a === f && start.offset > end.offset) { var swap = start; start = end; end = swap; }
      var first = blocks()[at(start.blockId)], last = blocks()[at(end.blockId)];
      if (!textBlock(first) || !textBlock(last)) return false;
      var from = at(first.id), to = at(last.id);
      if (blocks().slice(from, to + 1).some(function (b) { return !textBlock(b); }) || start.offset < 0 || end.offset > last.text.length) return false;
      return editor.transact("paste plain", function (tx) {
        var before = slice(runs(first), 0, start.offset), after = slice(runs(last), end.offset, last.text.length);
        if (from !== to) blocks().splice(from + 1, to - from);
        write(first, before.concat([{ text: String(text).replace(/\r\n?/g, "\n") }], after));
        tx.setSelection(caret(first.id, start.offset + String(text).replace(/\r\n?/g, "\n").length));
      }, { beforeSelection: selection });
    }
  };
  Object.assign(editor.commands || (editor.commands = {}), commands);
  Object.assign(editor.commands, {
    duplicate: function (key) { var ids = commands.duplicateBlocks([key]); return blocks().find(function (b) { return b.id === ids[0]; }); },
    move: function (key, delta) { return delta < 0 ? commands.moveBlockUp(key) : commands.moveBlockDown(key); },
    indent: function (key, delta) { return commands.indentBlocks([key], delta); },
    remove: function (key) { return commands.deleteBlocks([key]); },
    setType: function (key, type) { return commands.setBlockType([key], type); }
  });
  var menuRegistered = false;
  function registerMenus() {
    if (!editor.contextMenu || !editor.contextMenu.register || menuRegistered) return;
    menuRegistered = true;
    [
      ["core-duplicate", "선택 블록 복제", "duplicateBlocks"],
      ["core-delete", "선택 블록 삭제", "deleteBlocks"],
      ["core-merge", "선택 문단 합치기", "mergeBlocks"]
    ].forEach(function (entry) {
      editor.contextMenu.register({ id: entry[0], label: entry[1], scope: "block", group: "edit", when: function () { return editor.getSelection().blockIds.length > 1; }, run: function () { return commands[entry[2]](editor.getSelection().blockIds); } });
    });
    editor.contextMenu.register({ id: "core-move-page", label: "다른 페이지로 이동", scope: "block", group: "move", run: function (ctx) { choosePage(editor.getSelection().blockIds.length ? editor.getSelection().blockIds : [ctx.blockId]); } });
  }
  registerMenus();
  if (editor.on) editor.on("ready", registerMenus);
  document.addEventListener("contextmenu", registerMenus, true);
  if (editor.on) editor.on("selection", registerMenus);
  if (editor.coreEditing) {
    var host = document.getElementById("blocks"), tools = document.createElement("div"), count = document.createElement("span");
    host.classList.add("core-block-mode");
    tools.className = "core-selection-tools"; tools.hidden = true; tools.setAttribute("role", "toolbar"); tools.setAttribute("aria-label", "선택 블록 도구");
    count.className = "core-selection-count"; tools.appendChild(count); host.before(tools);
    var COLORS = [["default", "기본"], ["gray", "회색"], ["brown", "갈색"], ["orange", "주황"], ["yellow", "노랑"], ["green", "초록"], ["blue", "파랑"], ["purple", "보라"], ["pink", "분홍"], ["red", "빨강"]];
    var TYPES = [["paragraph", "글"], ["heading1", "제목 1"], ["heading2", "제목 2"], ["heading3", "제목 3"], ["bulleted", "글머리 목록"], ["numbered", "번호 목록"], ["to_do", "할 일"], ["toggle", "토글"], ["quote", "인용"], ["callout", "콜아웃"]];
    var picker = null;
    function closePicker() { if (picker) { picker.remove(); picker = null; } }
    function openPicker(anchor, label, choices, apply) {
      closePicker();
      picker = document.createElement("div"); picker.className = "core-selection-picker"; picker.setAttribute("role", "menu"); picker.setAttribute("aria-label", label);
      choices.forEach(function (choice) {
        var item = document.createElement("button"); item.type = "button"; item.className = "mini"; item.setAttribute("role", "menuitem"); item.textContent = choice[1];
        item.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
        item.addEventListener("click", function () { apply(editor.getSelection().blockIds, choice[0]); closePicker(); paintSelection(); });
        picker.appendChild(item);
      });
      picker.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { ev.preventDefault(); closePicker(); anchor.focus(); } });
      tools.appendChild(picker); picker.firstChild.focus();
    }
    [["복제", function (ids) { commands.duplicateBlocks(ids); }], ["삭제", function (ids) { commands.deleteBlocks(ids); }], ["위로", function (ids) { moveSelected(ids, -1); }], ["아래로", function (ids) { moveSelected(ids, 1); }],
      ["색", function (ids, button) { openPicker(button, "선택 블록 색", COLORS, commands.colorBlocks); }, true],
      ["형식", function (ids, button) { openPicker(button, "선택 블록 형식", TYPES, commands.setTypeBlocks); }, true],
      ["옮기기", choosePage], ["선택 해제", function () { closePicker(); selected([]); }]].forEach(function (entry) {
      var button = document.createElement("button"); button.type = "button"; button.className = "mini"; button.textContent = entry[0];
      if (entry[2]) button.setAttribute("aria-haspopup", "menu");
      button.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      button.addEventListener("click", function () { entry[1](editor.getSelection().blockIds, button); if (!entry[2]) paintSelection(); }); tools.appendChild(button);
    });
    function paintSelection() { var size = host.querySelectorAll(".blk.selected").length; if (!size) closePicker(); tools.hidden = !size; document.body.classList.toggle("core-selecting", !!size); count.textContent = size + "개 선택"; }
    editor.on("selection", paintSelection); editor.on("change", paintSelection);
    host.addEventListener("change", function (ev) { if (ev.target.matches(".block-select")) paintSelection(); });
    host.addEventListener("click", function (ev) {
      var box = ev.target.closest(".block-select"); if (!box) return;
      var row = box.closest(".blk[data-id]");
      if (ev.shiftKey && rangeAnchor) { ev.preventDefault(); commands.selectBlockRange(rangeAnchor, row.dataset.id); paintSelection(); }
      else { rangeAnchor = row.dataset.id; rangeFocus = row.dataset.id; }
    }, true);
    var drag = null, frame = 0;
    function paintBox() {
      frame = 0; if (!drag) return;
      var x = Math.min(drag.x, drag.nowX), y = Math.min(drag.y, drag.nowY), right = Math.max(drag.x, drag.nowX), bottom = Math.max(drag.y, drag.nowY);
      Object.assign(drag.box.style, { left: x + "px", top: y + "px", width: right - x + "px", height: bottom - y + "px" });
      var ids = drag.rows.filter(function (entry) { var r = entry.rect; return r.right > x && r.left < right && r.bottom > y && r.top < bottom; }).map(function (entry) { return entry.id; });
      editor.selectBlocks(drag.additive.concat(ids));
    }
    document.getElementById("doc").addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || ev.pointerType === "touch" || ev.target.closest('button,a,input,textarea,select,[contenteditable],.core-selection-tools,.gutter')) return;
      var bounds = host.getBoundingClientRect();
      if (ev.clientY < bounds.top || ev.clientY > bounds.bottom) return;
      var text = ev.target.closest(".blk"), body = text && text.querySelector(".text");
      if (body && ev.clientX >= body.getBoundingClientRect().left) return;
      var box = document.createElement("div"); box.className = "core-selection-box"; document.body.appendChild(box);
      drag = { x: ev.clientX, y: ev.clientY, nowX: ev.clientX, nowY: ev.clientY, pointer: ev.pointerId, box: box, additive: ev.shiftKey ? editor.getSelection().blockIds : [], rows: Array.from(host.querySelectorAll(".blk[data-id]")).filter(function (row) { return row.offsetHeight; }).map(function (row) { var surface = row.querySelector(".text") || row; return { id: row.dataset.id, rect: surface.getBoundingClientRect() }; }) };
      ev.preventDefault(); host.tabIndex = -1; host.focus({ preventScroll: true });
    });
    document.addEventListener("pointermove", function (ev) { if (!drag || drag.pointer !== ev.pointerId) return; drag.nowX = ev.clientX; drag.nowY = ev.clientY; if (!frame) frame = requestAnimationFrame(paintBox); });
    function finishBox(ev) { if (!drag || drag.pointer !== ev.pointerId) return; if (frame) { cancelAnimationFrame(frame); frame = 0; } if (ev.type !== "pointercancel") paintBox(); drag.box.remove(); drag = null; paintSelection(); }
    document.addEventListener("pointerup", finishBox); document.addEventListener("pointercancel", finishBox);
    var plainPaste = false;
    document.addEventListener("keydown", function (ev) { plainPaste = !!((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "v"); }, true);
    document.addEventListener("keyup", function (ev) { if (ev.key.toLowerCase() === "v") plainPaste = false; }, true);
    document.addEventListener("paste", function (ev) {
      if (!plainPaste || !ev.clipboardData || !host.contains(ev.target) || !ev.target.closest(".text")) return;
      var selection = editor.captureSelection();
      if (commands.pastePlain(ev.clipboardData.getData("text/plain"), selection)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      plainPaste = false;
    }, true);
    var blockMime = "application/x-acard-blocks+json";
    ["copy", "cut"].forEach(function (eventName) { document.addEventListener(eventName, function (ev) {
      var ids = editor.getSelection().blockIds;
      if (!ids.length || !ev.clipboardData || ev.target.closest('input,textarea,[contenteditable="true"]')) return;
      var groups = roots(ids), copied = [];
      groups.forEach(function (g) { var depth = model.depth(g.block); blocks().slice(g.index, g.end).forEach(function (b) { var copy = JSON.parse(JSON.stringify(b)); copy.indent = model.depth(b) - depth; copied.push(copy); }); });
      ev.clipboardData.setData(blockMime, JSON.stringify(copied)); ev.clipboardData.setData("text/plain", copied.map(function (b) { return b.text; }).join("\n"));
      ev.preventDefault(); if (eventName === "cut") commands.deleteBlocks(ids);
    }, true); });
    document.addEventListener("paste", function (ev) {
      if (ev.defaultPrevented || !ev.clipboardData || !host.contains(ev.target)) return;
      var encoded = ev.clipboardData.getData(blockMime); if (!encoded) return;
      var copied;
      try { copied = JSON.parse(encoded); } catch (error) { return; }
      if (!Array.isArray(copied) || copied.length > 2000 || copied.some(function (b) { return !b || typeof b.type !== "string" || typeof b.text !== "string" || !Number.isInteger(b.indent) || b.indent < 0; })) return;
      if (commands.insertBlocks(copied, editor.captureSelection())) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }, true);
    var more = document.getElementById("more-menu");
    if (more) more.classList.add("core-editor-menu");
    if (more) [
      ["페이지 개요", "openOutline"], ["단어 수", "wordStats"], ["집중 모드", "toggleFocus"], ["맨 위로", "jumpToTop"], ["맨 아래로", "jumpToBottom"]
    ].forEach(function (entry) {
      var button = document.createElement("button"); button.type = "button"; button.className = "menuitem"; button.textContent = entry[0];
      button.onclick = function () { more.hidden = true; editor.lazy("editor-navigation").then(function (nav) { nav[entry[1]](); }).catch(function (error) { editor.setSave(error.message, true); }); };
      more.appendChild(button);
    });
    if (more) {
      var spelling = document.createElement("button"); spelling.type = "button"; spelling.className = "menuitem"; spelling.textContent = "맞춤법 검사"; spelling.setAttribute("aria-pressed", String(localStorage.getItem("acard-editor-spellcheck") === "true"));
      spelling.onclick = function () { editor.lazy("editor-navigation").then(function (nav) { spelling.setAttribute("aria-pressed", String(nav.setSpellcheck(spelling.getAttribute("aria-pressed") !== "true"))); }); }; more.appendChild(spelling);
    }
    // Existing help rows stay; changed keys get new labels.
    var help = document.querySelector("#shortcuts .keys");
    if (help) {
      help.classList.add("core-shortcut-help");
      help.querySelectorAll("dt").forEach(function (key) {
        var label = key.nextElementSibling;
        if (key.textContent === "Enter") label.textContent = "커서 위치에서 문단 나누기";
        if (key.textContent === "Tab / Shift+Tab") label.textContent = "목록 들여쓰기·내어쓰기 · 표 칸 이동 · 빈 줄에서 기능 찾기";
        if (key.textContent === "Esc") label.textContent = "열려 있는 창 닫기 · 현재 블록 선택";
      });
      [["Shift + Enter", "문단 안에서 줄 바꾸기"], ["Shift + ↑ / ↓", "블록 선택 범위 늘리기·줄이기"], ["Ctrl/Cmd + Shift + ↑ / ↓", "선택한 블록 위아래로 옮기기"], ["Ctrl/Cmd + D", "선택한 블록 복제"], ["Delete / Backspace", "선택한 블록 지우기"], ["Ctrl/Cmd + Shift + V", "서식 없이 붙여넣기"], ["Ctrl/Cmd + F", "편집 중 찾기·바꾸기"], ["Ctrl/Cmd + Z / Shift + Z", "실행 취소·다시 실행"]].forEach(function (item) {
        var key = document.createElement("dt"), label = document.createElement("dd");
        key.textContent = item[0]; label.textContent = item[1]; help.append(key, label);
      });
    }
  }
  editor.provide("block-commands", editor.commands);
})();
