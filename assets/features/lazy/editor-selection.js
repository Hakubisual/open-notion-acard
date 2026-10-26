(function () {
  "use strict";
  var editor = window.AcardEditor;
  function capture(ids) {
    var selection = window.getSelection(), title = document.getElementById("title"), model = window.EditorModel;
    function endpoint(node, offset) {
      var element = node && (node.nodeType === 1 ? node : node.parentElement);
      var text = element && element.closest(".text[contenteditable]");
      var row = text && text.closest(".blk[data-id]");
      if (!row) return null;
      var range = document.createRange(); range.selectNodeContents(text); range.setEnd(node, offset);
      var fragment = document.createElement("div"); fragment.appendChild(range.cloneContents());
      return { kind: "text", blockId: row.dataset.id, offset: model.readRich(fragment).map(function (run) { return run.text; }).join("").length };
    }
    if (document.activeElement === title) {
      var backward = title.selectionDirection === "backward";
      return { anchor: { kind: "title", offset: backward ? title.selectionEnd : title.selectionStart }, focus: { kind: "title", offset: backward ? title.selectionStart : title.selectionEnd }, selectedBlockIds: [] };
    }
    return { anchor: selection && endpoint(selection.anchorNode, selection.anchorOffset), focus: selection && endpoint(selection.focusNode, selection.focusOffset), selectedBlockIds: ids };
  }
  function restore(bookmark) {
    var title = document.getElementById("title"), host = document.getElementById("blocks");
    var selected = new Set(bookmark.selectedBlockIds);
    host.querySelectorAll(".blk[data-id]").forEach(function (row) { var on = selected.has(row.dataset.id); row.classList.toggle("selected", on); var box = row.querySelector(".block-select"); if (box) box.checked = on; });
    if (bookmark.anchor && bookmark.anchor.kind === "title") {
      title.focus(); title.setSelectionRange(Math.min(bookmark.anchor.offset, bookmark.focus.offset), Math.max(bookmark.anchor.offset, bookmark.focus.offset), bookmark.anchor.offset > bookmark.focus.offset ? "backward" : "forward"); return;
    }
    function point(value) {
      if (!value) return null;
      var row = document.getElementById("block-" + value.blockId);
      var text = row && row.querySelector(".text[contenteditable]");
      if (!text) return null;
      var left = value.offset, result = null;
      function visit(node) {
        if (result) return;
        if (node.nodeType === 3) { if (left <= node.nodeValue.length) result = [node, left]; else left -= node.nodeValue.length; }
        else if (node.nodeName === "BR") { var index = Array.prototype.indexOf.call(node.parentNode.childNodes, node); if (!left) result = [node.parentNode, index]; else left--; }
        else Array.from(node.childNodes).forEach(visit);
      }
      visit(text);
      return { text: text, node: result ? result[0] : text, offset: result ? result[1] : text.childNodes.length };
    }
    var anchor = point(bookmark.anchor), focus = point(bookmark.focus);
    if ((!anchor || !focus) && (bookmark.anchor || bookmark.focus)) {
      var survivor = host.querySelector(".text[contenteditable]");
      if (!survivor) { title.focus(); return; }
      anchor = focus = { text: survivor, node: survivor, offset: 0 };
    }
    if (anchor && focus) { anchor.text.focus(); window.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); }
  }
  editor.provide("editor-selection", { capture: capture, restore: restore });
})();
