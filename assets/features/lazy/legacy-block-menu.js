(function () {
  "use strict";
  var toastTimer = null;
  function undoToast(text, undo) {
    var box = document.getElementById("undo-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "undo-toast"; box.className = "undo-toast"; box.setAttribute("role", "status");
      box.innerHTML = '<span></span><button type="button">되돌리기</button>';
      box.querySelector("button").addEventListener("click", function () { box.hidden = true; undo(); });
      document.body.appendChild(box);
    }
    box.firstChild.textContent = text + " · Ctrl+Z";
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 10000);
  }
  window.AcardEditor.provide("legacy-block-menu", { toast: undoToast, open: function (anchor, index, context) {
    var { els, state, slug, move, indent, duplicate, undoToast, setSave, openSlash, cm, moveToColumn, render, scheduleSave, lazy, pageContext, model } = context;
  function openCtx(anchor, index) {
    var rect = anchor.getBoundingClientRect();
    els.ctx.style.left = Math.min(rect.left, window.innerWidth - 280) + "px";
    els.ctx.style.top = Math.min(rect.bottom + 4, window.innerHeight - 320) + "px";
    var block = state.blocks[index];
    var actions = [
      ["위로 올리기", function () { move(index, -1); undoToast("블록을 옮겼어요"); }],
      ["아래로 내리기", function () { move(index, 1); undoToast("블록을 옮겼어요"); }],
      ["들여쓰기", function () { indent(index, 1); }],
      ["내어쓰기", function () { indent(index, -1); }],
      ["복제", function () { duplicate(index); }],
      ["블록 링크 복사", function () { navigator.clipboard.writeText(location.origin + "/edit/" + encodeURIComponent(slug) + "/#block-" + encodeURIComponent(block.id)).then(function () { setSave("블록 링크 복사됨", false); }).catch(function (error) { setSave("복사 실패: " + error.message, true); }); }],
      ["종류 바꾸기", function () { openSlash(anchor, index); }],
      cm.columnOf(state.blocks, index) ? ["왼쪽 열로", function () { moveToColumn(index, -1); }] : null,
      cm.columnOf(state.blocks, index) ? ["오른쪽 열로", function () { moveToColumn(index, 1); }] : null,
      /^heading[1-4]$/.test(block.type) ? [block.meta && block.meta.toggle ? "접기 끄기" : "접히는 제목으로", function () {
        var meta = Object.assign({}, block.meta);
        if (meta.toggle) { delete meta.toggle; delete meta.open; } else { meta.toggle = true; meta.open = true; }
        block.meta = meta; render(); scheduleSave();
      }] : null,
      block.type === "plugin" ? ["공개 화면에 이 모습 쓰기", function () { lazy("plugins").then(function (p) { return p.snapshot(block); }).then(function (s) { setSave(s ? "공개 화면 모습을 저장했어요" : "플러그인 화면을 읽지 못했어요", !s); }, function () { setSave("플러그인 화면을 읽지 못했어요", true); }); }] : null,
      /^(html|visual)$/.test(block.type) && window.AcardFolders ? ["부품으로 등록", function () { lazy("part-register").then(function (r) { r.open(block, index); }); }] : null,
      ["색", function () { lazy("block-style").then(function (s) { s.open(anchor, block); }); }],
      ["댓글", function () { if (pageContext) pageContext.comments(block.id); }],
      ["삭제", function () { state.blocks.splice(index, model.endOf(state.blocks, index) - index); render(); scheduleSave(); undoToast("블록을 지웠어요"); }]
    ];
    els.ctx.innerHTML = "<h3>블록</h3>";
    actions.filter(Boolean).forEach(function (pair) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = pair[0];
      if (pair[0] === "삭제") button.className = "danger";
      button.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      button.addEventListener("click", function (ev) { ev.stopPropagation(); els.ctx.hidden = true; pair[1](); });
      els.ctx.appendChild(button);
    });
    els.ctx.hidden = false;
  }

    openCtx(anchor, index);
  } });
})();
