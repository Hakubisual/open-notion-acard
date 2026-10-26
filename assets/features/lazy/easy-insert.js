// Insert-while-typing helpers, lazy so the editor first screen stays under its budget:
// grouped slash / insert menu with Korean+English search, previews and 자주 쓰는 items, markdown shortcuts, and "|a|b|" + Enter -> table.
(function () {
  "use strict";
  var editor = window.AcardEditor;
  if (!editor) return;
  // slash-core: pure search, ranking and grouping for the slash / insert menu (tests/slash-menu.test.ts runs it).
  var SLASH_ALIASES = {
    paragraph: "글 문단 본문 text p", heading1: "제목 h1 헤딩 큰제목", heading2: "제목 h2 소제목", heading3: "제목 h3", heading4: "제목 h4 가장작은제목",
    bulleted: "목록 글머리 리스트 불릿 ul -", numbered: "번호 순서 목록 ol 1.", to_do: "할일 체크 체크박스 todo 투두 할 일",
    toggle: "토글 접기 펼치기", toggle_heading1: "토글 제목 접히는 제목 h1", toggle_heading2: "토글 제목 접히는 제목 h2", toggle_heading3: "토글 제목 접히는 제목 h3", callout: "콜아웃 강조 박스 메모 주의", quote: "인용 따옴표 quote", code: "코드 code 프로그램",
    diagram: "다이어그램 흐름 흐름도 순서 단계 타임라인 마인드맵 조직도 플로우 diagram flow mermaid 그림", chart: "차트 그래프 막대 선 원 파이 통계 chart graph",
    visual: "시각 애니메이션 svg", html: "html 웹 데모", divider: "구분선 줄 선 hr ---", database: "표 데이터베이스 db 보드 칸반",
    image: "이미지 사진 그림 img 사진첨부", video: "영상 동영상 비디오 유튜브", audio: "오디오 소리 음악", file: "파일 첨부 문서",
    embed: "임베드 삽입 지도", bookmark: "북마크 링크 카드", columns: "열 나누기 단 컬럼", table: "표 테이블 간단표 엑셀 시트 table grid",
    equation: "수식 수학 latex", subpage: "하위 페이지", toc: "목차", breadcrumb: "경로", button: "버튼", progress: "진행률 진행 퍼센트", db_ref: "데이터베이스 연결 db"
  };
  var SLASH_EN = {
    paragraph: "text paragraph plain body", heading1: "heading title h1 large", heading2: "heading subtitle h2", heading3: "heading h3 small", heading4: "heading h4 smallest",
    bulleted: "bullet list unordered", numbered: "numbered ordered list", to_do: "todo to-do checkbox task check", toggle: "toggle collapse details fold",
    toggle_heading1: "toggle heading collapse h1", toggle_heading2: "toggle heading collapse h2", toggle_heading3: "toggle heading collapse h3",
    callout: "callout note box info tip", quote: "quote blockquote citation", code: "code snippet program", diagram: "diagram flowchart mermaid mindmap",
    chart: "chart graph bar line pie", visual: "visual animation svg", html: "html web demo custom", divider: "divider line separator hr",
    database: "database table board kanban calendar", image: "image photo picture img", video: "video youtube movie",
    audio: "audio sound music", file: "file attachment upload pdf", embed: "embed iframe map", bookmark: "bookmark link card url",
    columns: "columns layout split side", table: "table simple grid sheet", equation: "equation math latex formula", subpage: "page subpage child new",
    toc: "toc contents outline", breadcrumb: "breadcrumb path", button: "button link cta", progress: "progress bar percent", db_ref: "database linked view reference"
  };
  var SLASH_DESC = {
    paragraph: "보통 문장을 쓰는 기본 블록", heading1: "페이지의 큰 단락 제목", heading2: "단락 안의 중간 제목", heading3: "작은 소제목", heading4: "가장 작은 소제목",
    bulleted: "점으로 시작하는 목록", numbered: "순서가 있는 번호 목록", to_do: "체크해서 끝낸 일을 표시", toggle: "눌러서 접고 펴는 내용",
    toggle_heading1: "아래 내용을 접는 큰 제목", toggle_heading2: "아래 내용을 접는 중간 제목", toggle_heading3: "아래 내용을 접는 작은 제목",
    callout: "아이콘과 색으로 눈에 띄는 상자", quote: "다른 사람의 말이나 글을 인용", code: "글꼴과 줄이 그대로인 코드", diagram: "흐름도·순서도·마인드맵 그림",
    chart: "숫자를 막대·선·원 그래프로", visual: "움직이는 SVG·HTML 시각 자료", html: "직접 쓴 HTML을 그대로 보여 줘요", divider: "내용 사이를 나누는 가로줄",
    database: "속성이 있는 표·보드·캘린더", image: "사진을 올리거나 붙여넣기", video: "유튜브 주소나 영상 파일",
    audio: "소리·음악 파일 재생", file: "문서 파일을 첨부", embed: "지도·코드 같은 바깥 화면", bookmark: "링크를 제목·그림 카드로",
    columns: "내용을 2~3열로 나란히", table: "칸만 있는 가벼운 표", equation: "LaTeX 수식을 보기 좋게", subpage: "이 페이지 안에 새 페이지",
    toc: "이 페이지 제목으로 목차", breadcrumb: "위 페이지 경로 표시", button: "누르면 링크로 가는 버튼", progress: "얼마나 했는지 막대로", db_ref: "다른 데이터베이스를 여기서 보기"
  };
  var SLASH_GROUPS = [["basic", "기본 블록"], ["part", "부품"], ["mine", "내 부품"], ["component", "컴포넌트"], ["media", "미디어·임베드"], ["advanced", "고급"]];
  var SLASH_MEDIA = { image: 1, video: 1, audio: 1, file: 1, embed: 1, bookmark: 1 };
  var SLASH_ADVANCED = { code: 1, diagram: 1, chart: 1, visual: 1, html: 1, database: 1, equation: 1, subpage: 1, toc: 1, breadcrumb: 1, button: 1, progress: 1, db_ref: 1 };
  var SLASH_KEYS = { heading1: "#", heading2: "##", heading3: "###", heading4: "####", bulleted: "-", numbered: "1.", to_do: "[]", quote: ">", code: "```", divider: "---" };
  // Compatibility jamo: initial consonants (ㅈㅁ) and a half-composed IME syllable still find 제목.
  var CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ", JONG = "_ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
  function slashJamo(s) {
    var out = "";
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charCodeAt(i) - 0xac00;
      out += c < 0 || c > 11171 ? s.charAt(i) : CHO.charAt(Math.floor(c / 588)) + JUNG.charAt(Math.floor(c % 588 / 28)) + (c % 28 ? JONG.charAt(c % 28) : "");
    }
    return out;
  }
  function slashCho(s) { return s.replace(/[\uac00-\ud7a3]/g, function (ch) { return CHO.charAt(Math.floor((ch.charCodeAt(0) - 0xac00) / 588)); }); }
  function slashFlat(s) { return String(s || "").toLowerCase().replace(/\s+/g, ""); }
  function slashDesc(entry) { return entry.desc || SLASH_DESC[entry.type] || entry.hint || ""; }
  function slashGroupOf(entry) { var t = entry.type; return /^part:/.test(t) ? (entry.mine ? "mine" : "part") : /^component:/.test(t) ? "component" : SLASH_MEDIA[t] ? "media" : SLASH_ADVANCED[t] ? "advanced" : "basic"; }
  // -1 = no match; higher = better. Tiers are 20+ apart so personal use (slashBoost, max 18) only breaks ties.
  // The label on screen may be the English/Chinese one from i18n-app.js (window.AcardLang); both count as the label.
  function slashShown(label) { var lang = typeof window !== "undefined" && window.AcardLang; return lang ? String(lang.text(label)) : label; }
  function slashScore(entry, query) {
    var raw = slashFlat(query);
    if (!raw) return 0;
    var q = slashJamo(raw), labels = [entry.label, slashShown(entry.label)].map(function (l) { return slashJamo(slashFlat(l)); });
    if (labels.some(function (l) { return l === q; })) return 300;
    if (labels.some(function (l) { return l.indexOf(q) === 0; })) return 200;
    if (labels.some(function (l) { return l.indexOf(q) > 0; })) return 150;
    var text = [entry.hint, SLASH_ALIASES[entry.type], entry.aliases, SLASH_EN[entry.type], entry.type, slashDesc(entry)].join(" ").toLowerCase();
    var words = text.split(/\s+/).filter(Boolean);
    if (/^[\u3131-\u314e]+$/.test(raw)) {
      var cho = slashCho(slashFlat(entry.label));
      if (cho.indexOf(raw) === 0) return 120;
      if (cho.indexOf(raw) > 0 || words.some(function (w) { return slashCho(w).indexOf(raw) === 0; })) return 80;
    }
    if (words.some(function (w) { return slashJamo(w).indexOf(q) === 0; })) return 100;
    return slashJamo(words.join("")).indexOf(q) >= 0 ? 60 : -1;
  }
  function slashBoost(type, recents, freq) {
    var r = recents.indexOf(type);
    return (r >= 0 ? 6 - Math.min(r, 5) : 0) + Math.min(freq[type] || 0, 12);
  }
  // Sections in menu order. No query: 자주 쓰는 (recent + frequent, up to 5) on top, then every group in catalog order.
  // With a query: only matching items, best first inside each group, groups ordered by their best item.
  function slashSections(items, query, recents, freq) {
    recents = recents || []; freq = freq || {};
    var q = slashFlat(query);
    var scored = items.map(function (entry, i) {
      var s = slashScore(entry, q);
      return { entry: entry, s: s < 0 ? -1 : s + slashBoost(entry.type, recents, freq), i: i };
    }).filter(function (x) { return x.s >= 0; });
    function best(a, b) { return b.s - a.s || a.i - b.i; }
    var sections = SLASH_GROUPS.map(function (g) {
      return { key: g[0], title: g[1], items: scored.filter(function (x) { return slashGroupOf(x.entry) === g[0]; }) };
    }).filter(function (sec) { return sec.items.length; });
    if (q) {
      sections.forEach(function (sec) { sec.items.sort(best); });
      sections.sort(function (a, b) { return b.items[0].s - a.items[0].s; });
    } else {
      var top = scored.filter(function (x) { return x.s > 0; }).sort(best).slice(0, 5);
      if (top.length) sections.unshift({ key: "frequent", title: "자주 쓰는", items: top });
    }
    return sections.map(function (sec) { return { key: sec.key, title: sec.title, items: sec.items.map(function (x) { return x.entry; }) }; });
  }
  function slashRemember(recents, freq, type) {
    var next = {}, keys = Object.keys(freq || {});
    keys.forEach(function (k) { next[k] = freq[k]; });
    next[type] = (next[type] || 0) + 1;
    keys = Object.keys(next).sort(function (a, b) { return next[b] - next[a]; });
    keys.slice(24).forEach(function (k) { if (k !== type) delete next[k]; });
    return { recents: [type].concat((recents || []).filter(function (t) { return t !== type; })).slice(0, 6), freq: next };
  }
  // slash-core end
  var RECENT_KEY = "acard-slash-recent", FREQ_KEY = "acard-slash-freq";
  function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; } }
  function remember(type) {
    var next = slashRemember(stored(RECENT_KEY, []), stored(FREQ_KEY, {}), type);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next.recents)); localStorage.setItem(FREQ_KEY, JSON.stringify(next.freq)); } catch (e) {}
  }
  var MD_SHORTCUTS = [
    [/^####$/, "heading4"], [/^###$/, "heading3"], [/^##$/, "heading2"], [/^#$/, "heading1"], [/^[-*+]$/, "bulleted"], [/^1[.)]$/, "numbered"],
    [/^\[[ xX]?\]$/, "to_do"], [/^>$/, "quote"], [/^```[\w-]*$/, "code"]
  ];
  // contenteditable turns the typed trailing space into U+00A0.
  function focusText(id) {
    var t = document.querySelector('.blk[data-id="' + CSS.escape(id) + '"] .text[contenteditable]');
    if (t) { t.focus(); var r = document.createRange(); r.selectNodeContents(t); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  var api = {
    toType: function (block, type, meta, checked) { block.type = type; block.text = ""; block.meta = meta || null; block.checked = !!checked; document.getElementById("slash").hidden = true; editor.render(); focusText(block.id); editor.scheduleSave(); },
    divider: function (block, index) { block.type = "divider"; block.text = ""; block.meta = null; var next = { id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: "paragraph", text: "", checked: false, indent: 0, meta: null }; editor.state.blocks.splice(index + 1, 0, next); editor.render(); focusText(next.id); editor.scheduleSave(); }
  };
  function shortcut(raw, block, index) {
    if (block.type !== "paragraph") return false;
    if (raw === "---") { api.divider(block, index); return true; }
    var m = /^(\S+)[ \u00a0]$/.exec(raw);
    if (!m) return false;
    for (var i = 0; i < MD_SHORTCUTS.length; i += 1) {
      if (!MD_SHORTCUTS[i][0].test(m[1])) continue;
      var type = MD_SHORTCUTS[i][1];
      api.toType(block, type, type === "code" && m[1].length > 3 ? { lang: m[1].slice(3) } : null, type === "to_do" && /x/i.test(m[1]));
      return true;
    }
    return false;
  }
  function pipeTable(raw, block) {
    if (block.type !== "paragraph") return false;
    if (!/^\s*\|(.+\|)+\s*$/.test(raw)) return false;
    var cells = raw.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
    if (cells.length < 2) return false;
    block.type = "table"; block.text = "";
    block.meta = { columns: cells, rows: [cells.map(function () { return ""; })], header: true };
    return true;
  }
  function slashEsc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // Skeleton previews for basic blocks: L = text line, H = heading bar, B/N/C = bullet/number/check row, then a frame.
  var SLASH_SK = {
    paragraph: "LLl", heading1: "1Ll", heading2: "2Ll", heading3: "3Ll", heading4: "3l", bulleted: "BBB", numbered: "NNN", to_do: "CcC",
    toggle: "TII", toggle_heading1: "TII", toggle_heading2: "TII", toggle_heading3: "TII", quote: "Q", callout: "K", code: "X", divider: "L-L",
    database: "G", table: "G", db_ref: "G", columns: "W", image: "M", video: "M", embed: "M", bookmark: "M", audio: "M", file: "M"
  };
  function slashSkeleton(type) {
    var out = "", spec = SLASH_SK[type] || "";
    for (var i = 0; i < spec.length; i += 1) {
      var c = spec.charAt(i), line = '<i class="sx-ln"></i>';
      out += c === "L" ? line : c === "l" ? '<i class="sx-ln sx-short"></i>' : /[123]/.test(c) ? '<i class="sx-hd sx-hd' + c + '"></i>'
        : c === "B" ? '<span class="sx-row"><b class="sx-dot"></b>' + line + "</span>" : c === "N" ? '<span class="sx-row"><b class="sx-num">' + (i + 1) + ".</b>" + line + "</span>"
        : c === "C" || c === "c" ? '<span class="sx-row"><b class="sx-box' + (c === "c" ? " on" : "") + '"></b>' + line + "</span>" : c === "T" ? '<span class="sx-row"><b class="sx-tw">▸</b><i class="sx-hd sx-hd3"></i></span>'
        : c === "I" ? '<i class="sx-ln sx-in"></i>' : c === "-" ? '<hr class="sx-hr">' : c === "Q" ? '<span class="sx-quote">' + line + '<i class="sx-ln sx-short"></i></span>'
        : c === "K" ? '<span class="sx-callout"><b>!</b><span>' + line + '<i class="sx-ln sx-short"></i></span></span>' : c === "X" ? '<span class="sx-code"><i></i><i></i><i></i></span>'
        : c === "G" ? '<span class="sx-grid">' + new Array(10).join("<i></i>") + "</span>" : c === "W" ? '<span class="sx-cols"><span>' + line + line + "</span><span>" + line + line + "</span></span>"
        : '<span class="sx-media"></span>';
    }
    return out;
  }
  function slashPreview(entry) {
    var ui = /^component:(.+)$/.exec(entry.type), C = window.AcardComponents, comp = ui && C && C.getComponent(ui[1]);
    // A component whose family chunk is not loaded yet: load it and draw the preview again when it arrives.
    if (ui && C && !comp && C.ensure) C.ensure(ui[1]).then(function (c) { var pv = document.querySelector('.sx-pv[data-type="' + entry.type + '"]'); if (c && pv) pv.innerHTML = slashPreview(entry); });
    var art = comp ? '<div class="sx-pv-ui">' + C.renderComponentBlock({ type: "component", text: JSON.stringify(comp.sample), meta: { ui: comp.id } }) + "</div>"
      : entry.preview ? '<div class="sx-pv-ui sx-pv-part">' + entry.preview() + "</div>"
      : '<div class="sx-pv-sk">' + (slashSkeleton(entry.type) || '<span class="sx-pv-ico">' + entry.ico + "</span>") + "</div>";
    var key = SLASH_KEYS[entry.type];
    return '<div class="sx-pv-art">' + art + '</div><p class="sx-pv-name">' + slashEsc(entry.label) + '</p><p class="sx-pv-desc">' + slashEsc(slashDesc(entry)) + "</p>" +
      (key ? '<p class="sx-pv-key"><span>단축키</span> <kbd>' + slashEsc(key) + "</kbd></p>" : "");
  }
  function select(menu, i) {
    var buttons = menu.querySelectorAll(".sx-list button"), b = buttons[i], pv = menu.querySelector(".sx-pv");
    buttons.forEach(function (x, n) { x.classList.toggle("sel", n === i); x.setAttribute("aria-selected", n === i ? "true" : "false"); });
    if (!b) return;
    b.scrollIntoView({ block: "nearest" });
    if (pv && b.dataset.type !== pv.dataset.type) { pv.dataset.type = b.dataset.type || ""; pv.innerHTML = menu.sxItems[i] ? slashPreview(menu.sxItems[i]) : ""; }
  }
  // #38: parts join the menu as 부품 (5 defaults) and 내 부품 (GET /api/parts). They arrive after the first menu, so an open
  // menu is drawn again in place: the returned array is the editor's keyboard list, refilled rather than replaced.
  var parts = null, last = null;
  editor.lazy("parts").then(function (p) {
    parts = p;
    if (last && !last.el.hidden) menu.apply(null, last.args);
    return p.load(editor.api).then(function () { if (last && !last.el.hidden) menu.apply(null, last.args); });
  }, function () {});
  // The last 부품 row opens the gallery (lazy part-gallery) on the slash line's index; the typed "/" goes away first.
  var GALLERY = { type: "part:gallery", label: "모든 부품 보기", hint: "부품", desc: "갤러리에서 찾아 넣기", part: "gallery", aliases: "부품 part 갤러리 gallery 모두 전체 all 찾기",
    ico: '<svg class="acp-thumb" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="5" width="11" height="9" rx="2" class="t-soft"/><rect x="18" y="5" width="11" height="9" rx="2" class="t-acc"/><rect x="3" y="18" width="11" height="9" rx="2" class="t-bar"/><rect x="18" y="18" width="11" height="9" rx="2" class="t-soft"/></svg>' };
  function openGallery(block) {
    var index = editor.state.blocks.indexOf(block);
    if (/^\/[^\s/]{0,12}$/.test(block.text)) { block.text = ""; if (block.meta) delete block.meta.richText; editor.render(); editor.scheduleSave(); }
    editor.lazy("part-gallery").then(function (g) { g.open(index); }, function () { window.alert("부품 갤러리를 불러오지 못했어요. 새로고침해 주세요."); });
    return true;
  }
  function applyPart(block, type) {
    if (type === GALLERY.type) return openGallery(block);
    if (!/^part:/.test(type) || !parts || !parts.pick(block, type.slice(5))) return false;
    remember(type);
    editor.render();
    editor.scheduleSave();
    return true;
  }
  // Draws the grouped menu into the #slash element and returns the items in button order (the editor's keyboard index).
  function menu(el, items, query, anchor, apply) {
    var keep = last && last.el === el && last.args[1] === items ? last.flat : [];
    last = { el: el, args: [el, items, query, anchor, apply], flat: keep };
    items = items.concat(parts ? parts.slashItems() : [], [GALLERY]);
    var sections = slashSections(items, query, stored(RECENT_KEY, []), stored(FREQ_KEY, {})), flat = [];
    var wide = innerWidth >= 900, sheet = innerWidth < 640;
    el.className = "slash slash-x" + (wide ? " sx-wide" : "") + (sheet ? " sx-sheet" : "");
    el.innerHTML = '<div class="sx-list"><h3>' + (query ? "‘" + slashEsc(query) + "’ 찾는 중" : "블록 고르기") + "</h3></div>" + (wide ? '<aside class="sx-pv" aria-hidden="true"></aside>' : "");
    var list = el.firstChild;
    sections.forEach(function (sec) {
      var group = document.createElement("div");
      group.className = "sx-group sx-" + sec.key;
      group.setAttribute("role", "group");
      group.innerHTML = "<h4>" + slashEsc(sec.title) + "</h4>";
      sec.items.forEach(function (entry) {
        var i = flat.push(entry) - 1, button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "option");
        button.dataset.i = String(i);
        button.dataset.type = entry.type;
        button.innerHTML = '<span class="ico">' + entry.ico + '</span><span class="sx-txt"><span class="sx-label">' + slashEsc(entry.label) + '</span><span class="sx-desc">' + slashEsc(slashDesc(entry)) + "</span></span>";
        button.addEventListener("mousedown", function (ev) { ev.preventDefault(); apply(entry.type); });
        if (wide) button.addEventListener("mouseenter", function () { select(el, i); });
        group.appendChild(button);
      });
      list.appendChild(group);
    });
    if (!flat.length) list.insertAdjacentHTML("beforeend", '<p class="slash-empty">맞는 블록이 없어요</p>');
    el.sxItems = flat;
    el.style.left = el.style.top = el.style.bottom = el.style.maxHeight = "";
    var vv = window.visualViewport;
    if (sheet) {
      // Bottom sheet above the on-screen keyboard.
      var floor = Math.max(0, innerHeight - (vv ? vv.height + vv.offsetTop : innerHeight)), line = anchor.getBoundingClientRect();
      el.style.bottom = floor + "px";
      // Keep the typed line visible: shrink the sheet to the room below it (min 240px), then scroll the rest.
      el.style.maxHeight = Math.max(240, Math.min(480, innerHeight * .62, innerHeight - floor - line.bottom - 12)) + "px";
      el.hidden = false;
      var cover = line.bottom + 12 - el.getBoundingClientRect().top;
      if (cover > 0) window.scrollBy(0, cover);
    } else {
      var rect = anchor.getBoundingClientRect(), below = innerHeight - rect.bottom - 18, above = rect.top - 18, down = below >= 320 || below >= above;
      el.style.left = Math.max(12, Math.min(rect.left, innerWidth - (wide ? 588 : 332))) + "px";
      el.style.maxHeight = Math.max(160, Math.min(440, down ? below : above)) + "px";
      if (down) el.style.top = rect.bottom + 6 + "px"; else el.style.bottom = innerHeight - rect.top + 6 + "px";
    }
    el.hidden = false;
    select(el, 0);
    keep.length = 0;
    Array.prototype.push.apply(keep, flat);
    el.sxItems = keep;
    return keep;
  }
  // templates.js appends its "new page from template" button to #slash; keep it as the last list row.
  var slashEl = document.getElementById("slash");
  if (slashEl) new MutationObserver(function () {
    var t = slashEl.querySelector(":scope > .template-slash"), list = slashEl.querySelector(".sx-list");
    if (t && list) { t.classList.add("sx-template"); list.appendChild(t); }
  }).observe(slashEl, { childList: true });
  function matches(items, query) {
    return slashSections(items, query, stored(RECENT_KEY, []), stored(FREQ_KEY, {})).filter(function (s) { return s.key !== "frequent"; })
      .reduce(function (all, s) { return all.concat(s.items); }, []);
  }
  // Gutter "+": the editor adds an empty paragraph and focuses it; typing "/" there opens this menu (as in Notion).
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest || !ev.target.closest(".blk > .gutter > button:not(.drag-handle)")) return;
    var t = document.activeElement;
    if (!t || !t.matches(".text[contenteditable]") || t.textContent) return;
    t.textContent = "/";
    var r = document.createRange(); r.selectNodeContents(t); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    t.dispatchEvent(new Event("input", { bubbles: true }));
  });
  function imageHandles() {
    document.querySelectorAll("#blocks .mb-image figure.img:not([data-handles])").forEach(function (fig) {
      fig.dataset.handles = "1";
      var id = fig.closest(".blk[data-id]") && fig.closest(".blk[data-id]").dataset.id;
      ["l", "r"].forEach(function (side) {
        var h = document.createElement("span");
        h.className = "img-resize img-resize-" + side;
        h.setAttribute("aria-hidden", "true");
        h.addEventListener("pointerdown", function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          var box = fig.parentElement.getBoundingClientRect(), start = ev.clientX, w0 = fig.getBoundingClientRect().width;
          h.setPointerCapture(ev.pointerId);
          function move(e) {
            var w = w0 + (side === "r" ? 1 : -1) * (e.clientX - start) * 2;
            var pct = Math.max(10, Math.min(100, Math.round(w / box.width * 20) * 5));
            fig.style.width = pct + "%"; fig.dataset.pct = pct;
          }
          function up() {
            h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up);
            var b = editor.state.blocks.find(function (x) { return x.id === id; });
            if (b && fig.dataset.pct) { b.meta = Object.assign({}, b.meta, { width: Number(fig.dataset.pct) }); editor.render(); editor.scheduleSave(); }
          }
          h.addEventListener("pointermove", move); h.addEventListener("pointerup", up);
        });
        fig.appendChild(h);
      });
    });
  }
  new MutationObserver(imageHandles).observe(document.getElementById("blocks"), { childList: true });
  imageHandles();
  editor.provide("easy-insert", { menu: menu, apply: applyPart, select: select, matches: matches, remember: remember, shortcut: shortcut, pipeTable: pipeTable });
})();
