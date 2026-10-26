// #34: to-do boxes and "[ ]" table cells toggle and save from the reader through the editor's block patch
// (same share "edit" gate and live feed). block-html.js loads this chunk only on pages that have such a box.
// A read-only page answers 401/403 and the box goes back.
(function () {
  if (window.AcardChecks) return;
  window.AcardChecks = true;
  function toggleCheck(box) {
    if (box.dataset.busy) return;
    var id = box.getAttribute("data-check"), r = box.getAttribute("data-r"), c = box.getAttribute("data-c");
    var on = box.getAttribute("aria-checked") !== "true";
    var paint = function (v) {
      box.setAttribute("aria-checked", String(v));
      box.classList.toggle("on", v);
      if (box.classList.contains("box")) { box.textContent = v ? "\u2713" : ""; box.parentNode.classList.toggle("on", v); }
    };
    var page = "/api/page/" + encodeURIComponent(window.AcardReader.slug);
    box.dataset.busy = "1";
    paint(on);
    // Two quick clicks on different boxes race on base_updated: a 409 re-reads the page and tries once more.
    save(page, id, r, c, on).then(function (res) { return res.status === 409 ? save(page, id, r, c, on) : res; })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        // The 완료 column now exists at index 0, so this table's other boxes point at it.
        if (c === "new") document.querySelectorAll('[data-check="' + CSS.escape(id) + '"][data-c="new"]').forEach(function (b) { b.setAttribute("data-c", "0"); });
      }).catch(function () { paint(!on); }).then(function () { delete box.dataset.busy; });
  }
  function save(page, id, r, c, on) {
    return fetch(page, { cache: "no-store" }).then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); }).then(function (data) {
      var block = (data.blocks || []).find(function (b) { return b.id === id; });
      if (!block) throw new Error("block");
      if (r === null) block.checked = on;
      else {
        if (c === "new") c = addDoneColumn(block);
        // "table" blocks keep rows as arrays, markdown "database" blocks as objects keyed by column name.
        var rows = block.meta && block.meta.rows, key = rows && rows[r] && !Array.isArray(rows[r]) ? block.meta.columns[c] : c;
        if (!rows || !rows[r] || !/^\[( |x|X)?\]$/.test(String(rows[r][key]).trim())) throw new Error("cell");
        rows[r][key] = on ? "[x]" : "[ ]";
      }
      block.ord = data.blocks.indexOf(block);
      return fetch(page + "/blocks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_updated: data.page.updated, upserts: [block], deletes: [] }) });
    });
  }
  // #73: the first tick on a plain table puts a 완료 column of "[ ]" cells in front (idempotent: a 409 retry or a second
  // box clicked meanwhile finds it already there). Returns the column index, 0.
  function addDoneColumn(block) {
    var meta = block.meta || {}, cols = meta.columns || [], rows = meta.rows || [];
    var isBox = function (v) { return /^\[( |x|X)?\]$/.test(String(v == null ? "" : v).trim()); };
    var first = cols[0];
    if (rows.length && rows.every(function (r) { return isBox(Array.isArray(r) ? r[0] : r[first]); })) return "0";
    // issue 147: the new column is data, named in the UI language it is made in.
    var done = window.AcardLang ? window.AcardLang.text("완료") : "완료";
    var name = done, n = 2;
    while (cols.indexOf(name) >= 0) name = done + " " + n++;
    cols.unshift(name);
    rows.forEach(function (r) { if (Array.isArray(r)) r.unshift("[ ]"); else r[name] = "[ ]"; });
    if (Array.isArray(meta.widths)) meta.widths.unshift(0);
    return "0";
  }
  // The whole checkbox cell is the hit area (a 17 px box is easy to miss, Notion toggles on the cell too).
  document.addEventListener("click", function (ev) {
    var cell = ev.target.closest && ev.target.closest(".cellcheck-td");
    var box = cell ? cell.querySelector("[data-check]") : ev.target.closest && ev.target.closest("[data-check]");
    if (box && document.body.classList.contains("reader")) toggleCheck(box);
  });
  // #36: 반영 / 무시 on an agent's update suggestion under a person-edited paragraph, then a live re-render.
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest && ev.target.closest(".suggest [data-act]");
    if (!btn || btn.disabled) return;
    var card = btn.closest(".suggest"), id = card.getAttribute("data-suggest");
    card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    fetch("/api/page/" + encodeURIComponent(window.AcardReader.slug) + "/suggestion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ block: id, action: btn.getAttribute("data-act") }) })
      .then(function (res) { if (!res.ok) throw new Error(res.status); location.reload(); })
      .catch(function () { card.querySelectorAll("button").forEach(function (b) { b.disabled = false; }); card.classList.add("failed"); });
  });
  document.addEventListener("keydown", function (ev) {
    var box = ev.target.closest && ev.target.closest("[data-check]");
    if (box && (ev.key === " " || ev.key === "Enter")) { ev.preventDefault(); toggleCheck(box); }
  });
})();
