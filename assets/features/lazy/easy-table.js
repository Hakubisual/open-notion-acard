// Grid editor for the simple "table" block. Loaded lazily by editor.js the first time a table block renders.
// Data stays in block.meta {columns, rows, header} so markdown export (| a | b | with === divider) is unchanged.
// meta.widths (px per column) is display-only and is not exported.
(function () {
  "use strict";
  var editor = window.AcardEditor;
  if (!editor) return;
  // issue 147: default column names are data, named in the UI language they are made in.
  function colName(n) { return window.AcardLang ? AcardLang.text("열" + n) : "열" + n; }

  // Parse clipboard text from Excel / Google Sheets (TSV) or CSV into a 2D array. Returns null for single cells.
  function parseGrid(text) {
    text = String(text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (!text) return null;
    var tab = text.indexOf("\t") >= 0;
    if (!tab && !/,/.test(text)) return null;
    var rows = [], row = [], cell = "", quoted = false, sep = tab ? "\t" : ",";
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === "") quoted = true;
      else if (ch === sep) { row.push(cell.trim()); cell = ""; }
      else if (ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    row.push(cell.trim()); rows.push(row);
    var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    if (width < 2 && rows.length < 2) return null;
    return rows.map(function (r) { while (r.length < width) r.push(""); return r; });
  }

  function htmlGrid(html) {
    if (!/<table/i.test(html || "")) return null;
    var doc = new DOMParser().parseFromString(html, "text/html");
    var trs = Array.prototype.slice.call(doc.querySelectorAll("tr"));
    if (!trs.length) return null;
    var rows = trs.map(function (tr) {
      return Array.prototype.map.call(tr.querySelectorAll("td,th"), function (c) { return c.textContent.replace(/\s+/g, " ").trim(); });
    });
    var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    return rows.map(function (r) { while (r.length < width) r.push(""); return r; });
  }

  var pendingFocus = Object.create(null);

  function numeric(v) { var n = Number(String(v).replace(/[,\s%₩$원명개]/g, "")); return String(v).trim() !== "" && isFinite(n) ? n : null; }

  function mount(host, block, save) {
    var doc = host.ownerDocument;
    var meta = block.meta || (block.meta = {});
    if (!Array.isArray(meta.columns) || !meta.columns.length) meta.columns = [colName(1), colName(2)];
    if (!Array.isArray(meta.rows)) meta.rows = [];
    if (meta.header === undefined) meta.header = true;
    var menu = null;

    function commit(redraw) {
      block.meta = meta;
      save();
      if (redraw) draw();
    }
    function cols() { return meta.columns; }
    function normalize() {
      meta.rows.forEach(function (r) { while (r.length < cols().length) r.push(""); r.length = cols().length; });
    }
    function cellAt(r, c) { return host.querySelector('[data-r="' + r + '"][data-c="' + c + '"]'); }
    function focusCell(r, c) {
      var el = cellAt(r, c);
      if (!el) return;
      el.focus();
      var sel = doc.getSelection(), range = doc.createRange();
      range.selectNodeContents(el); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    }
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }

    function colMenu(ci, anchor) {
      closeMenu();
      menu = doc.createElement("div");
      menu.className = "et-menu";
      menu.setAttribute("role", "menu");
      [
        ["↑ 오름차순 정렬", function () { sortBy(ci, 1); }],
        ["↓ 내림차순 정렬", function () { sortBy(ci, -1); }],
        ["☑ 체크박스 열로", function () { checkCol(ci); }],
        ["← 왼쪽에 열 넣기", function () { addCol(ci); }],
        ["→ 오른쪽에 열 넣기", function () { addCol(ci + 1); }],
        ["열 지우기", function () { removeCol(ci); }, "danger"]
      ].forEach(function (item) {
        var b = doc.createElement("button");
        b.type = "button"; b.textContent = item[0]; b.setAttribute("role", "menuitem");
        if (item[2]) b.className = item[2];
        b.addEventListener("mousedown", function (ev) { ev.preventDefault(); closeMenu(); item[1](); });
        menu.appendChild(b);
      });
      doc.body.appendChild(menu);
      var r = anchor.getBoundingClientRect();
      menu.style.top = Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8) + "px";
      menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + "px";
      setTimeout(function () { doc.addEventListener("mousedown", function off(ev) { if (!menu || !menu.contains(ev.target)) { closeMenu(); doc.removeEventListener("mousedown", off); } }); });
    }
    function sortBy(ci, dir) {
      var allNum = meta.rows.every(function (r) { return r[ci] === "" || numeric(r[ci]) !== null; });
      meta.rows.sort(function (a, b) {
        if (allNum) return ((numeric(a[ci]) || 0) - (numeric(b[ci]) || 0)) * dir;
        return String(a[ci]).localeCompare(String(b[ci]), "ko") * dir;
      });
      commit(true);
    }
    // #34: a cell holding "[ ]" / "[x]" is a checkbox (markdown keeps the text, the reader toggles it too).
    var CHECK = /^\[( |x|X)?\]$/;
    function checkCol(ci) {
      meta.rows.forEach(function (r) { if (!CHECK.test(String(r[ci]).trim())) r[ci] = "[ ]"; });
      commit(true);
    }
    function addCol(at) {
      cols().splice(at, 0, colName(cols().length + 1));
      meta.rows.forEach(function (r) { r.splice(at, 0, ""); });
      if (Array.isArray(meta.widths)) meta.widths.splice(at, 0, 0);
      pendingFocus[block.id] = [-1, at];
      commit(true);
    }
    function removeCol(ci) {
      if (cols().length <= 1) return;
      cols().splice(ci, 1);
      meta.rows.forEach(function (r) { r.splice(ci, 1); });
      if (Array.isArray(meta.widths)) meta.widths.splice(ci, 1);
      commit(true);
    }
    function addRow(at) {
      meta.rows.splice(at, 0, cols().map(function () { return ""; }));
      pendingFocus[block.id] = [at, 0];
      commit(true);
    }
    function pasteGrid(grid, r, c) {
      // Paste into an empty/new table replaces the header too; otherwise it fills cells from the focused one.
      var empty = meta.rows.every(function (row) { return row.every(function (v) { return !v; }); });
      if (empty && r <= 0 && c === 0) {
        meta.columns = grid[0].map(function (v, i) { return v || colName(i + 1); });
        meta.rows = grid.slice(1);
      } else {
        var start = r < 0 ? 0 : r;
        grid.forEach(function (line, i) {
          while (meta.rows.length <= start + i) meta.rows.push(cols().map(function () { return ""; }));
          line.forEach(function (v, j) {
            while (cols().length <= c + j) { cols().push(colName(cols().length + 1)); meta.rows.forEach(function (x) { x.push(""); }); }
            meta.rows[start + i][c + j] = v;
          });
        });
      }
      normalize();
      commit(true);
    }

    function cell(r, c, value) {
      if (r >= 0 && CHECK.test(String(value).trim())) {
        var box = doc.createElement("button");
        var on = /x/i.test(value);
        box.type = "button"; box.className = "cell et-check" + (on ? " on" : "");
        box.dataset.r = String(r); box.dataset.c = String(c);
        box.setAttribute("role", "checkbox"); box.setAttribute("aria-checked", String(on));
        box.setAttribute("aria-label", (r + 1) + "행 " + cols()[c]);
        box.addEventListener("click", function () { meta.rows[r][c] = on ? "[ ]" : "[x]"; commit(true); });
        box.addEventListener("keydown", function (ev) {
          if (ev.key === "Backspace" || ev.key === "Delete") { ev.preventDefault(); meta.rows[r][c] = ""; pendingFocus[block.id] = [r, c]; commit(true); }
        });
        return box;
      }
      var el = doc.createElement("div");
      el.className = "cell";
      el.contentEditable = "true";
      el.dataset.r = String(r); el.dataset.c = String(c);
      el.textContent = value;
      el.setAttribute("aria-label", r < 0 ? (c + 1) + "번째 열 이름" : (r + 1) + "행 " + (c + 1) + "열");
      el.addEventListener("input", function () {
        if (r < 0) cols()[c] = el.textContent.trim() || colName(c + 1);
        else meta.rows[r][c] = el.textContent;
        commit(false);
      });
      el.addEventListener("paste", function (ev) {
        var data = ev.clipboardData;
        var grid = htmlGrid(data.getData("text/html")) || parseGrid(data.getData("text/plain"));
        ev.preventDefault(); ev.stopPropagation();
        if (grid) pasteGrid(grid, r, c);
        else doc.execCommand("insertText", false, data.getData("text/plain").replace(/\r?\n+/g, " "));
      });
      el.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        var last = cols().length - 1;
        if (ev.key === "Tab") {
          ev.preventDefault();
          if (ev.shiftKey) { if (c > 0) focusCell(r, c - 1); else if (r > -1) focusCell(r - 1, last); return; }
          if (c < last) focusCell(r, c + 1);
          else if (r + 1 < meta.rows.length) focusCell(r + 1, 0);
          else addRow(meta.rows.length);
        } else if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          if (r + 1 < meta.rows.length) focusCell(r + 1, c);
          else { pendingFocus[block.id] = [meta.rows.length, c]; meta.rows.push(cols().map(function () { return ""; })); commit(true); }
        } else if (ev.key === "ArrowUp" && r > -1) { ev.preventDefault(); focusCell(r - 1, c); }
        else if (ev.key === "ArrowDown" && r + 1 < meta.rows.length) { ev.preventDefault(); focusCell(r + 1, c); }
        else if ((ev.ctrlKey || ev.metaKey) && /^[zy]$/i.test(ev.key)) { el.blur(); doc.dispatchEvent(new KeyboardEvent("keydown", { key: ev.key, ctrlKey: true, shiftKey: ev.shiftKey, bubbles: true })); ev.preventDefault(); }
      });
      return el;
    }

    function draw() {
      normalize();
      host.replaceChildren();
      host.className = "easy-table";
      var bar = doc.createElement("div");
      bar.className = "et-bar";
      var toggle = doc.createElement("label");
      toggle.className = "et-toggle";
      var box = doc.createElement("input");
      box.type = "checkbox"; box.checked = meta.header !== false;
      box.addEventListener("change", function () { meta.header = box.checked; commit(true); });
      toggle.append(box, doc.createTextNode(" 머리글 행"));
      var chart = doc.createElement("button");
      chart.type = "button"; chart.className = "et-pill"; chart.textContent = "▥ 이 표로 차트";
      chart.addEventListener("click", function () {
        var rows = meta.rows.filter(function (r) { return r.some(function (v) { return String(v).trim(); }); });
        var series = [];
        for (var c = 1; c < cols().length; c += 1) {
          var data = rows.map(function (r) { return numeric(r[c]); });
          if (data.some(function (v) { return v !== null; })) series.push({ name: String(cols()[c]), data: data });
        }
        if (!series.length || !rows.length) { chart.textContent = "숫자 열이 있어야 해요"; return; }
        var spec = { type: "bar", labels: rows.map(function (r) { return String(r[0]); }), series: series.slice(0, 4) };
        editor.insertBlocksAfter(block.id, [{ type: "chart", text: JSON.stringify(spec), meta: {} }]);
      });
      bar.append(toggle, chart);
      host.appendChild(bar);

      var scroller = doc.createElement("div");
      scroller.className = "et-scroll";
      var table = doc.createElement("table");
      table.className = "editable-table et-grid" + (meta.header === false ? " no-head" : "");
      table.style.minWidth = (cols().length * 110 + 34) + "px";
      var colgroup = doc.createElement("colgroup");
      cols().forEach(function (_n, ci) {
        var col = doc.createElement("col");
        var w = Array.isArray(meta.widths) && meta.widths[ci];
        if (w) col.style.width = w + "px";
        colgroup.appendChild(col);
      });
      table.appendChild(colgroup);
      var thead = doc.createElement("thead"), hr = doc.createElement("tr");
      cols().forEach(function (name, ci) {
        var th = doc.createElement("th");
        th.appendChild(cell(-1, ci, name));
        var more = doc.createElement("button");
        more.type = "button"; more.className = "et-colbtn"; more.textContent = "⌄";
        more.setAttribute("aria-label", name + " 열 메뉴");
        more.addEventListener("click", function () { colMenu(ci, more); });
        th.appendChild(more);
        var grip = doc.createElement("span");
        grip.className = "et-resize";
        grip.addEventListener("pointerdown", function (ev) {
          ev.preventDefault();
          var startX = ev.clientX, startW = th.getBoundingClientRect().width, col = colgroup.children[ci];
          grip.setPointerCapture(ev.pointerId);
          function moveW(e) { col.style.width = Math.max(60, Math.round(startW + e.clientX - startX)) + "px"; }
          function up() {
            grip.removeEventListener("pointermove", moveW); grip.removeEventListener("pointerup", up);
            var widths = Array.isArray(meta.widths) ? meta.widths : (meta.widths = cols().map(function () { return 0; }));
            widths[ci] = parseInt(col.style.width, 10) || 0;
            commit(false);
          }
          grip.addEventListener("pointermove", moveW); grip.addEventListener("pointerup", up);
        });
        th.appendChild(grip);
        hr.appendChild(th);
      });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = doc.createElement("tbody");
      meta.rows.forEach(function (row, ri) {
        var tr = doc.createElement("tr");
        row.forEach(function (v, ci) { var td = doc.createElement("td"); td.appendChild(cell(ri, ci, v || "")); tr.appendChild(td); });
        var dt = doc.createElement("td"); dt.className = "et-rowtools";
        var del = doc.createElement("button");
        del.type = "button"; del.className = "rowdel"; del.textContent = "✕";
        del.setAttribute("aria-label", (ri + 1) + "번째 행 지우기");
        del.addEventListener("click", function () { meta.rows.splice(ri, 1); commit(true); });
        dt.appendChild(del); tr.appendChild(dt);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroller.appendChild(table);
      host.appendChild(scroller);
      var tools = doc.createElement("div");
      tools.className = "et-tools";
      var ar = doc.createElement("button"); ar.type = "button"; ar.className = "et-pill"; ar.textContent = "+ 행";
      ar.addEventListener("click", function () { addRow(meta.rows.length); });
      var ac = doc.createElement("button"); ac.type = "button"; ac.className = "et-pill"; ac.textContent = "+ 열";
      ac.addEventListener("click", function () { addCol(cols().length); });
      var hint = doc.createElement("span"); hint.className = "et-hint"; hint.textContent = "Tab·Enter로 이동, 엑셀·구글 시트에서 붙여넣기";
      tools.append(ar, ac, hint);
      host.appendChild(tools);
      var f = pendingFocus[block.id];
      if (f && host.isConnected) { delete pendingFocus[block.id]; focusCell(f[0], f[1]); }
    }
    draw();
  }

  editor.provide("easy-table", { mount: mount, parseGrid: parseGrid, htmlGrid: htmlGrid, numeric: numeric });
})();
