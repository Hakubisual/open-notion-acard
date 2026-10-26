const EDITOR_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS editor_page_settings (page TEXT PRIMARY KEY, icon TEXT, cover TEXT, width TEXT NOT NULL DEFAULT 'default', font TEXT NOT NULL DEFAULT 'default', favorite INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS editor_comments (id TEXT PRIMARY KEY, page TEXT NOT NULL, block_id TEXT, text TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS editor_comments_page ON editor_comments(page, created)",
  "CREATE TABLE IF NOT EXISTS editor_history (id TEXT PRIMARY KEY, page TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, snapshot TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS editor_history_page ON editor_history(page, created)",
  "CREATE TABLE IF NOT EXISTS editor_trash (page TEXT PRIMARY KEY, deleted INTEGER NOT NULL, permanent INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS editor_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, snapshot TEXT NOT NULL)",
];

// ai: the page's AI mark default (assets/ai-marks.js: edit | lock | ref | smart); small: Notion's small text.
const DEFAULT_SETTINGS = { icon: null, cover: null, width: "default", font: "default", favorite: false, ai: "edit", small: false };
const EDITOR_COLUMNS = [
  "ALTER TABLE editor_page_settings ADD COLUMN ai TEXT NOT NULL DEFAULT 'edit'",
  "ALTER TABLE editor_page_settings ADD COLUMN small INTEGER NOT NULL DEFAULT 0",
];
// The ids of assets/fonts/catalog.json (tests/font-library.test.ts keeps the two equal).
export const PAGE_FONTS = ["default", "serif", "mono", "gothic", "office", "dodum", "batang", "myeongjo", "hahmlet", "pen", "gamja", "poorstory", "dohyeon", "jua", "blackhan", "report"];

// Remembered per store key, like ensureAgentSchema (#17).
const editorSchemaReady = new Set();
export async function ensureEditorSchema(db) {
  if (db.acardKey && editorSchemaReady.has(db.acardKey)) return;
  await db.batch(EDITOR_SCHEMA.map((sql) => db.prepare(sql)));
  // Older stores get the columns too; an existing column is a duplicate-column error, ignored (Postgres: migration 037).
  for (const sql of EDITOR_COLUMNS) await db.prepare(sql).run().catch(() => {});
  if (db.acardKey) editorSchemaReady.add(db.acardKey);
}

export async function readEditorPageMeta(db, slug) {
  const row = await db.prepare("SELECT s.*, t.page AS trash_page, t.deleted AS trash_deleted, t.permanent AS trash_permanent FROM (SELECT ? AS page) p LEFT JOIN editor_page_settings s ON s.page = p.page LEFT JOIN editor_trash t ON t.page = p.page").bind(slug).first();
  return editorPageMeta(row);
}

// Row shape: editor_page_settings columns plus trash_page / trash_deleted / trash_permanent.
export function editorPageMeta(row) {
  const { page, trash_page, trash_deleted, trash_permanent, ...stored } = row || {};
  const settings = page ? { ...stored, favorite: stored.favorite === 1, ai: stored.ai || "edit", small: stored.small === 1 } : { ...DEFAULT_SETTINGS };
  return {
    settings,
    trashed: Boolean(trash_page),
    deletedAt: trash_deleted ?? null,
    permanent: trash_permanent === 1,
  };
}

async function snapshotPage(db, slug) {
  const page = await db.prepare("SELECT * FROM pages WHERE slug = ?").bind(slug).first();
  if (!page) return null;
  const blocks = await db.prepare("SELECT * FROM blocks WHERE page = ? ORDER BY ord").bind(slug).all();
  const links = await db.prepare("SELECT * FROM links WHERE src = ?").bind(slug).all();
  const { settings } = await readEditorPageMeta(db, slug);
  return { page, blocks: blocks.results ?? [], links: links.results ?? [], settings };
}

function versionInsert(db, slug, snapshot, claim = false) {
  const version = { id: crypto.randomUUID(), page: slug, title: snapshot.page.title, created: Date.now() };
  return {
    version,
    statement: db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) " + (claim
      ? "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE slug = ? AND updated = ? AND hash IS ?) AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ?)"
      : "VALUES (?, ?, ?, ?, ?)"))
      .bind(version.id, slug, version.title, version.created, JSON.stringify(snapshot), ...(claim ? [slug, snapshot.page.updated, snapshot.page.hash, slug] : [])),
  };
}

