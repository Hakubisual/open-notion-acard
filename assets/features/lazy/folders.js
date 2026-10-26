(function () {
  if (window.AcardFolders) return;
  var editor = /^\/edit\//.test(location.pathname);
  var current = decodeURIComponent((location.pathname.match(/^\/(?:edit\/)?([^/]+)\/?$/) || [])[1] || "index");
  if (current === "home") current = "index";
  if (current === "home") current = "index";
  var identity = (document.querySelector('meta[name="acard-id"]') || {}).content;
  var base = editor ? document.getElementById("tree") : document.querySelector(".side-ws");
  if (!base) return;
  var host = base;
  if (editor) { host = document.createElement("div"); host.id = "fd-tree"; base.after(host); }
  var S = { pages: [], tags: [], prefs: { open: [], collapsed: [], closed: [] }, journal: "agent-journal", filter: null, byParent: {}, bySlug: {}, view: "project" };
  // #16 draft A: a folder is a page shown as a folder (page_view), drawn with a folder icon; other pages a page icon.
  var SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" ';
  var ICO = { folder: SVG + 'fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.3 1.6.7L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',
    page: SVG + 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>' };
  var COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
  var COLOR_KO = { gray: "회색", brown: "갈색", orange: "주황", yellow: "노랑", green: "초록", blue: "파랑", purple: "보라", pink: "분홍", red: "빨강" };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function href(slug) { return editor ? "/edit/" + encodeURIComponent(slug) + "/" : slug === "index" ? "/home/" : "/" + encodeURIComponent(slug) + "/"; }
  function api(method, path, body) {
    // keepalive: a drop is drawn at once, so a click on a link right after it must not cancel the save.
    // x-acard-client marks the live notice of this write as this tab's own (live.js), so the reader does not re-read a page
    // this tab just trashed - that failed re-read reloaded the trashed address over the move to its parent (issue 162).
    var headers = body ? { "content-type": "application/json" } : {};
    if (method !== "GET" && window.AcardLive && window.AcardLive.client) headers["x-acard-client"] = window.AcardLive.client;
    return fetch(path, { method: method, keepalive: method !== "GET", headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || "실패했어요."); e.data = d; e.status = r.status; throw e; } return d; }); });
  }
  function withShare(method, path, body) {
    return api(method, path, body).catch(function (e) {
      if (e.status === 409 && e.data && e.data.needsConfirm && window.confirm(e.message + "\n\n그래도 옮길까요?")) return api(method, path, Object.assign({}, body, { confirmShare: true }));
      throw e;
    });
  }

  var toastEl;
  function toast(text, batch, isError) {
    if (toastEl) toastEl.remove();
    toastEl = el("div", "fd-toast" + (isError ? " err" : ""));
    toastEl.setAttribute("role", "status");
    toastEl.appendChild(el("span", "fd-ok", isError ? "!" : "✓"));
    toastEl.appendChild(el("span", "fd-tt", text));
    if (batch) {
      var u = el("button", "fd-undo", "되돌리기"); u.type = "button";
      u.onclick = function () { api("POST", "/api/folders/undo", { batch: batch }).then(function () { toast("되돌렸어요."); reload(); }, oops); };
      toastEl.appendChild(u);
    }
    var x = el("button", "fd-x", "×"); x.type = "button"; x.setAttribute("aria-label", "닫기"); x.onclick = function () { toastEl.remove(); };
    toastEl.appendChild(x);
    document.body.appendChild(toastEl);
    var mine = toastEl;
    setTimeout(function () { if (mine === toastEl) mine.remove(); }, 8000);
  }

  function index() {
    S.byParent = {}; S.bySlug = {};
    S.pages.forEach(function (p) { S.bySlug[p.slug] = p; });
    S.pages.forEach(function (p) { var k = p.parent && S.bySlug[p.parent] ? p.parent : ""; (S.byParent[k] = S.byParent[k] || []).push(p); });
  }
  function kids(slug) { return S.byParent[slug || ""] || []; }
  function count(slug) { var n = 0; kids(slug).forEach(function (k) { n += 1 + count(k.slug); }); return n; }
  function isUnder(slug, maybeAncestor) { for (var p = S.bySlug[slug]; p; p = S.bySlug[p.parent]) { if (p.slug === maybeAncestor) return true; if (!p.parent) break; } return false; }
  function isOpen(slug) { return S.prefs.closed.indexOf(slug) < 0 && (S.prefs.open.indexOf(slug) >= 0 || isUnder(current, slug) && current !== slug); }
  // #14: one save per burst of clicks (concurrent saves raced); v lets the server drop a late older save.
  // #45: the last tree and fold state also live in this browser (per sign-in epoch): the menu draws at once, survives a
  // failed tree read, and a fold whose save failed is sent again; the newer fold wins.
  function local(key, value) {
    if (!identity) return;
    key += ":" + identity;
    try {
      var e = localStorage.getItem("acard-cache-epoch:" + identity) || "";
      if (value === undefined) { var c = JSON.parse(localStorage.getItem(key)); return c && c.e === e ? c.d : null; }
      localStorage.setItem(key, JSON.stringify({ e: e, d: value }));
    } catch (x) {}
  }
  var due, put = function () {
    if (due) fetch("/api/folders/prefs", { method: "PUT", keepalive: true, body: JSON.stringify(S.prefs) }).then(function (r) { var p = local("acard-tree-prefs"); if (r.ok && p && p.v === S.prefs.v) { p.saved = 1; local("acard-tree-prefs", p); } }, function () {});
    due = 0;
  };
  function savePrefs() { S.prefs.v = Date.now(); local("acard-tree-prefs", S.prefs); clearTimeout(due); due = setTimeout(put, 200); }
  function toggleOpen(slug, open) {
    var P = S.prefs, no = function (x) { return x !== slug; };
    P.open = P.open.filter(no); P.closed = P.closed.filter(no);
    (open ? P.open : P.closed).push(slug);
    savePrefs();
  }
  function sectionCollapsed(key) { return S.prefs.collapsed.indexOf(key) >= 0; }

  function row(p, depth, flat) {
    var li = el("li", "fd-li");
    var r = el("div", "fd-row" + (p.slug === current ? " on" : ""));
    r.dataset.slug = p.slug;
    r.style.paddingLeft = (flat ? 6 : 6 + depth * 14) + "px";
    r.style.setProperty("--fd-indent", (flat ? 6 : 6 + depth * 14) + "px");
    var children = flat ? [] : kids(p.slug);
    var open = children.length && isOpen(p.slug);
    var tw = el("button", "fd-tw" + (children.length ? "" : " none")); tw.type = "button";
    tw.setAttribute("aria-label", open ? "접기" : "펼치기"); tw.tabIndex = -1;
    tw.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>';
    if (open) r.classList.add("open");
    tw.onclick = function (ev) { ev.preventDefault(); toggleOpen(p.slug, !r.classList.contains("open")); render(); };
    var a = el("a", "fd-link"); a.href = href(p.slug); a.draggable = false;
    var img = /^\/media\/[0-9a-f]{16}$/.test(p.icon || ""), folder = p.view === "folder" || p.view !== "article" && kids(p.slug).length > 0;
    var ic = el("span", "fd-ic" + (folder ? " fd-folder" : ""), img ? null : p.icon || null);
    if (!img && !p.icon) ic.innerHTML = folder ? ICO.folder : ICO.page;
    else if (img) { var im = el("img"); im.src = p.icon + "?w=400"; im.alt = ""; im.width = im.height = 16; im.loading = "lazy"; im.style.cssText = "border-radius:3px;object-fit:cover;vertical-align:-3px"; ic.appendChild(im); }
    a.appendChild(ic);
    a.appendChild(el("span", "fd-t", p.title || "제목 없음"));
    r.appendChild(tw); r.appendChild(a);
    if (children.length) r.appendChild(el("span", "fd-n", String(count(p.slug))));
    var add = el("button", "fd-add", "+"); add.type = "button"; add.title = "새 하위 페이지"; add.setAttribute("aria-label", "'" + p.title + "' 아래 새 하위 페이지");
    add.onclick = function (ev) { ev.preventDefault(); newPage(p.slug); };
    var more = el("button", "fd-more", "⋯"); more.type = "button"; more.setAttribute("aria-label", "페이지 메뉴");
    more.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); pageMenu(more, p); };
    r.appendChild(add); r.appendChild(more);
    li.appendChild(r);
    if (open) { var ul = el("ul", "fd-ul"); children.forEach(function (k) { ul.appendChild(row(k, depth + 1)); }); li.appendChild(ul); }
    return li;
  }
  function section(key, title, body, opts) {
    var sec = el("section", "fd-sec");
    sec.dataset.sec = key;
    var head = el("div", "fd-head");
    var collapsed = sectionCollapsed(key);
    var btn = el("button", "fd-sh", title); btn.type = "button"; btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.onclick = function () { var i = S.prefs.collapsed.indexOf(key); if (i >= 0) S.prefs.collapsed.splice(i, 1); else S.prefs.collapsed.push(key); savePrefs(); render(); };
    head.appendChild(btn);
    (opts && opts.tools || []).forEach(function (t) { head.appendChild(t); });
    sec.appendChild(head);
    if (!collapsed) sec.appendChild(body);
    return sec;
  }
  function iconBtn(label, text, fn) { var b = el("button", "fd-ib", text); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.onclick = fn; return b; }
  // 사이드바 보기 (#16): project (tree) / tags / date, saved on the server per workspace (설정 > 사이드바 보기, or #).
  function setView(v) {
    var was = S.view;
    S.view = v; render();
    api("PUT", "/api/folders/view", { view: v }).catch(function () { S.view = was; render(); toast("사이드바 보기를 저장하지 못했어요. 이전 보기로 돌렸어요.", null, true); });
  }
  function mine(p) { return p.slug !== S.journal && !isUnder(p.slug, S.journal) && !p.shared; }
  function groups(pick, pages, rank) {
    var box = el("div"), names = {}, order = [];
    (pages || S.pages).filter(mine).forEach(function (p) { pick(p).forEach(function (t) { if (!names[t]) { names[t] = []; order.push(t); } names[t].push(p); }); });
    if (rank) order.sort(function (a, b) { return rank(a) - rank(b); });
    order.forEach(function (t) {
      var d = el("details"), sm = el("summary", "fd-t", t + " · " + names[t].length);
      d.open = true; d.appendChild(sm); d.appendChild(list(names[t], true)); box.appendChild(d);
    });
    if (!order.length) box.appendChild(list([], true));
    return box;
  }
  function tagGroups() {
    var names = S.tags.map(function (t) { return t.name; });
    // Tags in the tag list's order, 태그 없음 last.
    return groups(function (p) { return p.tags.length ? p.tags : ["태그 없음"]; }, null, function (t) { var i = names.indexOf(t); return i < 0 ? 1e9 : i; });
  }
  function dateGroups() {
    var d = new Date(), day = d.setHours(0, 0, 0, 0), week = day - 6 * 864e5, month = day - 29 * 864e5;
    return groups(function (p) { var t = p.updated; return [t >= day ? "오늘" : t >= week ? "이번 주" : t >= month ? "이번 달" : "그 전"]; },
      S.pages.slice().sort(function (a, b) { return b.updated - a.updated; }));
  }
  function list(items, flat, ws) {
    var ul = el("ul", "fd-ul fd-root"); items.forEach(function (p) { ul.appendChild(row(p, 0, flat)); });
    if (!items.length) ul.appendChild(el("li", "fd-empty", "없어요."));
    if (!items.length && ws) {
      // An empty workspace (draft A): one line and a 새 폴더 button.
      ul.lastChild.textContent = "폴더를 만들어 페이지를 묶어 보세요";
      var b = el("button", "fd-btn primary fd-newf"); b.type = "button"; b.innerHTML = ICO.folder; b.append("새 폴더"); b.onclick = function () { newFolder(null, b); };
      ul.lastChild.appendChild(b);
    }
    return ul;
  }

  function render() {
    index();
    var wrap = el("div", "fd-wrap");
    // 모든 페이지 / 정리 제안 moved to the sidebar ⋯ menu (window.AcardFolders.allPages / suggest).
    if (S.filter) {
      var hit = S.pages.filter(function (p) { return p.tags.indexOf(S.filter) >= 0; });
      var clear = iconBtn("필터 끄기", "×", function () { S.filter = null; render(); });
      wrap.appendChild(section("filter", "태그: " + S.filter + " (" + hit.length + ")", list(hit, true), { tools: [clear] }));
    } else {
      var favs = S.pages.filter(function (p) { return p.favorite; });
      if (favs.length) wrap.appendChild(section("fav", "즐겨찾기", list(favs, true)));
      var roots = kids("").filter(function (p) { return p.slug !== S.journal && !p.shared; });
      var anyOpen = roots.some(function (p) { return kids(p.slug).length && isOpen(p.slug); });
      // 모두 펼치기: 2 levels; deeper ones stay folded with a count.
      var depth = function (p) { var d = 0; for (var q = S.bySlug[p.parent]; q && d < 9; q = S.bySlug[q.parent]) d++; return d; };
      var parents = S.pages.filter(function (p) { return kids(p.slug).length && depth(p) < 2; }).map(function (p) { return p.slug; });
      var tree = S.view === "project";
      var add = iconBtn("새 페이지 또는 폴더 만들기", "+", function () {
        menu(add, [{ label: "새 페이지", icon: ICO.page, fn: function () { newPage(null); } }, { label: "새 폴더", icon: ICO.folder, fn: function () { newFolder(null, add); } }]);
      });
      add.setAttribute("aria-haspopup", "menu");
      wrap.appendChild(section("ws", "작업 공간", S.view === "tags" ? tagGroups() : S.view === "date" ? dateGroups() : list(roots, false, true), { tools: [
        iconBtn(tree ? "태그별 보기" : "프로젝트별 보기", tree ? "#" : "≡", function () { setView(tree ? "tags" : "project"); }),
        tree ? iconBtn(anyOpen ? "모두 접기" : "모두 펼치기", anyOpen ? "⇤" : "⇥", function () { S.prefs.open = anyOpen ? [] : parents.slice(0, 2000); S.prefs.closed = anyOpen ? parents.slice(0, 2000) : []; savePrefs(); render(); }) : null,
        add,
      ].filter(Boolean) }));
      // The agent journal group is hidden from the tree (owner); journal pages stay reachable from search and 설정 > 에이전트 연결.
      var shared = S.pages.filter(function (p) { return p.shared; });
      wrap.appendChild(section("shared", "공유받은 페이지", list(shared, true)));
    }
    var chips = el("div", "fd-chips");
    S.tags.forEach(function (t) {
      var c = el("button", "fd-chip c-" + t.color + (S.filter === t.name ? " on" : "")); c.type = "button"; c.title = t.name;
      c.appendChild(el("span", null, t.name)); c.appendChild(el("small", null, String(t.count)));
      c.onclick = function () { S.filter = S.filter === t.name ? null : t.name; render(); };
      c.oncontextmenu = function (ev) { ev.preventDefault(); tagMenu(c, t); };
      chips.appendChild(c);
    });
    if (!S.tags.length) chips.appendChild(el("p", "fd-empty", "태그가 없어요. 페이지 제목 아래 '+ 태그'로 달아요."));
    wrap.appendChild(section("tags", "태그", chips, { tools: [iconBtn("태그 관리", "⚙", manageTags)] }));
    var focused = document.activeElement && document.activeElement.closest && document.activeElement.closest(".fd-row");
    var keep = focused ? focused.dataset.slug : null;
    host.replaceChildren(wrap);
    if (keep) { var again = host.querySelector('.fd-row[data-slug="' + CSS.escape(keep) + '"] .fd-link'); if (again) again.focus(); }
  }

  // read: a tree read already started by the caller (live.js passes one that skips the service worker's stale copy).
  function reload(read) {
    return (read || api("GET", "/api/folders/tree")).then(function (d) {
      if (!d || !Array.isArray(d.pages)) throw Error("tree");
      local("acard-tree-cache", { pages: d.pages, tags: d.tags, journalRoot: d.journalRoot, view: d.view });
      apply(d, d.prefs);
      render(); headTags();
    });
  }
  function apply(d, theirs) {
    S.pages = d.pages || []; S.tags = d.tags || []; S.journal = d.journalRoot || S.journal; S.view = d.view || "project";
    var mine = local("acard-tree-prefs"), pick = mine && mine.v > ((theirs || {}).v || 0) ? mine : theirs;
    S.prefs = Object.assign({ open: [], collapsed: [], closed: [] }, pick);
    delete S.prefs.saved;
    if (pick === mine && !mine.saved) { due = 1; put(); }
  }

  document.addEventListener("acard:tree-fresh", function () { reload().catch(function () {}); });
  document.addEventListener("acard:navigated", function (e) {
    current = e.detail.slug;
    // Keep the tree and its focus/expansion DOM mounted across reader navigation.
    host.querySelectorAll(".fd-row[data-slug]").forEach(function (row) { row.classList.toggle("on", row.dataset.slug === current); });
    headTags();
    ahead = {}; aheadN = 0;
  });

  // #30 prefetch
  var ahead = {}, made = {};
  function newUrl(p) { p = p || ""; return made[p] || (made[p] = "/edit/page-" + Math.random().toString(36).slice(2, 8) + "/?new&create" + (p ? "&parent=" + encodeURIComponent(p) : "")); }
  // #45/#57: a mouse sweeping over a long tree started a full page load per row at once; at most 8 per page view now.
  var aheadN = 0, hover;
  function pre(u) {
    if (!u || ahead[u] || u == location.pathname || aheadN >= 8) return;
    ahead[u] = 1; aheadN++;
    if (!editor && window.AcardReader && window.AcardReader.prefetch && !/^\/edit\//.test(u)) { window.AcardReader.prefetch(u); return; }
    document.head.append(Object.assign(document.createElement("script"), { type: "speculationrules", textContent: JSON.stringify({ prefetch: [{ source: "list", urls: [u], eagerness: "immediate" }] }) }));
  }
  function warm(ev) {
    var t = ev.target.closest ? ev.target : document.body, n = t.closest(".fd-add,[title='새 페이지'],[title='새 페이지 또는 폴더 만들기']"), a = t.closest("#sidebar a[href^='/']");
    var u = n ? newUrl(n.matches(".fd-add") && n.parentNode.dataset.slug) : a && a.pathname;
    clearTimeout(hover);
    if (ev.type === "pointerover") hover = setTimeout(pre, 100, u); else pre(u);
  }
  // Phones have no hover: a touch starts the fetch, and an opened drawer fetches its first 3 links on screen.
  "pointerover pointerdown focusin".split(" ").forEach(function (e) { document.addEventListener(e, warm, { passive: true }); });
  var side = document.getElementById("sidebar");
  side && new MutationObserver(function () {
    side.classList.contains("open") && setTimeout(function () { [...side.querySelectorAll(".fd-link")].filter(function (a) { return a.getBoundingClientRect().top < innerHeight; }).slice(0, 3).forEach(function (a) { pre(a.pathname); }); }, 50);
  }).observe(side, { attributes: true });

  // Service-worker sync: a small dot while cached pages/tree refresh, silent swap when they changed.
  if ("serviceWorker" in navigator) (function () {
  var dot = null, busy = 0;
  function sync(on) {
    busy = Math.max(0, busy + (on ? 1 : -1));
    if (!dot) {
      dot = document.createElement("span");
      dot.id = "acard-sync";
      dot.setAttribute("role", "status");
      dot.title = "동기화 중";
      dot.style.cssText = "position:fixed;right:12px;bottom:12px;width:8px;height:8px;border-radius:50%;background:var(--accent,#7c5cff);opacity:0;transition:opacity .2s;pointer-events:none;z-index:50";
      document.body.appendChild(dot);
    }
    dot.style.opacity = busy ? "0.8" : "0";
  }
  navigator.serviceWorker.addEventListener("message", function (event) {
    var m = event.data || {};
    if (m.type === "acard-sync") sync(m.on);
    else if (m.type === "acard-fresh" && m.kind === "tree") document.dispatchEvent(new CustomEvent("acard:tree-fresh"));
    else if (m.type === "acard-auth") location.reload();
  });
  })();

  function move(slug, body, label) {
    return withShare("POST", "/api/page/" + encodeURIComponent(slug) + "/move", body)
      .then(function (d) { toast(label || "1개 페이지 옮김", d.batch); return reload(); }, function (e) { toast(e.message, null, true); return reload(); });
  }
  function newPage(parent) { location.href = newUrl(parent); }
  // 새 폴더: name it in a small field at the button, then a page set to folder view opens (its + 새 페이지 adds pages).
  function newFolder(parent, anchor) {
    if (anchor) return ask(anchor, "폴더 이름", "새 폴더", function (name) { makeFolder(parent, name); });
    makeFolder(parent, "새 폴더");
  }
  function makeFolder(parent, title) {
    api("POST", "/api/pages", { title: title, parent: parent || null }).then(function (d) {
      return api("PUT", "/api/page/" + encodeURIComponent(d.slug) + "/view", { mode: "folder" }).then(function () { location.href = href(d.slug); });
    }, oops);
  }

  function oops(e) { toast(e.message, null, true); }
  var menuEl;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function menu(anchor, items) {
    closeMenu();
    menuEl = el("div", "fd-menu"); menuEl.setAttribute("role", "menu");
    items.forEach(function (it) { var b = el("button", it.danger ? "danger" : "", it.label); if (it.icon) b.insertAdjacentHTML("afterbegin", it.icon); b.type = "button"; b.setAttribute("role", "menuitem"); b.onclick = function () { closeMenu(); it.fn(); }; menuEl.appendChild(b); });
    document.body.appendChild(menuEl);
    var r = anchor.getBoundingClientRect();
    menuEl.style.left = Math.max(8, Math.min(r.left, innerWidth - 240)) + "px";
    menuEl.style.top = Math.min(r.bottom + 4, innerHeight - menuEl.offsetHeight - 8) + "px";
    var first = menuEl.querySelector("button"); if (first) first.focus();
  }
  function ask(a, label, v, done) {
    menu(a, []);
    var f = el("form", "fd-bar"), i = el("input", "fd-in"); i.value = v; i.placeholder = i.ariaLabel = label;
    f.onsubmit = function (e) { e.preventDefault(); v = i.value.trim(); closeMenu(); if (v) done(v); };
    f.append(i); menuEl.append(f); i.focus(); i.select();
  }
  document.addEventListener("mousedown", function (ev) { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closeMenu(); closeSheet(); } });

  function siblingsOf(p) { return kids(p.parent && S.bySlug[p.parent] ? p.parent : ""); }
  function keyMove(p, dir) {
    var sib = siblingsOf(p), i = sib.indexOf(p);
    if (dir === "up" && i > 0) return move(p.slug, { parent: p.parent || null, before: sib[i - 1].slug });
    if (dir === "down" && i < sib.length - 1) return move(p.slug, { parent: p.parent || null, after: sib[i + 1].slug });
    if (dir === "in" && i > 0) { toggleOpen(sib[i - 1].slug, true); return move(p.slug, { parent: sib[i - 1].slug }); }
    if (dir === "out" && p.parent && S.bySlug[p.parent]) return move(p.slug, { parent: S.bySlug[p.parent].parent || null, after: p.parent });
  }
  function pageMenu(anchor, p) {
    menu(anchor, [
      { label: "위로", fn: function () { keyMove(p, "up"); } },
      { label: "아래로", fn: function () { keyMove(p, "down"); } },
      { label: "위 페이지 안으로", fn: function () { keyMove(p, "in"); } },
      { label: "한 단계 밖으로", fn: function () { keyMove(p, "out"); } },
      { label: "옮기기…", fn: function () { moveSheet([p.slug]); } },
      { label: "새 하위 페이지", fn: function () { newPage(p.slug); } },
      { label: "새 하위 폴더", fn: function () { newFolder(p.slug); } },
      { label: "삭제", danger: true, fn: function () {
        if (p.slug === S.journal && !window.confirm("에이전트 작업 기록 전체를 휴지통으로 옮길까요? 새 세션이 오면 그룹이 다시 만들어져요.")) return;
        api("POST", "/api/folders/bulk", { action: "trash", slugs: [p.slug] }).then(function (d) { toast("휴지통으로 옮겼어요.", d.batch); if (p.slug === current) location.href = p.parent && S.bySlug[p.parent] ? href(p.parent) : "/home/"; else reload(); }, oops);
      } },
    ]);
  }

  var sheet;
  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }
  function overlay(title) {
    closeSheet();
    sheet = el("div", "fd-ov"); sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", title);
    var box = el("div", "fd-sheet");
    var head = el("div", "fd-sheet-h"); head.appendChild(el("h2", null, title));
    var x = el("button", "fd-x", "×"); x.type = "button"; x.setAttribute("aria-label", "닫기"); x.onclick = closeSheet; head.appendChild(x);
    box.appendChild(head);
    sheet.appendChild(box);
    var opened = Date.now();
    sheet.addEventListener("mousedown", function (ev) { if (ev.target === sheet && Date.now() - opened > 600) closeSheet(); });
    document.body.appendChild(sheet);
    return box;
  }
  function moveSheet(slugs, done) {
    var box = overlay(slugs.length > 1 ? slugs.length + "개 페이지 옮기기" : "옮기기");
    var input = el("input", "fd-in"); input.placeholder = "옮길 곳 찾기"; input.setAttribute("aria-label", "옮길 곳 찾기");
    box.appendChild(input);
    var ul = el("div", "fd-dest");
    box.appendChild(ul);
    if (slugs.length === 1) {
      var p = S.bySlug[slugs[0]], bar = el("div", "fd-bar");
      [["위로", "up"], ["아래로", "down"], ["안으로", "in"], ["밖으로", "out"]].forEach(function (b) { var k = el("button", "fd-btn", b[0]); k.type = "button"; k.onclick = function () { closeSheet(); keyMove(p, b[1]); }; bar.appendChild(k); });
      box.insertBefore(bar, input);
    }
    function blocked(target) { return slugs.some(function (s) { return target === s || isUnder(target, s); }); }
    function paint() {
      ul.replaceChildren();
      var q = input.value.trim().toLowerCase();
      var opts = [{ slug: null, title: "맨 위 (작업 공간)" }].concat(S.pages.filter(function (x) { return !blocked(x.slug) && (!q || (x.title || "").toLowerCase().indexOf(q) >= 0); }).slice(0, 80));
      opts.forEach(function (o) {
        var b = el("button", "fd-opt", o.title); b.type = "button";
        if (o.slug && S.bySlug[o.slug] && S.bySlug[o.slug].parent && S.bySlug[S.bySlug[o.slug].parent]) b.appendChild(el("small", null, " · " + S.bySlug[S.bySlug[o.slug].parent].title));
        b.onclick = function () {
          closeSheet();
          var req = slugs.length > 1 ? withShare("POST", "/api/folders/bulk", { action: "move", slugs: slugs, parent: o.slug }) : withShare("POST", "/api/page/" + encodeURIComponent(slugs[0]) + "/move", { parent: o.slug });
          req.then(function (d) { if (o.slug) toggleOpen(o.slug, true); toast((d.moved || 1) + "개 페이지 옮김", d.batch); reload().then(done); }, oops);
        };
        ul.appendChild(b);
      });
    }
    input.oninput = paint; paint(); input.focus();
  }

  // Drag in the sidebar (#41): mouse drags after 6 px; a finger holds a row for 400 ms and then drags (a hold that does
  // not move opens the move sheet). Drop on a row's middle = inside it, top/bottom edge = above/below it, on the empty
  // area under the tree = last at the top level; dragging a child left past its parent's indent takes it out.
  var drag = null, press = null;
  function clearMarks() { host.querySelectorAll(".fd-before,.fd-after,.fd-nest,.fd-end").forEach(function (n) { n.classList.remove("fd-before", "fd-after", "fd-nest", "fd-end"); }); }
  function zone(rowEl, y) { var r = rowEl.getBoundingClientRect(), f = (y - r.top) / r.height; return f < 0.28 ? "before" : f > 0.72 ? "after" : "nest"; }
  function rowOf(slug) { return host.querySelector('.fd-row[data-slug="' + CSS.escape(slug) + '"]'); }
  function dragStart(slug, rowEl) {
    drag = { slug: slug, ghost: el("div", "fd-ghost", (S.bySlug[slug] || {}).title || "") };
    document.body.appendChild(drag.ghost); document.body.classList.add("fd-dragging");
    rowEl.classList.add("fd-src");
  }
  function dragTo(x, y) {
    var pane = host.closest(".sidebar") || host.closest("#sidebar") || host, box = pane.getBoundingClientRect();
    drag.scroll = y < box.top + 40 ? -12 : y > box.bottom - 40 ? 12 : 0;
    if (drag.scroll && !drag.scroller) drag.scroller = setInterval(function () { if (drag && drag.scroll) pane.scrollTop += drag.scroll; }, 30);
    drag.ghost.style.transform = "translate(" + (x + 12) + "px," + (y + 8) + "px)";
    clearMarks();
    var t = document.elementFromPoint(x, y), r = t && t.closest && t.closest(".fd-row"), head = t && t.closest && t.closest('.fd-sec[data-sec="ws"] .fd-head');
    var ws = t && t.closest && t.closest('.fd-sec[data-sec="ws"]');
    drag.target = null;
    if (head) { head.classList.add("fd-nest"); drag.target = { top: true }; return; }
    if (!r || !host.contains(r)) {
      // Empty space of the 작업 공간 section, below its last row: last at the top level.
      var root = ws && ws.querySelector(".fd-root"), rows = root ? root.querySelectorAll(".fd-row") : [];
      var last = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : 0;
      if (root && y > last) { root.classList.add("fd-end"); drag.target = { end: true }; }
      return;
    }
    var target = r.dataset.slug, me = S.bySlug[drag.slug];
    if (target === drag.slug) {
      // Own row, pulled left past the parent's indent: one level out, right after the parent.
      var pad = parseFloat(r.style.paddingLeft) || 6;
      if (me && me.parent && S.bySlug[me.parent] && x < r.getBoundingClientRect().left + pad - 4) {
        var pr = rowOf(me.parent);
        if (pr) pr.classList.add("fd-after");
        drag.target = { slug: me.parent, zone: "after" };
      }
      return;
    }
    if (isUnder(target, drag.slug)) return;
    var z = zone(r, y);
    if (z === "nest" && me && me.parent === target) return;
    r.classList.add("fd-" + z);
    drag.target = { slug: target, zone: z };
    if (z === "nest" && kids(target).length && !isOpen(target)) {
      if (drag.hover !== target) { clearTimeout(drag.hoverTimer); drag.hover = target; drag.hoverTimer = setTimeout(function () { toggleOpen(target, true); render(); var src = drag && rowOf(drag.slug); if (src) src.classList.add("fd-src"); }, 650); }
    } else { clearTimeout(drag.hoverTimer); drag.hover = null; }
  }
  // The sidebar shows the move at once; the server answer (or its error, which reloads) follows.
  function placeLocal(slug, body) {
    var p = S.bySlug[slug]; if (!p) return;
    var list = S.pages.filter(function (x) { return x !== p; });
    var parent = body.parent || null, sib = list.filter(function (x) { return (x.parent && S.bySlug[x.parent] ? x.parent : null) === parent; });
    var anchor = body.before ? S.bySlug[body.before] : body.after ? S.bySlug[body.after] : null;
    var at = anchor && sib.indexOf(anchor) >= 0 ? list.indexOf(anchor) + (body.after ? 1 : 0) : sib.length ? list.indexOf(sib[sib.length - 1]) + 1 : list.length;
    p.parent = parent; list.splice(at, 0, p); S.pages = list;
    render();
  }
  function dragEnd() {
    var d = drag; drag = null;
    clearTimeout(d.hoverTimer); clearInterval(d.scroller); d.ghost.remove(); document.body.classList.remove("fd-dragging"); clearMarks();
    host.querySelectorAll(".fd-src").forEach(function (n) { n.classList.remove("fd-src"); });
    var stop = function (ev) { ev.preventDefault(); ev.stopPropagation(); };
    window.addEventListener("click", stop, true);
    setTimeout(function () { window.removeEventListener("click", stop, true); }, 0);
    if (!d.target) return;
    var body, label;
    if (d.target.top) { body = { parent: null, index: 0 }; label = "맨 위로 옮김"; }
    else if (d.target.end) body = { parent: null };
    else {
      var t = S.bySlug[d.target.slug];
      if (d.target.zone === "nest") { toggleOpen(t.slug, true); body = { parent: t.slug }; label = "'" + t.title + "' 안으로 옮김"; }
      else { var parent = t.parent && S.bySlug[t.parent] ? t.parent : null; body = d.target.zone === "before" ? { parent: parent, before: t.slug } : { parent: parent, after: t.slug }; }
    }
    placeLocal(d.slug, body);
    move(d.slug, body, label);
  }
  host.addEventListener("pointerdown", function (ev) {
    if (ev.pointerType !== "mouse") return;
    var r = ev.target.closest(".fd-row");
    if (!r || ev.button !== 0 || ev.target.closest("button")) return;
    var sec = r.closest(".fd-sec");
    if (!sec || ["ws", "journal"].indexOf(sec.dataset.sec) < 0) return;
    press = { slug: r.dataset.slug, x: ev.clientX, y: ev.clientY, row: r };
  });
  window.addEventListener("pointermove", function (ev) {
    if (ev.pointerType !== "mouse" || (!press && !drag)) return;
    if (press && !drag) {
      if (Math.abs(ev.clientX - press.x) + Math.abs(ev.clientY - press.y) < 6) return;
      dragStart(press.slug, press.row); press = null;
    }
    ev.preventDefault();
    dragTo(ev.clientX, ev.clientY);
  }, { passive: false });
  window.addEventListener("pointerup", function (ev) {
    if (ev.pointerType !== "mouse") return;
    press = null;
    if (drag) dragEnd();
  });
  host.addEventListener("keydown", function (ev) {
    var r = ev.target.closest && ev.target.closest(".fd-row");
    if (!r) return;
    var p = S.bySlug[r.dataset.slug];
    if (ev.altKey && ev.shiftKey) {
      var dir = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "in", ArrowLeft: "out" }[ev.key];
      if (dir && p) { ev.preventDefault(); keyMove(p, dir); }
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      var links = Array.prototype.slice.call(host.querySelectorAll(".fd-link")), i = links.indexOf(ev.target);
      var next = links[i + (ev.key === "ArrowDown" ? 1 : -1)]; if (next) { ev.preventDefault(); next.focus(); }
    }
    if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && p && kids(p.slug).length) { ev.preventDefault(); toggleOpen(p.slug, ev.key === "ArrowRight"); render(); }
  });
  // Touch: hold 400 ms (a move before that is a scroll), then the row follows the finger; let go without moving and
  // the move sheet opens as before.
  var lastTouch = 0;
  var hold = null;
  host.addEventListener("touchstart", function (ev) {
    lastTouch = Date.now();
    var r = ev.target.closest && ev.target.closest(".fd-row"), t = ev.touches[0];
    if (hold) { clearTimeout(hold.timer); hold = null; }
    if (!r || ev.target.closest("button") || ev.touches.length > 1 || drag) return;
    var sec = r.closest(".fd-sec"), movable = sec && ["ws", "journal"].indexOf(sec.dataset.sec) >= 0;
    hold = { x: t.clientX, y: t.clientY, row: r, slug: r.dataset.slug, armed: false, movable: movable };
    hold.timer = setTimeout(function () { if (!hold) return; hold.armed = true; r.classList.add("fd-armed"); if (navigator.vibrate) navigator.vibrate(15); }, 400);
  }, { passive: true });
  host.addEventListener("touchmove", function (ev) {
    var t = ev.touches[0];
    if (!hold) return;
    if (!hold.armed) { if (Math.abs(t.clientX - hold.x) + Math.abs(t.clientY - hold.y) > 8) { clearTimeout(hold.timer); hold = null; } return; }
    ev.preventDefault();
    if (!hold.movable) return;
    if (!drag) { if (Math.abs(t.clientX - hold.x) + Math.abs(t.clientY - hold.y) < 6) return; hold.row.classList.remove("fd-armed"); dragStart(hold.slug, hold.row); }
    dragTo(t.clientX, t.clientY);
  }, { passive: false });
  function touchDone(ev, cancelled) {
    if (!hold) return;
    var h = hold; hold = null;
    clearTimeout(h.timer); h.row.classList.remove("fd-armed");
    if (drag) { ev.preventDefault(); if (cancelled) drag.target = null; dragEnd(); return; }
    if (h.armed && !cancelled) { ev.preventDefault(); if (!sheet) moveSheet([h.slug]); }
  }
  host.addEventListener("touchend", function (ev) { touchDone(ev, false); });
  host.addEventListener("touchcancel", function (ev) { touchDone(ev, true); });
  host.addEventListener("contextmenu", function (ev) {
    var r = ev.target.closest(".fd-row"); if (!r || !S.bySlug[r.dataset.slug]) return;
    ev.preventDefault();
    press = null;
    // A finger's long press is handled by the touch hold above (drag or move sheet).
    if (ev.pointerType === "touch" || Date.now() - lastTouch < 1500) return;
    pageMenu(r, S.bySlug[r.dataset.slug]);
  });

  function tagMenu(anchor, t) {
    menu(anchor, [
      { label: "이 태그 페이지 보기", fn: function () { S.filter = t.name; render(); } },
      { label: "이름 바꾸기", fn: function () { ask(anchor, "새 이름", t.name, function (n) { if (n !== t.name) tagCall("PATCH", t.name, { name: n }, "태그 이름 바꿈"); }); } },
      { label: "색 바꾸기", fn: function () { colorMenu(anchor, t); } },
      { label: "다른 태그와 합치기", fn: function () { ask(anchor, "합칠 태그 이름 ('" + t.name + "' 이(가) 사라지고 이 태그로 바뀌어요)", "", function (n) { api("POST", "/api/tags/merge", { from: [t.name], into: n }).then(function (d) { toast("태그를 합쳤어요.", d.batch); reload(); }, oops); }); } },
      { label: "삭제", danger: true, fn: function () { if (window.confirm("'" + t.name + "' 태그를 지울까요? 페이지는 그대로 있어요.")) tagCall("DELETE", t.name, null, "태그를 지웠어요."); } },
    ]);
  }
  function colorMenu(anchor, t) { menu(anchor, COLORS.map(function (c) { return { label: COLOR_KO[c], fn: function () { tagCall("PATCH", t.name, { color: c }, "색을 바꿨어요."); } }; })); }
  function tagCall(method, name, body, done) {
    api(method, "/api/tags/" + encodeURIComponent(name), body).then(function (d) { if (S.filter === name) S.filter = body && body.name || null; toast(done, d.batch); reload(); }, oops);
  }
  function manageTags() {
    var box = overlay("태그 관리");
    var add = el("form", "fd-bar"); var inp = el("input", "fd-in"); inp.placeholder = "새 태그 이름"; inp.setAttribute("aria-label", "새 태그 이름");
    var go = el("button", "fd-btn primary", "만들기"); go.type = "submit"; add.appendChild(inp); add.appendChild(go);
    add.onsubmit = function (ev) { ev.preventDefault(); if (!inp.value.trim()) return; api("POST", "/api/tags", { name: inp.value }).then(function (d) { toast("태그를 만들었어요.", d.batch); closeSheet(); reload(); }, oops); };
    box.appendChild(add);
    var ul = el("div", "fd-dest");
    S.tags.forEach(function (t) {
      var line = el("div", "fd-tagline");
      var c = el("span", "fd-chip c-" + t.color); c.appendChild(el("span", null, t.name)); c.appendChild(el("small", null, String(t.count)));
      var m = el("button", "fd-btn", "⋯"); m.type = "button"; m.setAttribute("aria-label", t.name + " 메뉴"); m.onclick = function () { tagMenu(m, t); };
      line.appendChild(c); line.appendChild(m); ul.appendChild(line);
    });
    box.appendChild(ul);
  }

  function headTags() {
    if (current === "index") return;
    var page = S.bySlug[current];
    if (!page) return;
    var anchor = editor ? document.querySelector(".docbar") : document.querySelector("#article h1") || document.querySelector("#article .page-head");
    if (!anchor) return;
    var bar = document.getElementById("fd-headtags");
    if (!bar) { bar = el("div", "fd-headtags"); bar.id = "fd-headtags"; anchor.after(bar); }
    bar.replaceChildren();
    page.tags.forEach(function (name) {
      var t = S.tags.filter(function (x) { return x.name === name; })[0] || { color: "gray" };
      var c = el("span", "fd-chip c-" + t.color); c.appendChild(el("span", null, name));
      var x = el("button", "fd-cx", "×"); x.type = "button"; x.setAttribute("aria-label", name + " 태그 빼기");
      x.onclick = function () { api("PUT", "/api/page/" + encodeURIComponent(current) + "/tags", { tags: [name], mode: "remove" }).then(function (d) { toast("태그를 뺐어요.", d.batch); reload(); }); };
      c.appendChild(x); bar.appendChild(c);
    });
    var add = el("button", "fd-chip fd-addtag", "+ 태그"); add.type = "button";
    add.onclick = function () {
      var inp = el("input", "fd-tagin"); inp.setAttribute("list", "fd-taglist"); inp.placeholder = "태그 이름, Enter"; inp.setAttribute("aria-label", "태그 이름");
      var dl = document.getElementById("fd-taglist") || el("datalist"); dl.id = "fd-taglist"; dl.replaceChildren();
      S.tags.forEach(function (t) { var o = el("option"); o.value = t.name; dl.appendChild(o); });
      document.body.appendChild(dl);
      add.replaceWith(inp); inp.focus();
      inp.onkeydown = function (ev) {
        if (ev.key === "Escape") return headTags();
        if (ev.key !== "Enter" || !inp.value.trim()) return;
        ev.preventDefault();
        api("PUT", "/api/page/" + encodeURIComponent(current) + "/tags", { tags: inp.value.split(","), mode: "add" }).then(function (d) { toast("태그를 달았어요.", d.batch); reload(); }, oops);
      };
      inp.onblur = function () { setTimeout(headTags, 150); };
    };
    bar.appendChild(add);
  }

  function allPages() {
    var box = overlay("모든 페이지");
    box.classList.add("wide");
    var sel = [], last = -1, tag = S.filter;
    var tools = el("div", "fd-bar");
    var q = el("input", "fd-in"); q.placeholder = "제목으로 찾기"; q.setAttribute("aria-label", "제목으로 찾기");
    var tf = el("select", "fd-in"); tf.setAttribute("aria-label", "태그 필터");
    [""].concat(S.tags.map(function (t) { return t.name; })).forEach(function (n) { var o = el("option", null, n ? "#" + n : "모든 태그"); o.value = n; if (n === tag) o.selected = true; tf.appendChild(o); });
    tools.appendChild(q); tools.appendChild(tf); box.appendChild(tools);
    var acts = el("div", "fd-bar fd-acts");
    var info = el("span", "fd-info", "");
    var bMove = el("button", "fd-btn", "옮기기"), bTag = el("button", "fd-btn", "태그 달기"), bDel = el("button", "fd-btn danger", "휴지통");
    [bMove, bTag, bDel].forEach(function (b) { b.type = "button"; });
    acts.appendChild(info); acts.appendChild(bMove); acts.appendChild(bTag); acts.appendChild(bDel); box.appendChild(acts);
    var ul = el("div", "fd-all"); box.appendChild(ul);
    var shown = [];
    function paint() {
      var text = q.value.trim().toLowerCase();
      tag = tf.value || null;
      shown = S.pages.filter(function (p) { return (!text || (p.title || "").toLowerCase().indexOf(text) >= 0) && (!tag || p.tags.indexOf(tag) >= 0); });
      ul.replaceChildren();
      shown.forEach(function (p, i) {
        var line = el("label", "fd-pl" + (sel.indexOf(p.slug) >= 0 ? " sel" : ""));
        var cb = el("input"); cb.type = "checkbox"; cb.checked = sel.indexOf(p.slug) >= 0; cb.setAttribute("aria-label", p.title + " 고르기");
        line.addEventListener("click", function (ev) {
          if (ev.target.tagName === "A") return;
          ev.preventDefault();
          var on = sel.indexOf(p.slug) < 0;
          if (ev.shiftKey && last >= 0) { var a = Math.min(last, i), b = Math.max(last, i); for (var k = a; k <= b; k++) if (sel.indexOf(shown[k].slug) < 0) sel.push(shown[k].slug); }
          else if (on) sel.push(p.slug); else sel.splice(sel.indexOf(p.slug), 1);
          last = i; mark();
        });
        line.appendChild(cb);
        var a = el("a", null, p.title || "제목 없음"); a.href = href(p.slug); line.appendChild(a);
        var path = []; for (var up = S.bySlug[p.parent]; up && path.length < 3; up = S.bySlug[up.parent]) path.unshift(up.title);
        if (path.length) line.appendChild(el("small", null, path.join(" / ")));
        p.tags.forEach(function (n) { var t = S.tags.filter(function (x) { return x.name === n; })[0] || { color: "gray" }; line.appendChild(el("span", "fd-chip sm c-" + t.color, n)); });
        ul.appendChild(line);
      });
      mark();
    }
    function mark() {
      Array.prototype.forEach.call(ul.children, function (line, k) { var on = shown[k] && sel.indexOf(shown[k].slug) >= 0; line.classList.toggle("sel", on); line.querySelector("input").checked = on; });
      info.textContent = sel.length ? sel.length + "개 고름" : shown.length + "개 페이지 · Shift/Ctrl 로 여러 개";
      [bMove, bTag, bDel].forEach(function (b) { b.disabled = !sel.length; });
    }
    var reopen = function () { allPages(); };
    bMove.onclick = function () { moveSheet(sel.slice(), reopen); };
    bTag.onclick = function () { ask(bTag, sel.length + "개 페이지에 달 태그 (쉼표로 여러 개)", "", function (n) {
      api("POST", "/api/folders/bulk", { action: "tag", slugs: sel, tags: n.split(",") }).then(function (d) { toast(d.tagged + "개 페이지에 태그를 달았어요.", d.batch); reload().then(reopen); }, oops);
    }); };
    bDel.onclick = function () {
      api("POST", "/api/folders/bulk", { action: "trash", slugs: sel }).then(function (d) { toast(d.trashed + "개 페이지를 휴지통으로 옮겼어요.", d.batch); reload().then(reopen); }, oops);
    };
    q.oninput = paint; tf.onchange = paint; paint(); q.focus();
    if (firstLoad) firstLoad.then(paint);
  }

  function suggest() {
    var box = overlay("정리 제안");
    box.classList.add("wide");
    var status = el("p", "fd-info", "흩어진 페이지를 살펴보는 중이에요…"); box.appendChild(status);
    api("POST", "/api/folders/suggest", {}).then(function (d) {
      status.textContent = "맨 위에 흩어진 페이지 " + d.loose + "개 중 " + d.items.length + "개에 제안이 있어요. (" + (d.source === "glm" ? "GLM 5.3 Flash" : "규칙") + ") 고른 것만 적용돼요.";
      if (!d.items.length) return;
      var list = el("div", "fd-all"), picks = d.items.map(function () { return true; });
      d.items.forEach(function (it, i) {
        var line = el("label", "fd-pl sel");
        var cb = el("input"); cb.type = "checkbox"; cb.checked = true; cb.onchange = function () { picks[i] = cb.checked; line.classList.toggle("sel", cb.checked); };
        line.appendChild(cb);
        var diff = el("span", "fd-diff");
        diff.appendChild(el("b", null, it.title));
        if (it.parent || it.newFolder) diff.appendChild(el("span", "fd-arrow", " → " + (it.parentTitle || it.newFolder) + (it.newFolder ? " (새 폴더)" : "")));
        line.appendChild(diff);
        (it.tags || []).forEach(function (n) { line.appendChild(el("span", "fd-chip sm c-blue", "+" + n)); });
        if (it.reason) line.appendChild(el("small", null, it.reason));
        list.appendChild(line);
      });
      box.appendChild(list);
      var bar = el("div", "fd-bar"), go = el("button", "fd-btn primary", "적용"); go.type = "button";
      go.onclick = function () {
        var items = d.items.filter(function (_, i) { return picks[i]; });
        if (!items.length) return;
        go.disabled = true;
        api("POST", "/api/folders/suggest/apply", { items: items }).then(function (r) { closeSheet(); toast("정리 제안 " + r.applied + "개 적용", r.batch); reload(); }, function (e) { go.disabled = false; toast(e.message, null, true); });
      };
      bar.appendChild(go); box.appendChild(bar);
    }, function (e) { status.textContent = e.message; });
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest("[data-fv-mode]");
    if (!b || editor) return;
    ev.preventDefault();
    if (b.getAttribute("aria-pressed") === "true") return;
    b.disabled = true;
    api("PUT", "/api/page/" + encodeURIComponent(current) + "/view", { mode: b.dataset.fvMode })
      .then(function () { location.reload(); }, function (e) { b.disabled = false; toast(e.message, null, true); });
  });
  window.AcardFolders = { reload: reload, allPages: allPages, suggest: suggest };
  var allLink = document.querySelector('[data-act="all"]');
  if (allLink) allLink.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); allPages(); }, true);
  base.classList.add("fd-host");
  var cached = local("acard-tree-cache");
  if (cached) { apply(cached); render(); }
  if (side) {
    try { if (cached) side.scrollTop = +sessionStorage.getItem("acard-side-scroll"); } catch (e) {}
    addEventListener("pagehide", function () { try { sessionStorage.setItem("acard-side-scroll", side.scrollTop); } catch (e) {} });
  }
  var firstLoad = reload().catch(function () { if (!cached) { base.classList.remove("fd-host"); if (host !== base) host.remove(); } });
})();
