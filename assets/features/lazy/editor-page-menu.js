(function () {
  "use strict";
  window.AcardEditor.provide("editor-page-menu", { open: function (anchor, page, context) {
    var els = context.els, state = context.state, slug = context.slug, api = context.api;
    var loadTree = context.loadTree, renderTree = context.renderTree, setSave = context.setSave;
  function pageMenu(anchor, page) {
    var rect = anchor.getBoundingClientRect();
    els.ctx.style.left = Math.min(rect.left - 180, window.innerWidth - 280) + "px";
    els.ctx.style.top = Math.min(rect.bottom + 4, window.innerHeight - 300) + "px";
    els.ctx.replaceChildren();
    var heading = document.createElement("h3"); heading.textContent = page.title; els.ctx.appendChild(heading);

    var actions = [
      ["이름 바꾸기", function () { renameInline(page); }],
      ["여기 아래로 옮기기", function () { pickParent(page); }],
      page.parent ? ["맨 위로 옮기기", function () {
        api("/page/" + encodeURIComponent(page.slug) + "/move", { method: "POST", body: JSON.stringify({ parent: null }) }).then(loadTree, function (error) { setSave(error.message, true); });
      }] : null,
      ["삭제", function () {
        if (!window.confirm(page.title + " 페이지를 지울까요?")) return;
        api("/page/" + encodeURIComponent(page.slug), { method: "DELETE" }).then(function () {
          if (page.slug === slug) location.href = page.parent ? "/edit/" + encodeURIComponent(page.parent) + "/" : "/home/";
          else loadTree();
        }, function (error) { setSave(error.message, true); });
      }]
    ];
    actions.filter(Boolean).forEach(function (pair) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = pair[0];
      button.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      button.addEventListener("click", function (ev) { ev.stopPropagation(); els.ctx.hidden = true; pair[1](); });
      button.onkeydown = function (ev) {
        if (ev.key === "Escape") { els.ctx.hidden = true; anchor.focus(); }
      };
      if (pair[0] === "삭제") button.className = "danger";
      els.ctx.appendChild(button);
    });
    els.ctx.hidden = false;
    els.ctx.children[1].focus();
  }

  function renameInline(page) {
    var link = els.tree.querySelector('a[href="/edit/' + encodeURIComponent(page.slug) + '/"]');
    if (!link) return;
    var input = document.createElement("input");
    input.className = "rename";
    input.value = page.title;
    link.replaceWith(input);
    input.focus();
    input.select();
    function commit() {
      var title = input.value.trim();
      if (!title || title === page.title) { loadTree(); return; }
      api("/page/" + encodeURIComponent(page.slug) + "/rename", { method: "POST", body: JSON.stringify({ title: title }) })
        .then(function () {
          if (page.slug === slug) state.title = els.title.value = title;
          return loadTree();
        }, function (error) { renderTree(); setSave(error.message, true); });
    }
    input.onblur = commit;
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { input.value = page.title; input.blur(); }
    });
  }

  function pickParent(page) {
    var select = document.createElement("select");
    select.className = "rename";
    select.add(new Option("(맨 위)", ""));
    state.pages.forEach(function (other) {
      if (other.slug !== page.slug) select.add(new Option(other.title, other.slug));
    });
    var link = els.tree.querySelector('a[href="/edit/' + encodeURIComponent(page.slug) + '/"]');
    if (!link) return;
    link.replaceWith(select);
    select.focus();
    select.addEventListener("change", function () {
      var move = function (confirmShare) {
        return api("/page/" + encodeURIComponent(page.slug) + "/move", { method: "POST", body: JSON.stringify({ parent: select.value || null, confirmShare: confirmShare }) });
      };
      move(false).catch(function (error) {
        if (!/공유됩니다/.test(error.message) || !window.confirm(error.message + "\n\n그래도 옮길까요?")) throw error;
        return move(true);
      }).then(loadTree, function (error) { renderTree(); setSave(error.message, true); });
    });
    select.onblur = loadTree;
  }

    pageMenu(anchor, page);
  } });
})();