// Call only after base/editor schema initialization and input validation, before PUT/rename/move.
export async function captureEditorVersion(db, slug) {
  const snapshot = await snapshotPage(db, slug);
  if (!snapshot) return null;
  const { version, statement } = versionInsert(db, slug, snapshot);
  await statement.run();
  return version;
}

class EditorInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function objectBody(request, optional = false) {
  const text = await request.text();
  if (optional && !text.trim()) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new EditorInputError("Expected a JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EditorInputError("Expected a JSON object.");
  return value;
}

function fields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new EditorInputError("Unknown field.");
}

function textValue(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new EditorInputError("Invalid " + name + ".");
  return value.trim();
}

function settingsPatch(body) {
  fields(body, Object.keys(DEFAULT_SETTINGS));
  if (!Object.keys(body).length) throw new EditorInputError("Settings are empty.");
  if ("icon" in body && body.icon !== null && (typeof body.icon !== "string" || body.icon.length > 100)) throw new EditorInputError("Invalid icon.");
  if ("cover" in body && body.cover !== null && !/^g[1-6]$/.test(String(body.cover))) {
    if (typeof body.cover !== "string" || body.cover.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(body.cover)) throw new EditorInputError("Invalid cover URL.");
    let cover;
    try { cover = new URL(body.cover, "https://editor.invalid"); } catch { throw new EditorInputError("Invalid cover URL."); }
    if (!(body.cover.startsWith("https://") || /^\/(?!\/)/.test(body.cover)) || cover.protocol !== "https:" || cover.username || cover.password) throw new EditorInputError("Invalid cover URL.");
  }
  if ("width" in body && !["default", "normal", "full"].includes(body.width)) throw new EditorInputError("Invalid width.");
  // "report" = the research-report page style (the normal page look plus numbered equations and figures): a value of the
  // existing font column, so no schema change; an older build that does not know it draws the page without numbers.
  if ("font" in body && !PAGE_FONTS.includes(body.font)) throw new EditorInputError("Invalid font.");
  if ("favorite" in body && typeof body.favorite !== "boolean") throw new EditorInputError("Invalid favorite.");
  if ("ai" in body && !["edit", "lock", "ref", "smart"].includes(body.ai)) throw new EditorInputError("Invalid ai.");
  if ("small" in body && typeof body.small !== "boolean") throw new EditorInputError("Invalid small.");
  return body;
}

// Rows originate in this database, not in a request. Keep extension columns and opaque JSON.
function insertRow(db, table, row, guard) {
  const keys = Object.keys(row);
  const columns = keys.map((key) => '"' + key.replaceAll('"', '""') + '"').join(", ");
  const values = keys.map(() => "?").join(", ");
  return db.prepare(`INSERT INTO ${table} (${columns}) ` + (guard ? `SELECT ${values} WHERE ${guard.sql}` : `VALUES (${values})`))
    .bind(...keys.map((key) => row[key]), ...(guard ? guard.binds : []));
}

function settingsRow(slug, settings) {
  return { ...settings, page: slug, favorite: settings.favorite ? 1 : 0, ...("small" in settings ? { small: settings.small ? 1 : 0 } : {}) };
}

function replaceContent(db, slug, snapshot, guard) {
  const condition = guard ? " AND " + guard.sql : "";
  const binds = guard ? guard.binds : [];
  return [
    db.prepare("DELETE FROM blocks WHERE page = ?" + condition).bind(slug, ...binds),
    ...snapshot.blocks.map((block) => insertRow(db, "blocks", { ...block, page: slug }, guard)),
    db.prepare("DELETE FROM links WHERE src = ?" + condition).bind(slug, ...binds),
    ...snapshot.links.map((link) => insertRow(db, "links", { ...link, src: slug }, guard)),
    db.prepare("DELETE FROM editor_page_settings WHERE page = ?" + condition).bind(slug, ...binds),
    insertRow(db, "editor_page_settings", settingsRow(slug, snapshot.settings), guard),
  ];
}

function commentResult(row) {
  return { id: row.id, page: row.page, blockId: row.block_id, text: row.text, resolved: row.resolved === 1, created: row.created, updated: row.updated };
}

