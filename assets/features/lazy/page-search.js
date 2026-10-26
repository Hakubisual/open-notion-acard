(function () {
  "use strict";
  var editor = window.AcardEditor;
  if (!editor) return;
  var palette = document.getElementById("palette");
  var paletteInput = document.getElementById("palette-q");
  var paletteList = document.getElementById("palette-list");
  var paletteItems = [];
  var paletteSel = 0, pSeq = 0, pWait, pGo;
  var net, recents = [];

  function renderPalette() {
    if (!paletteList) return;
    paletteList.ariaBusy = !!pWait;
    if (!paletteItems.length) { paletteList.innerHTML = pWait ? "" : '<p class="pnone">결과가 없어요.</p>'; return; }
    paletteList.innerHTML = paletteItems.map(function (item, i) {
      var href = "/edit/" + encodeURIComponent(item.slug) + "/";
      return '<a role="option" data-i="' + i + '" href="' + href + '"' + (i === paletteSel ? ' class="on"' : "") + ">" +
        "<span class=\"pt\">" + (item.title || item.slug) + "</span>" +
        (item.kind === "db" ? '<span class=\"dbmark\">표</span>' : "") +
        (item.snippet ? '<span class=\"ps\">' + item.snippet + "</span>" : "") +
        "</a>";
    }).join("");
  }
  function searchPalette(q) {
    var query = q.trim().toLowerCase(), asked = pSeq;
    pWait = query;
    if (!query) {
      paletteItems = recents.map(function (r) { return { slug: r.slug, title: r.title, snippet: "최근 본 페이지" }; }).slice(0, 8);
      paletteSel = 0;
      renderPalette();
      return;
    }
    return net("/api/search?q=" + encodeURIComponent(q)).then(function (r) { return r.ok ? r.json() : { results: [] }; }).catch(Object).then(function (data) {
      if (asked != pSeq) return;
      pWait = 0;
      paletteItems = (data.results || []).map(function (hit) {
        var text = hit.hit || "";
        return { slug: hit.slug, title: hit.title, snippet: text.length > 90 ? text.slice(0, 90) + "…" : text, kind: hit.kind };
      }).slice(0, 12);
      paletteSel = 0;
      renderPalette();
      if (pGo) followSelected();
    });
  }
  function openPalette(request, identity) {
    net = request;
    closePalette();
    try { recents = identity ? JSON.parse(localStorage.getItem("dori-notes-recent:" + identity) || "[]") : []; } catch (e) { recents = []; }
    if (!palette) return;
    palette.hidden = false;
    if (paletteInput) { paletteInput.value = ""; paletteInput.focus(); }
    pSeq++; pGo = 0;
    searchPalette("");
  }
  function followSelected() {
    var item = !(pGo = pWait) && paletteItems[paletteSel];
    if (!item) return;
    location.href = "/edit/" + encodeURIComponent(item.slug) + "/";
  }
  if (paletteInput) {
    var ptimer = null;
    paletteInput.addEventListener("input", function () {
      if (ptimer) clearTimeout(ptimer);
      pSeq++; pWait = 1; paletteItems = []; renderPalette();
      ptimer = setTimeout(function () { return searchPalette(paletteInput.value); }, 180);
    });
    paletteInput.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPalette(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); }
      else if (ev.key === "Enter") { ev.preventDefault(); followSelected(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closePalette(); }
    });
  }
  if (paletteList) paletteList.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
    if (!a) return;
    ev.preventDefault();
    location.href = a.getAttribute("href");
  });
  if (palette) palette.addEventListener("mousedown", function (ev) {
    if (ev.target === palette) closePalette();
  });
  function closePalette() {
    if (ptimer) clearTimeout(ptimer);
    pSeq++; pGo = 0; pWait = 0;
    palette.hidden = true;
  }
  editor.provide("page-search", { open: openPalette, close: closePalette });
})();

