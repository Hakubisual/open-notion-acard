// 시작 가이드 (issue 140): four things a new member does once (a page, the / menu, search, the share preview) plus two optional
// ones (agent, import). State is one row in the workspace's feature_templates_state (key "guide"), so no migration.
// Who gets it: gate/account.ts marks OUTBOX guide-new:<workspace> only on a profile's FIRST onboarding finish while
// ACARD_GUIDE is "on"; the first GET here turns that mark into the row. Members onboarded before that never get a row
// unless they press 가이드 다시 보기 (restart). ACARD_GUIDE other than "on" switches everything off (old checklist).
(() => {
  const KEY = "guide";
  const DONE_STEPS = ["page", "slash", "search", "share"];
  const MARKED = ["slash", "search", "share"];
  const ACTIONS = ["step", "skip", "resume", "hide", "restart", "celebrated"];
  const EDIT_TOOLS_TIP = "블록 위에서 오른쪽 클릭(휴대폰은 블록 핸들 길게 누르기) = 블록 도구, 글을 드래그하고 오른쪽 클릭 = 그 부분만 바꾸는 도구, 빈 줄에서 Tab = 기능 찾기(도표·차트·타임라인을 검색하거나 문장으로 AI에게 맡기기)";

  async function readState(db) {
    const row = await db.prepare("SELECT value FROM feature_templates_state WHERE key = ?").bind(KEY).first();
    if (!row) return null;
    try { const v = JSON.parse(row.value); return v && typeof v === "object" ? { steps: {}, ...v } : null; } catch { return null; }
  }
  async function writeState(db, state) {
    await db.prepare("INSERT INTO feature_templates_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(KEY, JSON.stringify(state)).run();
    return state;
  }
  const fresh = () => ({ v: 1, startedAt: Date.now(), steps: {} });

  // Must match checklist.page in features/home-setup.js.
  async function madePage(db) {
    const states = await db.prepare("SELECT key, value FROM feature_templates_state WHERE key LIKE 'starter:%' OR key = 'examples'").all();
    const generated = new Set(["index"]);
    for (const row of states.results || []) {
      try { const v = JSON.parse(row.value); if (row.key === "examples") v.forEach((p) => generated.add(p.slug)); else if (v.slug) generated.add(v.slug); } catch {}
    }
    const rows = await db.prepare("SELECT p.slug FROM pages p WHERE p.source = 'editor' AND p.kind IN ('note', 'db') AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = p.slug) AND NOT EXISTS (SELECT 1 FROM page_imports i WHERE i.page = p.slug)").all();
    return (rows.results || []).some((r) => !generated.has(r.slug));
  }

  async function view(db, env, state) {
    const enabled = env.ACARD_GUIDE === "on";
    if (!enabled || !state) return { enabled, active: false };
    let changed = false;
    if (!state.steps.page && await madePage(db)) { state.steps.page = Date.now(); changed = true; }
    const run = ACARD_FEATURES.services.firstRunState ? await ACARD_FEATURES.services.firstRunState(db) : null;
    const imported = await db.prepare("SELECT 1 AS x FROM page_imports LIMIT 1").first();
    const steps = {
      page: Boolean(state.steps.page), slash: Boolean(state.steps.slash), search: Boolean(state.steps.search), share: Boolean(state.steps.share),
      agent: Boolean(run && (run.state === "connected" || run.state === "project_set")), import: Boolean(imported),
    };
    const count = DONE_STEPS.filter((k) => steps[k]).length;
    const done = count === DONE_STEPS.length;
    if (done && !state.doneAt) { state.doneAt = Date.now(); changed = true; }
    if (changed) await writeState(db, state);
    return {
      enabled, active: !state.hiddenAt, started: state.startedAt, steps, count, required: DONE_STEPS.length, done,
      skipped: Boolean(state.skippedAt) && !done, hidden: Boolean(state.hiddenAt), celebrate: done && !state.celebratedAt,
      // issue 149: the finish cards name the right-click tools and the Tab palette only where they exist (HUMAN_EDIT "on";
      // "flagged" is per account in the gate, which this workspace API cannot see, so it stays quiet there). The line
      // lives here, not in home.js / welcome-guide.js, so the client total stays under its cap.
      editTools: env.HUMAN_EDIT === "on" ? EDIT_TOOLS_TIP : null,
    };
  }

  registerFeature({
    schema: async (db) => {
      await db.prepare("CREATE TABLE IF NOT EXISTS feature_templates_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
      await db.prepare("CREATE TABLE IF NOT EXISTS page_imports (page TEXT PRIMARY KEY, kind TEXT NOT NULL, created INTEGER NOT NULL)").run();
    },
    api: async ({ path, method, request, env, db, helpers }) => {
      if (path !== "/api/guide") return null;
      if (env.ACARD_SESSION === "guest" || env.ACARD_GUEST_TOKEN !== undefined) return helpers.json({ error: "멤버만 볼 수 있어요." }, 401);
      const enabled = env.ACARD_GUIDE === "on";
      if (method === "GET") {
        let state = await readState(db);
        if (!state && enabled && env.OUTBOX && env.ACARD_WORKSPACE) {
          const mark = "guide-new:" + env.ACARD_WORKSPACE;
          if (await env.OUTBOX.get(mark)) {
            state = await writeState(db, fresh());
            await env.OUTBOX.delete(mark);
          }
        }
        return helpers.json(await view(db, env, state));
      }
      if (method !== "POST") return helpers.json({ error: "GET 이나 POST 로 보내 주세요." }, 405);
      const body = await request.json().catch(() => ({}));
      const action = body && body.action;
      if (!ACTIONS.includes(action)) return helpers.json({ error: "action 은 " + ACTIONS.join(", ") + " 중 하나예요." }, 400);
      if (!enabled) return helpers.json({ enabled: false, active: false });
      if (action === "restart") return helpers.json(await view(db, env, await writeState(db, fresh())));
      const state = await readState(db);
      if (!state) return helpers.json({ error: "시작한 가이드가 없어요." }, 409);
      if (action === "step") {
        if (!MARKED.includes(body.step)) return helpers.json({ error: "step 은 " + MARKED.join(", ") + " 중 하나예요." }, 400);
        state.steps[body.step] = state.steps[body.step] || Date.now();
      } else if (action === "skip") state.skippedAt = state.skippedAt || Date.now();
      else if (action === "resume") { delete state.skippedAt; delete state.hiddenAt; }
      else if (action === "hide") state.hiddenAt = Date.now();
      else if (action === "celebrated") state.celebratedAt = state.celebratedAt || Date.now();
      await writeState(db, state);
      return helpers.json(await view(db, env, state));
    },
  });
})();
