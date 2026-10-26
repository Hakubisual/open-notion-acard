(function () {
  // Database seed rows use deterministic s... IDs; they are not editor-created pages.
  const editorPages = "SELECT 1 FROM pages p WHERE p.source = 'editor' AND NOT EXISTS (SELECT 1 FROM databases d WHERE d.slug = p.slug AND d.id LIKE 's%') AND NOT EXISTS (SELECT 1 FROM db_rows r JOIN databases d ON d.id = r.database_id WHERE r.page = p.slug AND d.id LIKE 's%' AND r.id LIKE d.id || '_%')";
  const examples = [
    {
      "name": "Getting started",
      "markdown": "# Getting started\n\nBreak your thinking into small blocks and pick it up again wherever you need it.\n\n## Writing in blocks\n\nEvery paragraph is a block. Drag it by the handle on the left and indent it with Tab.\n\n## The slash menu\n\nType / on an empty line to add a heading, a to-do or a table. Choose New page to start from a template.\n\n- [ ] Click this to-do to check it off\n- [ ] Try the meeting notes template on a new page\n\n## Databases\n\nTrack status, owners and dates in tables and boards. Filter and sort to see only what matters.\n\n## Connecting agents\n\nYour own scripts and AI agents can read and write pages as Markdown through the API."
    },
    {
      "name": "My first weekly plan",
      "markdown": "# My first weekly plan\n\nTurn this example into your own plan. Everything saves automatically.\n\n## Goal for this week\n\nWrite down one small goal you can finish.\n\n## To-dos\n\n- [ ] Monday: gather what you need\n- [ ] Wednesday: review progress\n- [ ] Friday: write down what you learned\n\n## Idea box\n\nKeep thoughts here as they come.\n\n## Weekly review\n\nOne thing that went well, one thing to change next time."
    }
  ];
  // issue 147: the local app with ACARD_LANG=en|zh makes its example pages in English, not as Korean data.
  const examplesEn = [
    {
      "name": "Getting started",
      "markdown": "# Getting started\n\nBreak your thinking into small blocks and pick it up again wherever you need it.\n\n## Writing in blocks\n\nEvery paragraph is a block. Drag it by the handle on the left and indent it with Tab.\n\n## The slash menu\n\nType / on an empty line to add a heading, a to-do or a table. Choose New page to start from a template.\n\n- [ ] Click this to-do to check it off\n- [ ] Try the meeting notes template on a new page\n\n## Databases\n\nTrack status, owners and dates in tables and boards. Filter and sort to see only what matters.\n\n## Connecting agents\n\nYour own scripts and AI agents can read and write pages as Markdown through the API."
    },
    {
      "name": "My first weekly plan",
      "markdown": "# My first weekly plan\n\nTurn this example into your own plan. Everything saves automatically.\n\n## Goal for this week\n\nWrite down one small goal you can finish.\n\n## To-dos\n\n- [ ] Monday: gather what you need\n- [ ] Wednesday: review progress\n- [ ] Friday: write down what you learned\n\n## Idea box\n\nKeep thoughts here as they come.\n\n## Weekly review\n\nOne thing that went well, one thing to change next time."
    }
  ];

  // Seoul has no daylight saving, so a fixed +9h offset is exact.
  const fillVars = (text, title) => {
    const now = new Date(Date.now() + 9 * 3600000).toISOString();
    const vars = { date: now.slice(0, 10), today: now.slice(0, 10), time: now.slice(11, 16), title };
    return String(text).replace(/\{\{(date|today|time|title)\}\}/g, (all, key) => vars[key]);
  };
  const fillBlock = (block, title) => {
    const value = block.type === "component" ? JSON.stringify(title).slice(1, -1) : title;
    const meta = typeof block.meta === "string" ? JSON.parse(block.meta) : block.meta;
    if (meta && Array.isArray(meta.richText)) meta.richText = meta.richText.map((run) => ({ ...run, text: fillVars(run.text, title) }));
    return { text: fillVars(block.text, value), meta: meta ? JSON.stringify(meta) : null };
  };

  registerFeature({
    services: {
      homeWelcome: async (db) => {
        if (await db.prepare("SELECT 1 FROM feature_templates_state WHERE key = 'examples'").first() || await db.prepare(editorPages + " LIMIT 1").first()) return "";
        return '<section id="templates-welcome" style="padding:20px;margin:20px 0;background:var(--grad-4)"><h2>Getting started</h2><form method="post" action="/api/templates/welcome"><button type="submit" style="padding:10px;border:0">Add example notes</button></form></section>';
      }
    },
    schema: async (db) => {
      await db.prepare("CREATE TABLE IF NOT EXISTS feature_templates_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    },
    api: async ({ path, method, request, env, db, url, helpers }) => {
      const fromTemplate = method === "POST" && /^\/api\/page\/([^/]+)\/from-template\/?$/.exec(path);
      if (fromTemplate) {
        let slug;
        try { slug = decodeURIComponent(fromTemplate[1]); } catch { slug = null; }
        const before = slug && await db.prepare("SELECT title FROM pages WHERE slug = ?").bind(slug).first();
        const response = await handleApi(request, env, db, url, false);
        if (!response.ok || !before) return response;
        const page = await db.prepare("SELECT title FROM pages WHERE slug = ?").bind(slug).first();
        const title = fillVars(page.title, before.title);
        const rows = (await db.prepare("SELECT id, type, text, meta FROM blocks WHERE page = ?").bind(slug).all()).results || [];
        const changed = rows.map((row) => ({ row, filled: fillBlock(row, title) })).filter(({ row, filled }) => filled.text !== String(row.text) || (row.meta != null && filled.meta !== JSON.stringify(typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta)));
        if (title === page.title && !changed.length) return response;
        await db.batch([
          db.prepare("UPDATE pages SET title = ? WHERE slug = ?").bind(title, slug),
          ...changed.map(({ row, filled }) => db.prepare("UPDATE blocks SET text = ?, meta = ? WHERE page = ? AND id = ?").bind(filled.text, filled.meta, slug, row.id)),
        ]);
        return response;
      }
      if (path === "/api/templates" && method === "GET") {
        const asset = await env.ASSETS.fetch(new Request(new URL("/templates-seed.json", request.url)));
        if (!asset.ok) return helpers.json({ error: "템플릿을 불러오지 못했어요." }, 503);
        const { templates } = await asset.json();
        const rows = await db.prepare("SELECT id, name, snapshot FROM editor_templates ORDER BY created DESC, id").all();
        const personal = (rows.results || []).map((row) => {
          const snapshot = JSON.parse(row.snapshot);
          const blocks = snapshot.blocks.map((block) => ({ ...block, checked: Boolean(block.checked), meta: typeof block.meta === "string" ? JSON.parse(block.meta) : block.meta }));
          return { id: row.id, name: row.name, icon: "file", description: "내가 저장한 페이지", blocks: helpers.normaliseBlocks(blocks) };
        });
        return helpers.json({ templates, personal });
      }
      if (path !== "/api/templates/welcome") return null;
      const existing = await db.prepare("SELECT value FROM feature_templates_state WHERE key = 'examples'").first();
      if (method === "GET") return helpers.json({ eligible: !existing && !await db.prepare(editorPages + " LIMIT 1").first() });
      if (method !== "POST") return helpers.json({ error: "지원하지 않는 요청이에요." }, 405);
      const redirect = (pages) => new Response(null, { status: 303, headers: { location: pages.length ? "/edit/" + encodeURIComponent(pages[0].slug) + "/" : "/", "cache-control": "no-store" } });
      if (existing) return redirect(JSON.parse(existing.value));
      const chosen = env && (env.ACARD_LANG === "en" || env.ACARD_LANG === "zh") ? examplesEn : examples;
      const pages = chosen.map((example) => ({ slug: "example-" + crypto.randomUUID(), title: example.name }));
      const receipt = JSON.stringify(pages);
      const statements = [db.prepare("INSERT OR IGNORE INTO feature_templates_state (key, value) SELECT 'examples', ? WHERE NOT EXISTS (" + editorPages + ")").bind(receipt)];
      chosen.forEach((example, index) => {
        const page = pages[index];
        const owned = "EXISTS (SELECT 1 FROM feature_templates_state WHERE key = 'examples' AND value = ?)";
        statements.push(db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) SELECT ?, ?, NULL, (SELECT COALESCE(MAX(ord), 0) + 10 FROM pages), 'note', ?, 'editor', NULL WHERE " + owned).bind(page.slug, page.title, Date.now(), receipt));
        helpers.normaliseBlocks(helpers.markdownToBlocks(example.markdown)).forEach((block, ord) => {
          statements.push(db.prepare("INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE " + owned).bind(page.slug, block.id, ord, block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null, receipt));
        });
      });
      // The claim, both pages and their blocks commit together, including concurrent requests.
      await db.batch(statements);
      const stored = await db.prepare("SELECT value FROM feature_templates_state WHERE key = 'examples'").first();
      return redirect(stored ? JSON.parse(stored.value) : []);
    }
  });
})();
