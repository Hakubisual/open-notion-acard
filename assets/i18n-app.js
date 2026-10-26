(() => {
  const lang = window.ACARD_LANG;
  if (!lang || lang === "ko") return;
  // Page content written by the user never goes through the dictionary: reader article, editor blocks, editable areas.
  const SKIP = '#article, #blocks, [contenteditable], [translate="no"], script, style, textarea, code, pre';
  const CHROME = 'button, [role="tab"], [role="menuitem"], .table-toolbar, .et-bar, .et-tools, .table-tabs, .crumbs, .dbempty, .tempty, .backlinks h2, .byline, .fv-mode, .fv-meta, .fv-new, .fv-time, .fv-badge, .fv-empty, .pf, .page-actions, .dbhead, .dbtable thead, .dbadd, .et-colbtn, .rowdel, .block-hit';
  const ATTRS = ["placeholder", "title", "aria-label", "alt", "data-tip"];
  const attrBlocked = (el) => el.tagName === "TEXTAREA" && !el.closest('#article, #blocks, [contenteditable], [translate="no"]') ? false : blocked(el);
  // #blocks itself is chrome (its aria-label); only what is inside it is page content.
  const blocked = (el) => { if (el.id === "blocks") return false; const s = el.closest(SKIP); return !!s && !(el.closest(CHROME) && s.contains(el.closest(CHROME)) && !el.closest('[contenteditable], [translate="no"], textarea')); };
  // [pattern, dictionary key, whether the captured name is app text (a default column name, "나") or user text (a query, a title)].
  const AROUND = [[/^‘(.+)’ 찾는 중$/, "‘{name}’ 찾는 중", false], [/^(.+) 열 메뉴$/, "{name} 열 메뉴", true], [/^(.+)\(나\)$/, "{name}(나)", true], [/^(.+) 고치기 · (.+)$/, "{name} 고치기 · {site}", false], [/^(.+) · (Acard)$/, null, true]];
  let map = null;
  const pending = [];
  const tr = (s) => {
    const key = s.trim();
    let hit = key && map[key];
    if (!hit && /\d/.test(key)) {
      const nums = key.match(/\d[\d,.]*/g);
      const tpl = map[key.replace(/\d[\d,.]*/g, "{n}")];
      if (tpl) { let i = 0; hit = tpl.replace(/\{n\}/g, () => nums[i++] ?? ""); }
    }
    // Labels built around a name the user typed: "<name> 열 메뉴", "<name>(나)", "<title> 고치기 · <site>".
    if (!hit) for (const [re, k, app] of AROUND) {
      const m = re.exec(key), tpl = m && (k ? map[k] : map[m[1]] && "{name} · {site}");
      if (tpl) { hit = tpl.replace("{name}", app && map[m[1]] || m[1]).replace("{site}", m[2] ?? ""); break; }
    }
    if (!hit || hit === key) return null;
    const out = s.replace(key, hit);
    return out === s ? null : out;
  };
  // The slash menu searches the label the user sees (issue 152), not only the Korean source.
  window.AcardLang = { text: (s) => (map && tr(s)) || s };
  // An empty block's placeholder (data-ph, drawn by CSS) is app text even inside the editable area.
  const ph = (el) => { const v = el.getAttribute("data-ph"), t = v && tr(v); if (t) el.setAttribute("data-ph", t); };
  const visit = (root) => {
    if (root.nodeType === 3) {
      const p = root.parentElement;
      if (p && !blocked(p)) { const v = tr(root.nodeValue); if (v) root.nodeValue = v; }
      return;
    }
    if (root.nodeType !== 1) return;
    if (root.hasAttribute("data-ph")) ph(root);
    root.querySelectorAll("[data-ph]").forEach(ph);
    if (!attrBlocked(root)) for (const a of ATTRS) { const v = root.getAttribute(a); if (v) { const t = tr(v); if (t) root.setAttribute(a, t); } }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType !== 1 || !n.matches('script, style, textarea, [contenteditable], [translate="no"]')) return NodeFilter.FILTER_ACCEPT;
        if (n.tagName === "TEXTAREA" && !attrBlocked(n)) for (const a of ATTRS) { const v = n.getAttribute(a); if (v) { const t = tr(v); if (t) n.setAttribute(a, t); } }
        return NodeFilter.FILTER_REJECT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) { if (!blocked(n.parentElement)) { const v = tr(n.nodeValue); if (v) n.nodeValue = v; } }
      else if (!attrBlocked(n)) for (const a of ATTRS) { const v = n.getAttribute(a); if (v) { const t = tr(v); if (t) n.setAttribute(a, t); } }
    }
  };
  const origAlert = window.alert, origConfirm = window.confirm, origPrompt = window.prompt;
  const msg = (s) => (map && typeof s === "string" ? tr(s) ?? s : s);
  window.alert = (s) => origAlert.call(window, msg(s));
  window.confirm = (s) => origConfirm.call(window, msg(s));
  window.prompt = (s, d) => origPrompt.call(window, msg(s), d);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") { if (map) visit(m.target); else pending.push(m.target); continue; }
      if (m.type === "attributes") { if (map) visit(m.target); continue; }
      for (const n of m.addedNodes) map ? visit(n) : pending.push(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, "data-ph"] });
  fetch("/i18n/app-" + lang + ".json").then((r) => r.json()).then((m) => {
    map = m;
    visit(document.body);
    for (const n of pending.splice(0)) visit(n);
    document.title = tr(document.title) ?? document.title;
  }).catch(() => undefined);
})();
