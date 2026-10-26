(() => {
  const ORDER = ["board", "progress", "blog", "notes"];
  const NAMES = { board: "작업 보드", blog: "블로그", notes: "작업 노트", progress: "진행 현황" };
  const ICONS = {
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
    progress: '<path d="M5 20V12M10 20V8M15 20v-5M20 20V5"/>',
    blog: '<path d="M6 3h8l5 5v13H6Z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
    notes: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    doc: '<path d="M6 3h8l5 5v13H6Z"/><path d="M14 3v5h5"/>',
    spark: '<path d="M12 3c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5C9.7 8.9 11.4 7.2 12 3Z"/>',
  };
  const icon = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const href = (slug) => "/" + encodeURIComponent(slug) + "/";
  const TONES = { red: "tone-red", blue: "tone-blue", green: "tone-green", purple: "tone-purple", pink: "tone-pink", yellow: "tone-yellow" };
  const colTone = (i, n) => (i === n - 1 ? "tone-done" : i === 0 ? "" : "tone-doing");
  const shortDate = (iso) => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return (d.getMonth() + 1) + "월 " + d.getDate() + "일"; };
  const ago = (ms) => {
    const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
    if (m < 60) return m + "분 전";
    if (m < 1440) return Math.round(m / 60) + "시간 전";
    return Math.round(m / 1440) + "일 전";
  };
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => (r.ok ? r.json() : Promise.reject(r)));

  function boardHtml(board) {
    if (!board) return "";
    const cols = board.columns;
    const kanban = '<div class="ui-kanban">' + cols.map((c, i) => {
      const items = board.rows.filter((r) => r.status === c.id);
      return '<section class="ui-col ' + colTone(i, cols.length) + '"><div class="ui-col-head"><span class="ui-count">' + items.length + "</span>" + esc(c.name) + "</div>" +
        items.map((r) => '<a class="ui-item" href="' + href(r.page) + '"><span class="t">' + esc(r.title) + '</span><span class="m">' +
          (r.priority ? '<span class="ui-badge ' + (TONES[r.priorityColor] || "") + '">' + esc(r.priority) + "</span>" : "") +
          (r.date ? "<span>" + shortDate(r.date) + "</span>" : "") + "</span></a>").join("") + "</section>";
    }).join("") + "</div>";
    const table = '<table class="ui-table" hidden><thead><tr><th>이름</th><th>상태</th><th>우선순위</th><th>마감일</th><th>태그</th></tr></thead><tbody>' +
      board.rows.map((r) => '<tr><td><a href="' + href(r.page) + '">' + esc(r.title) + "</a></td><td>" + esc(r.statusName || "") + "</td><td>" +
        (r.priority ? '<span class="ui-badge ' + (TONES[r.priorityColor] || "") + '">' + esc(r.priority) + "</span>" : "") + "</td><td>" + shortDate(r.date) + "</td><td>" + esc(r.tags.join(", ")) + "</td></tr>").join("") + "</tbody></table>";
    return '<section class="ui-card home-w" data-w="board"><div class="ui-card-head"><h2>' + icon("board") + '<a href="' + href(board.slug) + '">' + esc(board.title) + '</a></h2><div class="ui-seg" role="group"><button type="button" data-view="board" aria-pressed="true">보드</button><button type="button" data-view="table" aria-pressed="false">표</button></div></div>' + kanban + table + "</section>";
  }

  function progressHtml(data) {
    const board = data.board;
    const total = board ? board.rows.length : 0;
    const stats = board ? [{ name: "전체 작업", n: total, pct: total ? Math.round(board.rows.filter((r) => r.status === board.columns[board.columns.length - 1].id).length / total * 100) : 0 }]
      .concat(board.columns.map((c) => { const n = board.rows.filter((r) => r.status === c.id).length; return { name: c.name, n, pct: total ? Math.round(n / total * 100) : 0 }; })) : [];
    const statHtml = stats.length ? '<div class="home-stats">' + stats.map((s) => '<div class="ui-stat"><div class="label">' + esc(s.name) + '</div><div class="value">' + s.n + '</div><div class="bar"><div class="ui-progress"><i style="width:' + s.pct + '%"></i></div>' + s.pct + "%</div></div>").join("") + "</div>" : "";
    const recent = '<div class="ui-card home-recent"><div class="ui-card-head"><h2>' + icon("clock") + "최근 수정</h2></div>" +
      (data.recent.length ? '<ul class="ui-list">' + data.recent.slice(0, 4).map((p) => "<li>" + icon("doc") + '<a href="' + href(p.slug) + '">' + esc(p.title) + '</a><span class="when">' + ago(p.updated) + "</span></li>").join("") + "</ul>" : '<p class="home-empty">아직 수정한 페이지가 없어요.</p>') + "</div>";
    const agent = data.sessions.length
      ? '<div class="ui-card home-agent"><div class="ui-card-head"><h2>' + icon("spark") + "에이전트 작업</h2></div><ul class=\"ui-list\">" + data.sessions.map((s) => '<li><span class="ui-badge ' + (s.status === "open" ? "tone-purple" : "tone-green") + '">' + (s.status === "open" ? "진행 중" : "완료") + "</span><span class=\"t\">" + esc(s.title) + '</span><span class="when">' + ago(s.updated) + "</span></li>").join("") + "</ul></div>"
      : '<div class="ui-soft home-agent-hint"><span class="home-hint-icon">' + icon("spark") + '</span><b>에이전트 연결하면 여기 작업이 보여요</b><span>에이전트를 연결하고 자동으로 작업을 불러와 보세요.</span><a class="ui-btn ui-btn-sm" href="/settings/agents">에이전트 연결</a></div>';
    return '<section class="ui-card home-w" data-w="progress"><div class="ui-card-head"><h2>' + icon("progress") + "진행 현황</h2></div>" + statHtml + '<div class="home-split">' + recent + agent + "</div></section>";
  }

  function blogHtml(blog) {
    if (!blog) return "";
    return '<section class="ui-card home-w" data-w="blog"><div class="ui-card-head"><h2>' + icon("blog") + '<a href="' + href(blog.slug) + '">' + esc(blog.title) + '</a></h2><button type="button" class="ui-btn ui-btn-primary ui-btn-sm" data-new-post="' + esc(blog.slug) + '">새 글</button></div><ul class="ui-list">' +
      blog.rows.map((r) => "<li>" + icon("doc") + '<a href="' + href(r.page) + '">' + esc(r.title) + '</a><span class="ui-badge ' + (r.status === "published" ? "tone-green" : "") + '">' + esc(r.statusName || "초안") + '</span><span class="when">' + shortDate(r.date) + "</span></li>").join("") + "</ul></section>";
  }

  function notesHtml(data) {
    const pinned = data.pinned.length ? '<ul class="ui-list">' + data.pinned.map((p) => "<li>" + icon(p.kind === "folder" ? "notes" : "doc") + '<a href="' + href(p.slug) + '">' + esc(p.title) + "</a></li>").join("") + "</ul>" : '<p class="home-empty">즐겨찾기한 페이지가 여기 모여요.</p>';
    return '<section class="ui-card home-w" data-w="notes"><div class="ui-card-head"><h2>' + icon("notes") + "작업 노트</h2></div>" +
      '<form class="home-capture"><input class="home-capture-in" name="text" maxlength="2000" placeholder="빠르게 메모하기" aria-label="빠르게 메모하기"><button class="ui-btn ui-btn-primary ui-btn-sm" type="submit">저장</button></form><p class="home-capture-msg" role="status"></p>' +
      '<div class="home-split"><div><h3 class="home-sub">즐겨찾기</h3>' + pinned + '</div><div><h3 class="home-sub">최근 페이지</h3><ul class="ui-list">' + data.recent.slice(0, 5).map((p) => "<li>" + icon("doc") + '<a href="' + href(p.slug) + '">' + esc(p.title) + '</a><span class="when">' + ago(p.updated) + "</span></li>").join("") + "</ul></div></div></section>";
  }

  function offerHtml() {
    return '<section class="ui-card home-offer" data-w="offer"><div class="ui-card-head"><h2>' + icon("spark") + '홈을 내 방식으로 꾸며 보세요</h2><button type="button" class="ui-btn ui-btn-sm" data-offer-close>닫기</button></div><p class="home-offer-sub">고른 항목의 예시 보드와 글이 바로 만들어져요. 언제든 지울 수 있어요.</p><div class="home-offer-picks">' +
      ORDER.map((k) => '<label class="home-pick"><input type="checkbox" value="' + k + '">' + icon(k) + "<b>" + NAMES[k] + "</b></label>").join("") + '</div><button type="button" class="ui-btn ui-btn-primary" data-offer-apply>홈에 추가</button><p class="home-capture-msg" role="status"></p></section>';
  }

  function firstRunHtml(fr) {
    if (!fr) return "";
    if (fr.tasks && fr.tasks.length) {
      return '<section class="ui-card home-next" data-w="next"><div class="ui-card-head"><h2>' + icon("board") + '다음 할 일</h2>' + (fr.tasksSlug ? '<a class="ui-btn ui-btn-sm" href="' + href(fr.tasksSlug) + '">' + "목록 열기" + "</a>" : "") + '</div><ul class="ui-list">' +
        fr.tasks.map((t) => '<li><span class="home-box" aria-hidden="true"></span><span class="t">' + esc(t) + "</span></li>").join("") + '</ul><p class="home-offer-sub">에이전트가 세션을 시작할 때 이 목록을 먼저 읽고, 끝날 때 고쳐 둬요.</p></section>';
    }
    if (!fr.connectedAt && fr.state !== "dismissed") {
      return '<section class="ui-card home-connect" data-w="connect"><div class="ui-card-head"><h2>' + icon("spark") + '에이전트 연결하기</h2><button type="button" class="ui-btn ui-btn-sm" data-connect-close>닫기</button></div><p class="home-offer-sub">Claude Code 같은 에이전트를 연결하면 프로젝트 문서와 할 일을 여기에 정리해 줘요.</p><a class="ui-btn ui-btn-primary" href="/onboarding?step=connect">연결하러 가기</a></section>';
    }
    return "";
  }

  function importHtml(checklist) {
    if (!checklist || checklist.page !== false || checklist.import !== false) return "";
    return '<section class="ui-card home-import" data-w="import"><div class="ui-card-head"><h2>' + icon("doc") + '다른 앱에서 옮겨 오기</h2></div><p class="home-offer-sub">노션이나 옵시디언에 있던 페이지를 그대로 가져와요.</p><a class="ui-btn ui-btn-primary" href="/import" data-home-import>가져오기</a></section>';
  }

  async function saveLayout(widgets) {
    return post("/api/profile", { home_layout: widgets === null ? null : { widgets } });
  }

  // local: the local app's profile extras (local/server.ts localProfile) - its steps replace agent sign-in and sharing.
  function checklistHtml(checklist, local) {
    const first = ["page", "첫 페이지 쓰기", "나만의 첫 페이지를 작성해요", "/edit/page-" + Math.random().toString(36).slice(2, 8) + "/?new&create"];
    if (local) checklist = Object.assign({}, checklist, { mcp: local.mcpCopied, backup: local.backupDone });
    const steps = local ? [
      first,
      ["mcp", "로컬 MCP 주소 복사", "Claude Code·Codex에 이 PC의 Acard를 붙여요", local.mcp],
      ["import", "노션·옵시디언 가져오기", "노션 zip이나 옵시디언 볼트를 올려요", "/import"],
      ["backup", "백업 파일 받기", "내 PC의 페이지를 zip 하나로 받아 둬요", "/__local/archive/export"],
    ] : [
      first,
      ["agent", "에이전트 연결하기", "Claude Code·Codex에 Acard를 붙여요", "/settings/agents/"],
      ["import", "노션·옵시디언에서 가져오기", "내보낸 zip이나 볼트 폴더를 올려요", "/import"],
      ["share", "공유 링크 만들기", "한 번에 게시하고 링크를 보내요", href(checklist.shareSlug || "index") + "?share=1"],
    ];
    const done = steps.filter(([key]) => checklist[key]).length;
    let collapsed = done === 4;
    try { collapsed = collapsed || localStorage.getItem("acard-start-collapsed") === "1"; } catch {}
    return '<section class="ui-card home-checklist" data-done="' + done + '"><div class="ui-card-head"><h2>' + icon("spark") + 'Acard 시작하기</h2><span class="home-check-summary"' + (collapsed ? "" : " hidden") + '>' + done + ' / 4 완료</span>' +
      '<button class="ui-btn ui-btn-sm" type="button" data-checklist-toggle aria-expanded="' + !collapsed + '" aria-controls="home-checklist-body">' + (collapsed ? "펼치기" : "접기") + '</button></div><div id="home-checklist-body"' + (collapsed ? " hidden" : "") + '><div class="home-check-progress"><span>' + done + ' / 4 완료</span><div class="ui-progress" role="progressbar" aria-label="시작하기 진행률" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' + done + '"><i style="width:' + done * 25 + '%"></i></div></div><div class="home-check-grid">' +
      steps.map(([key, title, description, target]) => '<a class="home-check-step" data-step="' + key + '" data-complete="' + Boolean(checklist[key]) + '" href="' + esc(target) + '"' + (key === "backup" ? " download" : "") + '><span class="home-check-circle" aria-label="' + (checklist[key] ? "완료" : "미완료") + '">' + (checklist[key] ? "✓" : "") + '</span><span class="home-check-copy"><b>' + title + '</b><span>' + description + '</span></span><span class="home-check-arrow" aria-hidden="true">→</span></a>').join("") + '</div></div></section>';
  }

  // 시작 가이드 (issue 140): while it runs it takes the place of the 시작하기 checklist and the import card.
  function guideHtml(guide, data) {
    if (!guide || !guide.enabled || !guide.active) return "";
    const n = guide.count || 0, s = guide.steps || {};
    const label = "시작 가이드 진행률";
    const bar = '<div class="ui-progress wg-progress" role="progressbar" aria-label="' + label + '" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' + n + '"><i style="width:' + n * 25 + '%"></i></div>';
    if (guide.celebrate) {
      // issue 149: the new editing tools in one line (text from /api/guide), only when they are on.
      const tools = guide.editTools ? '<p class="wg-sub wg-tools" data-guide-tools>' + esc(guide.editTools) + "</p>" : "";
      return '<section class="ui-card wg-card wg-done" data-w="guide"><div class="wg-head"><span class="wg-icon">' + icon("spark") + '</span><div><h2>시작 가이드를 모두 마쳤어요</h2><p class="wg-sub">불편한 점이 있으면 화면 캡처로 알려 주세요</p>' + tools + "</div></div>" + '<div class="wg-actions"><button type="button" class="ui-btn ui-btn-primary" data-guide-feedback>피드백 보내기</button><a class="wg-quiet" href="/guide">자세한 사용법</a></div></section>';
    }
    if (guide.done) return "";
    if (guide.skipped) {
      return '<section class="ui-card wg-bar" data-w="guide"><b>시작 가이드</b><span class="wg-progress-text">' + n + ' / 4 완료</span>' + bar + '<button type="button" class="ui-btn ui-btn-primary ui-btn-sm" data-guide-resume>이어서 하기</button></section>';
    }
    const fresh = "/edit/page-" + Math.random().toString(36).slice(2, 8) + "/?new&create";
    const last = data && data.recent && data.recent.find((p) => p.kind !== "folder");
    const shareSlug = (data && data.checklist && data.checklist.shareSlug) || (last && last.slug) || "index";
    const rows = [
      ["page", "AI가 쓴 마크다운 붙여 넣기", "새 페이지에 붙여 넣으면 표·차트가 그려져요", fresh],
      ["slash", "/ 메뉴 열어 보기", "빈 줄에서 / 를 눌러요", s.page && last ? "/edit/" + encodeURIComponent(last.slug) + "/" : fresh],
      ["search", "검색 열어 보기", "Ctrl+K 로 어디서든", null],
      ["share", "공유 미리보기", "링크는 아직 만들지 않아요", href(shareSlug)],
    ];
    const next = rows.find(([k]) => !s[k]) || rows[0];
    const resume = "이어서 하기";
    const row = ([key, title, hint, target]) => {
      const inner = '<span class="wg-check" aria-label="' + (s[key] ? "완료" : "미완료") + '">' + (s[key] ? "✓" : "") + '</span><span class="wg-copy"><b>' + title + "</b><span>" + hint + "</span></span>";
      const attrs = ' class="wg-step" data-step="' + key + '" data-complete="' + Boolean(s[key]) + '"';
      return target ? "<a" + attrs + ' href="' + esc(target) + '">' + inner + "</a>" : '<button type="button"' + attrs + ' data-guide-open="palette">' + inner + "</button>";
    };
    const opt = (key, title, target) => '<a class="wg-opt" data-step="' + key + '" data-complete="' + Boolean(s[key]) + '" href="' + target + '"><span class="wg-check" aria-hidden="true">' + (s[key] ? "✓" : "") + "</span>" + title + "</a>";
    return '<section class="ui-card wg-card" data-w="guide"><div class="wg-head"><span class="wg-icon">' + icon("spark") + '</span><div><h2>시작 가이드</h2><p class="wg-sub">직접 한 번씩 해 보면 1~2분이면 끝나요</p></div><div class="wg-meter"><span class="wg-progress-text">' + n + ' / 4 완료</span>' + bar + '</div></div><div class="wg-grid">' +
      rows.map(row).join("") + '</div><div class="wg-optional"><span class="wg-label">선택</span>' + opt("agent", "AI 에이전트 연결", "/settings/agents/") + opt("import", "노션·옵시디언 가져오기", "/import") + '</div><div class="wg-actions">' +
      (next[3] ? '<a class="ui-btn ui-btn-primary" data-guide-resume href="' + esc(next[3]) + '">' + resume + "</a>" : '<button type="button" class="ui-btn ui-btn-primary" data-guide-resume data-guide-open="palette">' + resume + "</button>") +
      '<button type="button" class="wg-quiet" data-guide-skip>그만보기</button></div></section>';
  }

  async function render(root, layout, local) {
    const widgets = layout ? layout.widgets : null;
    const [fr, data, guide] = await Promise.all([
      fetch("/api/first-run").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/home/summary").then((r) => r.json()),
      local ? null : fetch("/api/guide").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const guideCard = guideHtml(guide, data);
    const finished = Boolean(guide && guide.enabled && guide.done);
    const top = (guideCard || (finished ? "" : checklistHtml(data.checklist, local) + importHtml(data.checklist))) + (fr && fr.tasks && fr.tasks.length ? firstRunHtml(fr) : "");
    if (guide && guide.celebrate) post("/api/guide", { action: "celebrated" }).catch(() => {});
    const parts = widgets ? ORDER.filter((k) => widgets.includes(k)).sort((a, b) => widgets.indexOf(a) - widgets.indexOf(b)).map((k) => (k === "board" ? boardHtml(data.board) : k === "progress" ? progressHtml(data) : k === "blog" ? blogHtml(data.blog) : notesHtml(data))) : [offerHtml()];
    root.innerHTML = '<div class="home-top"><h1 class="home-title">홈</h1><a class="ui-btn ui-btn-primary" href="/settings#home">' + icon("spark") + "홈 꾸미기</a></div>" + top + parts.join("");
    root.hidden = false;
    document.body.classList.add("home-custom");
  }

  function wire(root, state) {
    root.addEventListener("click", async (e) => {
      if (e.target.closest("[data-guide-open=palette]")) {
        const open = document.querySelector("#palette-open") || document.querySelector("[data-open=palette]");
        if (open) open.click();
        return;
      }
      if (e.target.closest("button[data-guide-resume]")) { await post("/api/guide", { action: "resume" }).catch(() => {}); try { sessionStorage.removeItem("acard-guide-off"); } catch {} await render(root, state.layout, state.local); return; }
      if (e.target.closest("[data-guide-skip]")) { await post("/api/guide", { action: "skip" }).catch(() => {}); await render(root, state.layout, state.local); const r = root.querySelector("[data-guide-resume]"); if (r) r.focus(); return; }
      if (e.target.closest("[data-guide-feedback]")) { const f = document.querySelector(".fbt"); if (f) f.click(); return; }
      const step = state.local && e.target.closest('.home-check-step[data-step="mcp"], .home-check-step[data-step="backup"]');
      if (step) {
        if (step.dataset.step === "mcp") {
          e.preventDefault();
          await navigator.clipboard.writeText(state.local.mcp).catch(() => {});
          step.querySelector(".home-check-copy > span").textContent = "복사했어요 · " + state.local.mcp;
          state.local = (await post("/api/profile", { step: "mcp" }).catch(() => null) || {}).local || state.local;
        } else state.local = Object.assign({}, state.local, { backupDone: true });
        const at = root.querySelector('.home-check-step[data-step="' + step.dataset.step + '"]');
        at.dataset.complete = "true"; at.querySelector(".home-check-circle").textContent = "✓";
        return;
      }
      const toggle = e.target.closest("[data-checklist-toggle]");
      if (toggle) {
        const collapsed = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.textContent = collapsed ? "펼치기" : "접기";
        root.querySelector("#home-checklist-body").hidden = collapsed;
        root.querySelector(".home-check-summary").hidden = !collapsed;
        try { localStorage.setItem("acard-start-collapsed", collapsed ? "1" : "0"); } catch {}
        return;
      }
      const view = e.target.closest("[data-view]");
      if (view) {
        const card = view.closest(".home-w");
        card.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b === view)));
        card.querySelector(".ui-kanban").hidden = view.dataset.view !== "board";
        card.querySelector(".ui-table").hidden = view.dataset.view !== "table";
        return;
      }
      const np = e.target.closest("[data-new-post]");
      if (np) {
        np.disabled = true;
        try { const made = await post("/api/db/" + encodeURIComponent(np.dataset.newPost) + "/rows", { props: { "제목": "새 글", "상태": "draft" } }); location.assign("/edit/" + encodeURIComponent(made.row.page) + "/"); }
        catch { np.disabled = false; }
        return;
      }
      if (e.target.closest("[data-connect-close]")) { e.target.closest(".home-connect").remove(); post("/api/first-run", { state: "dismissed" }).catch(() => {}); return; }
      if (e.target.closest("[data-offer-close]")) { await saveLayout([]).catch(() => {}); state.layout = { widgets: [] }; await render(root, state.layout, state.local); return; }
      const apply = e.target.closest("[data-offer-apply]");
      if (apply) {
        const picks = [...root.querySelectorAll(".home-pick input:checked")].map((i) => i.value);
        const msg = root.querySelector(".home-offer .home-capture-msg");
        if (!picks.length) { msg.textContent = "하나 이상 골라 주세요."; return; }
        apply.disabled = true;
        try {
          await post("/api/home/starter", { presets: picks.filter((p) => p !== "progress") });
          await saveLayout(ORDER.filter((k) => picks.includes(k)));
          state.layout = { widgets: ORDER.filter((k) => picks.includes(k)) };
          await render(root, state.layout, state.local);
        } catch { msg.textContent = "저장하지 못했어요. 다시 시도해 주세요."; apply.disabled = false; }
      }
    });
    root.addEventListener("submit", async (e) => {
      const form = e.target.closest(".home-capture");
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector("input");
      const msg = form.nextElementSibling;
      if (!input.value.trim()) return;
      try { await post("/api/quick-note", { clientId: "home-" + Date.now().toString(36), text: input.value }); input.value = ""; msg.textContent = "빠른 메모에 저장했어요."; }
      catch { msg.textContent = "저장하지 못했어요. 다시 시도해 주세요."; }
    });
  }

  async function start() {
    const article = document.getElementById("article");
    if (!article || document.getElementById("acard-home")) return;
    const res = await fetch("/api/profile").catch(() => null);
    if (!res || !res.ok) return;
    const { profile, local } = await res.json();
    if (!profile) return;
    const root = document.createElement("div");
    root.id = "acard-home";
    root.hidden = true;
    article.before(root);
    const state = { layout: profile.home_layout === undefined ? { widgets: [] } : profile.home_layout, local: local || null };
    wire(root, state);
    await render(root, state.layout, state.local);
    let again = null;
    document.addEventListener("acard:page-fresh", () => {
      const fresh = document.getElementById("article");
      if (fresh && !root.isConnected) fresh.before(root);
    });
    document.addEventListener("acard:live-home", () => { clearTimeout(again); again = setTimeout(() => render(root, state.layout, state.local).catch(() => {}), 250); });
  }

  start();
})();