// Return null for another module's route. Authentication and base schema belong to the worker.
export async function handleEditorApi(request, db, url, helpers) {
  const match = /^\/api\/page\/([^/]+)\/(settings|comments|history|trash|restore|permanent|duplicate|from-template)(?:\/([^/]+)(\/restore)?)?\/?$/.exec(url.pathname);
  const globalRoute = /^\/api\/editor\/(trash|templates)\/?$/.exec(url.pathname);
  if (!match && !globalRoute) return null;
  const { json } = helpers;
  try {
    await ensureEditorSchema(db);
    const method = request.method.toUpperCase();
    if (globalRoute) {
      if (globalRoute[1] === "trash" && method === "GET") {
        const rows = await db.prepare("SELECT p.*, t.deleted AS deletedAt FROM editor_trash t JOIN pages p ON p.slug = t.page WHERE t.permanent = 0 ORDER BY t.deleted DESC, p.slug").all();
        return json({ pages: rows.results ?? [] });
      }
      if (globalRoute[1] === "templates" && method === "GET") {
        const rows = await db.prepare("SELECT id, name, created FROM editor_templates ORDER BY created DESC, id").all();
        return json({ templates: rows.results ?? [] });
      }
      if (globalRoute[1] === "templates" && method === "POST") {
        const body = await objectBody(request);
        fields(body, ["slug", "name"]);
        const slug = textValue(body.slug, "slug", 200);
        const name = textValue(body.name, "template name", 200);
        const snapshot = await snapshotPage(db, slug);
        if (!snapshot || (await readEditorPageMeta(db, slug)).trashed) return json({ error: "Page not found." }, 404);
        if (helpers.guardSyncedWrite) helpers.guardSyncedWrite(snapshot.blocks, slug, snapshot.blocks);
        const template = { id: crypto.randomUUID(), name, created: Date.now() };
        await db.prepare("INSERT INTO editor_templates (id, name, created, snapshot) VALUES (?, ?, ?, ?)").bind(template.id, name, template.created, JSON.stringify(snapshot)).run();
        return json({ template }, 201);
      }
      return json({ error: "Method not allowed." }, 405);
    }

    let slug, id;
    try { slug = decodeURIComponent(match[1]); id = match[3] ? decodeURIComponent(match[3]) : null; }
    catch { throw new EditorInputError("Invalid URL encoding."); }
    const action = match[2];
    const restoreVersion = Boolean(match[4]);
    if (id && !(action === "comments" && !restoreVersion || action === "history" && restoreVersion)) return json({ error: "Route not found." }, 404);
    const [page, meta] = await Promise.all([db.prepare("SELECT * FROM pages WHERE slug = ?").bind(slug).first(), readEditorPageMeta(db, slug)]);
    if (!page) return json({ error: "Page not found." }, 404);
    if (meta.trashed && !["restore", "permanent", "trash"].includes(action)) return json({ error: "Page is in trash." }, 404);

    if (action === "settings" && method === "GET") return json({ settings: meta.settings });
    if (action === "settings" && method === "PUT") {
      const patch = settingsPatch(await objectBody(request));
      const keys = Object.keys(patch);
      const { statement } = versionInsert(db, slug, await snapshotPage(db, slug));
      await db.batch([statement, db.prepare(`INSERT INTO editor_page_settings (page, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")}) ON CONFLICT(page) DO UPDATE SET ${keys.map(key => key + " = excluded." + key).join(", ")}`)
        .bind(slug, ...keys.map(key => key === "favorite" || key === "small" ? (patch[key] ? 1 : 0) : patch[key]))]);
      const { settings } = await readEditorPageMeta(db, slug);
      return json({ settings });
    }

    if (action === "comments") {
      if (!id && method === "GET") {
        const rows = await db.prepare("SELECT * FROM editor_comments WHERE page = ? ORDER BY created, id").bind(slug).all();
        return json({ comments: (rows.results ?? []).map(commentResult) });
      }
      if (!id && method === "POST") {
        const body = await objectBody(request);
        fields(body, ["text", "blockId"]);
        const text = textValue(body.text, "comment text", 20000);
        const blockId = body.blockId === undefined || body.blockId === null ? null : textValue(body.blockId, "block ID", 200);
        if (blockId && !await db.prepare("SELECT id FROM blocks WHERE page = ? AND id = ?").bind(slug, blockId).first()) return json({ error: "Block not found." }, 404);
        const now = Date.now();
        const comment = { id: crypto.randomUUID(), page: slug, block_id: blockId, text, resolved: 0, created: now, updated: now };
        await insertRow(db, "editor_comments", comment).run();
        return json({ comment: commentResult(comment) }, 201);
      }
      if (id && ["PATCH", "DELETE"].includes(method)) {
        const comment = await db.prepare("SELECT * FROM editor_comments WHERE id = ? AND page = ?").bind(id, slug).first();
        if (!comment) return json({ error: "Comment not found." }, 404);
        if (method === "DELETE") {
          await db.prepare("DELETE FROM editor_comments WHERE id = ? AND page = ?").bind(id, slug).run();
          return json({ ok: true });
        }
        const body = await objectBody(request);
        fields(body, ["text", "resolved"]);
        if (!Object.keys(body).length) throw new EditorInputError("Comment patch is empty.");
        if ("text" in body) comment.text = textValue(body.text, "comment text", 20000);
        if ("resolved" in body && typeof body.resolved !== "boolean") throw new EditorInputError("Invalid resolved value.");
        if ("resolved" in body) comment.resolved = body.resolved ? 1 : 0;
        comment.updated = Date.now();
        await db.prepare("UPDATE editor_comments SET text = ?, resolved = ?, updated = ? WHERE id = ? AND page = ?").bind(comment.text, comment.resolved, comment.updated, id, slug).run();
        return json({ comment: commentResult(comment) });
      }
    }

    if (action === "history" && !id && method === "GET") {
      const rows = await db.prepare("SELECT id, page, title, created FROM editor_history WHERE page = ? ORDER BY created DESC, rowid DESC").bind(slug).all();
      return json({ versions: rows.results ?? [] });
    }
    if ((action === "history" && id && restoreVersion || action === "from-template") && method === "POST") {
      let row;
      if (action === "history") row = await db.prepare("SELECT snapshot FROM editor_history WHERE id = ? AND page = ?").bind(id, slug).first();
      else {
        const body = await objectBody(request);
        fields(body, ["templateId"]);
        row = await db.prepare("SELECT snapshot FROM editor_templates WHERE id = ?").bind(textValue(body.templateId, "template ID", 200)).first();
      }
      if (!row) return json({ error: "Snapshot not found." }, 404);
      const snapshot = JSON.parse(row.snapshot);
      if (snapshot.syncedOperation) return json({ error: "synced_receipt_requires_versions" }, 400);
      const now = await snapshotPage(db, slug);
      if (helpers.guardSyncedWrite) helpers.guardSyncedWrite(snapshot.blocks, slug, now.blocks);
      // Untagged snapshots also predate synced operations. The legacy endpoint has no observed
      // versions, so it cannot safely restore either side of a page containing synced content.
      if ((action === "history" && snapshot.blocks.some(block => block.type === "synced")) || now.blocks.some(block => block.type === "synced")) {
        return json({ error: "synced_receipt_requires_versions" }, 400);
      }
      if (action === "from-template") snapshot.blocks = snapshot.blocks.map(block => block.type === "synced" ? { ...block, id: crypto.randomUUID() } : block);
      const { statement, version } = versionInsert(db, slug, now, true);
      const guard = { sql: "EXISTS (SELECT 1 FROM editor_history WHERE id = ?)", binds: [version.id] };
      const restored = { ...snapshot.page, updated: Math.max(Date.now(), now.page.updated + 1), source: "editor", hash: null };
      const keys = Object.keys(restored).filter((key) => !["slug", "parent", "ord"].includes(key));
      snapshot.settings = { ...meta.settings, ...snapshot.settings };
      const result = await db.batch([
        db.prepare("UPDATE pages SET updated = updated WHERE slug = ?").bind(slug),
        statement,
        db.prepare('UPDATE pages SET ' + keys.map((key) => '"' + key.replaceAll('"', '""') + '" = ?').join(", ") + " WHERE slug = ? AND " + guard.sql).bind(...keys.map((key) => restored[key]), slug, ...guard.binds),
        ...replaceContent(db, slug, snapshot, guard),
        // issue 107: the restored button actions count as saved by whoever restores them.
        ...(helpers.buttonSavers ? await helpers.buttonSavers(db, slug, snapshot.blocks, now.blocks, snapshot.page && snapshot.page.slug ? String(snapshot.page.slug) : slug, guard) : []),
      ]);
      if (!Number(result[1]?.meta?.changes)) return json({ error: "conflict" }, 409);
      return json({ ok: true, slug, versionId: version.id, settings: snapshot.settings });
    }

    if (action === "trash" && method === "POST") {
      if (slug === "index") return json({ error: "홈 페이지는 휴지통에 넣을 수 없어요." }, 400);
      if (!meta.trashed) {
        const { statement } = versionInsert(db, slug, await snapshotPage(db, slug));
        await db.batch([statement, db.prepare("INSERT INTO editor_trash (page, deleted, permanent) VALUES (?, ?, 0)").bind(slug, Date.now())]);
      }
      return json({ ok: true, slug });
    }
    if (action === "restore" && method === "POST") {
      if (meta.permanent) return json({ error: "Page was permanently deleted." }, 404);
      await db.batch([
        db.prepare("DELETE FROM editor_trash WHERE page = ? AND permanent = 0").bind(slug),
        db.prepare("UPDATE pages SET source = 'editor', hash = NULL, updated = ? WHERE slug = ?").bind(Date.now(), slug),
      ]);
      return json({ ok: true, slug });
    }
    if (action === "permanent" && method === "DELETE") {
      if (!meta.trashed) return json({ error: "Move the page to trash first." }, 409);
      const cleanup = helpers.permanentDeletePlan ? await helpers.permanentDeletePlan(db, slug) : { pages: [slug], statements: [] };
      await db.batch([
        ...cleanup.statements,
        ...cleanup.pages.flatMap((member) => [
          db.prepare("INSERT INTO editor_trash (page, deleted, permanent) VALUES (?, ?, 1) ON CONFLICT(page) DO UPDATE SET permanent = 1").bind(member, Date.now()),
          db.prepare("UPDATE pages SET parent = NULL WHERE parent = ?").bind(member),
          db.prepare("DELETE FROM blocks WHERE page = ?").bind(member),
          db.prepare("DELETE FROM links WHERE src = ? OR dst = ?").bind(member, member),
          db.prepare("DELETE FROM editor_page_settings WHERE page = ?").bind(member),
          db.prepare("DELETE FROM editor_comments WHERE page = ?").bind(member),
          db.prepare("DELETE FROM editor_history WHERE page = ?").bind(member),
          db.prepare("DELETE FROM pages WHERE slug = ?").bind(member),
        ]),
      ]);
      return json({ ok: true, slug });
    }
    if (action === "duplicate" && method === "POST") {
      const body = await objectBody(request, true);
      fields(body, ["title", "slug", "parent"]);
      const title = "title" in body ? textValue(body.title, "title", 200) : (page.title.slice(0, 193) + " (copy)");
      const base = helpers.slugify("slug" in body ? textValue(body.slug, "slug", 200) : title);
      let target = base;
      while (await db.prepare("SELECT slug FROM pages WHERE slug = ? UNION ALL SELECT page AS slug FROM editor_trash WHERE page = ? LIMIT 1").bind(target, target).first()) target = base + "-" + crypto.randomUUID().slice(0, 8);
      const parent = "parent" in body ? (body.parent === null ? null : textValue(body.parent, "parent", 200)) : page.parent;
      if (parent && (!await db.prepare("SELECT slug FROM pages WHERE slug = ?").bind(parent).first() || (await readEditorPageMeta(db, parent)).trashed)) throw new EditorInputError("Invalid parent.");
      const snapshot = await snapshotPage(db, slug);
      if (helpers.guardSyncedWrite) helpers.guardSyncedWrite(snapshot.blocks, target);
      snapshot.blocks = snapshot.blocks.map(block => block.type === "synced" ? { ...block, id: crypto.randomUUID() } : block);
      const max = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS ?").bind(parent).first();
      const copy = { ...snapshot.page, slug: target, title, parent, ord: Number(max.m) + 10, updated: Date.now(), source: "editor", hash: null };
      await db.batch([insertRow(db, "pages", copy), ...replaceContent(db, target, snapshot), ...(helpers.buttonSavers ? await helpers.buttonSavers(db, target, snapshot.blocks, [], slug) : [])]);
      return json({ slug: target, page: copy, settings: snapshot.settings }, 201);
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof EditorInputError) return json({ error: error.message }, error.status);
    throw error;
  }
}
