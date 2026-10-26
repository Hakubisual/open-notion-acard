import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { captureEditorVersion, ensureEditorSchema, handleEditorApi, readEditorPageMeta } from "../editor-pages.js";
import { pgD1 } from "../gate/pg-d1";

// Execute real SQL, including D1's transactional batch semantics.
function d1(sqlite) {
  return {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { return { ...this, args }; },
        async first() { return sqlite.query(sql).get(...this.args); },
        async all() { return { results: sqlite.query(sql).all(...this.args) }; },
        execute() { const result = sqlite.query(sql).run(...this.args); return { success: true, meta: { changes: result.changes } }; },
        async run() { return this.execute(); },
      };
    },
    async batch(statements) { return sqlite.transaction(() => statements.map((statement) => statement.execute()))(); },
  };
}

const helpers = {
  json: (body, status = 200) => Response.json(body, { status }),
  slugify: (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page",
};

let sqlite, db;

async function api(path, method = "GET", body) {
  const url = new URL("https://notes.test/api/" + path);
  const request = new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  const response = await handleEditorApi(request, db, url, helpers);
  return response ? { status: response.status, body: await response.json() } : null;
}

function page(slug = "alpha", title = "Alpha") {
  sqlite.query("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash, extra) VALUES (?, ?, NULL, 10, 'note', 1, 'markdown', 'seed-hash', ?)").run(slug, title, JSON.stringify({ custom: [1, 2] }));
  sqlite.query("INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta, extra) VALUES (?, 'b1', 0, 'database', '[[target]]', 1, 2, ?, 'block-extension')").run(slug, JSON.stringify({ rows: [{ status: "open" }], unknown: { nested: true }, richText: [{ bold: true }] }));
  sqlite.query("INSERT INTO links (src, dst, extra) VALUES (?, 'target', 'link-extension')").run(slug);
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, parent TEXT, ord INTEGER NOT NULL, kind TEXT NOT NULL, updated INTEGER NOT NULL, source TEXT NOT NULL, hash TEXT, extra TEXT); CREATE TABLE blocks (page TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, checked INTEGER NOT NULL, indent INTEGER NOT NULL, meta TEXT, extra TEXT, PRIMARY KEY(page, id)); CREATE TABLE links (src TEXT NOT NULL, dst TEXT NOT NULL, extra TEXT, PRIMARY KEY(src, dst)); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  db = d1(sqlite);
  await ensureEditorSchema(db);
  page();
  page("beta", "Beta");
});

afterEach(() => sqlite.close());

describe("editor page lifecycle", () => {
  test("migration and runtime initialization are idempotent across database bindings", async () => {
    sqlite.exec(readFileSync(new URL("../migrations/notion-editor.sql", import.meta.url), "utf8"));
    await ensureEditorSchema(db);
    const other = new Database(":memory:");
    try {
      await ensureEditorSchema(d1(other));
      expect(other.query("SELECT COUNT(*) AS n FROM editor_trash").get().n).toBe(0);
    } finally { other.close(); }
    expect(sqlite.query("SELECT COUNT(*) AS n FROM pages").get().n).toBe(2);
    expect(await api("tree")).toBeNull();
  });

  test("settings default, partial update, and pre-mutation snapshot preserve extension metadata", async () => {
    sqlite.exec("ALTER TABLE editor_page_settings ADD COLUMN extra TEXT");
    expect((await api("page/alpha/settings")).body.settings).toEqual({ icon: null, cover: null, width: "default", font: "default", favorite: false, ai: "edit", small: false });
    const result = await api("page/alpha/settings", "PUT", { icon: "star", cover: "https://images.test/cover.png", width: "full", font: "serif", favorite: true });
    expect(result.status).toBe(200);
    sqlite.query("UPDATE editor_page_settings SET extra = 'settings-extension' WHERE page = 'alpha'").run();
    await api("page/alpha/settings", "PUT", { font: "mono" });
    const settings = (await api("page/alpha/settings")).body.settings;
    expect(settings).toMatchObject({ icon: "star", width: "full", font: "mono", favorite: true, extra: "settings-extension" });
    const history = (await api("page/alpha/history")).body.versions;
    expect(history).toHaveLength(2);
    const snapshot = JSON.parse(sqlite.query("SELECT snapshot FROM editor_history WHERE id = ?").get(history[0].id).snapshot);
    expect(snapshot.settings.font).toBe("serif");
    expect(snapshot.blocks[0].extra).toBe("block-extension");
    expect(snapshot.links[0].extra).toBe("link-extension");
  });

  test.each([
    ["SQLite", false], ["SQLite", true], ["Postgres", false], ["Postgres", true],
  ])("concurrent settings patches preserve both fields and return fresh rows on %s (existing: %s)", async (dialect, existing) => {
    const lite = dialect === "Postgres" ? new PGlite() : null;
    try {
      if (lite) {
        await lite.exec(readFileSync(new URL("../migrations/supabase/001-acard-schema.sql", import.meta.url), "utf8").replace(/REVOKE[^;]*;/g, ""));
        const query = (connection) => async (sql, params) => {
          const result = await connection.query(sql, params);
          return { rows: result.rows, count: result.affectedRows ?? result.rows.length };
        };
        db = pgD1({ query: query(lite), transaction: (fn) => lite.transaction((tx) => fn(query(tx))) });
        await db.prepare("INSERT INTO pages (slug, title, updated) VALUES ('alpha', 'Alpha', 1)").run();
      }
      if (existing) await api("page/alpha/settings", "PUT", { cover: "g2", favorite: true });
      const before = (await api("page/alpha/settings")).body.settings;
      const batch = db.batch.bind(db);
      let arrived = 0, finished = 0;
      const ready = Promise.withResolvers();
      const written = Promise.withResolvers();
      db.batch = async (statements) => {
        // Hold both writes until both requests have captured their old settings, then
        // finish both transactions before either response reads the current row.
        if (statements[0]?.sql.startsWith("CREATE")) return batch(statements);
        if (++arrived === 2) ready.resolve();
        await ready.promise;
        const result = await batch(statements);
        if (++finished === 2) written.resolve();
        await written.promise;
        return result;
      };
      const results = await Promise.all([
        api("page/alpha/settings", "PUT", { icon: "star" }),
        api("page/alpha/settings", "PUT", { width: "full" }),
      ]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
      const expected = { ...before, icon: "star", width: "full" };
      expect((await api("page/alpha/settings")).body.settings).toEqual(expected);
      expect(results.map((result) => result.body.settings)).toEqual([expected, expected]);
      const history = await db.prepare("SELECT snapshot FROM editor_history WHERE page = 'alpha'").all();
      expect(history.results.map((row) => JSON.parse(row.snapshot).settings).filter((settings) => JSON.stringify(settings) === JSON.stringify(before))).toHaveLength(2);
    } finally { await lite?.close(); }
  }, 20000);

  test.each([
    { cover: "javascript:alert(1)" }, { cover: "data:image/svg+xml,hi" }, { cover: "//evil.test/a" },
    { cover: "/\\evil.test/a" }, { cover: "http://images.test/a" }, { cover: "https://u:p@images.test/a" },
    { cover: "https://images.test/a\n" }, { cover: "" }, { cover: 2 }, { font: "comic" },
    { width: "wide" }, { favorite: "true" }, { icon: {} }, { other: true }, {}, [], null,
  ])("rejects malformed settings without writing history: %j", async (body) => {
    expect((await api("page/alpha/settings", "PUT", body)).status).toBe(400);
    expect((await api("page/alpha/history")).body.versions).toHaveLength(0);
  });

  test("root-relative covers and null clearing work; malformed JSON is rejected", async () => {
    expect((await api("page/alpha/settings", "PUT", { cover: "/assets/cover.png" })).status).toBe(200);
    expect((await api("page/alpha/settings", "PUT", { cover: null })).body.settings.cover).toBeNull();
    const url = new URL("https://notes.test/api/page/alpha/settings");
    const response = await handleEditorApi(new Request(url, { method: "PUT", body: "{" }), db, url, helpers);
    expect(response.status).toBe(400);
    expect((await api("page/%ZZ/settings")).status).toBe(400);
    expect((await api("page/missing/settings")).status).toBe(404);
    expect((await api("page/alpha/settings", "POST", {})).status).toBe(405);
  });

  test("page and block comments support resolve/edit/delete with strict ownership", async () => {
    const first = await api("page/alpha/comments", "POST", { text: "Page comment" });
    const second = await api("page/alpha/comments", "POST", { text: "Block comment", blockId: "b1" });
    expect(first.status).toBe(201);
    expect(first.body.comment.blockId).toBeNull();
    expect(second.body.comment.blockId).toBe("b1");
    const id = second.body.comment.id;
    expect((await api(`page/beta/comments/${id}`, "PATCH", { resolved: true })).status).toBe(404);
    expect((await api(`page/beta/comments/${id}`, "DELETE")).status).toBe(404);
    expect((await api(`page/alpha/comments/${id}`, "PATCH", { text: "Changed", resolved: true })).body.comment).toMatchObject({ text: "Changed", resolved: true });
    expect((await api("page/alpha/comments")).body.comments).toHaveLength(2);
    expect((await api("page/alpha/comments", "POST", { text: "No block", blockId: "missing" })).status).toBe(404);
    expect((await api("page/alpha/comments", "POST", { text: " " })).status).toBe(400);
    expect((await api(`page/alpha/comments/${id}`, "PATCH", { resolved: 1 })).status).toBe(400);
    expect((await api(`page/alpha/comments/${id}`, "PATCH", {})).status).toBe(400);
    expect((await api(`page/alpha/comments/${id}`, "DELETE")).body.ok).toBe(true);
    expect((await api("page/alpha/comments")).body.comments).toHaveLength(1);
  });

  test("restore is page-owned, reversible, and preserves all stored content plus incoming links", async () => {
    await api("page/alpha/settings", "PUT", { icon: "old", favorite: true });
    const original = await captureEditorVersion(db, "alpha");
    const block = sqlite.query("SELECT * FROM blocks WHERE page = 'alpha'").get();
    const comment = (await api("page/alpha/comments", "POST", { text: "Keep discussion", blockId: "b1" })).body.comment;
    sqlite.exec("UPDATE pages SET title = 'Changed', parent = 'beta', ord = 99, extra = 'changed' WHERE slug = 'alpha'; UPDATE blocks SET text = 'Changed', meta = '{}', extra = 'changed' WHERE page = 'alpha'; DELETE FROM links WHERE src = 'alpha'; INSERT INTO links (src, dst) VALUES ('beta', 'alpha');");
    await api("page/alpha/settings", "PUT", { icon: "new" });
    expect((await api(`page/beta/history/${original.id}/restore`, "POST")).status).toBe(404);
    const result = await api(`page/alpha/history/${original.id}/restore`, "POST");
    expect(result.status).toBe(200);
    expect(sqlite.query("SELECT * FROM blocks WHERE page = 'alpha'").get()).toEqual(block);
    expect(sqlite.query("SELECT * FROM pages WHERE slug = 'alpha'").get()).toMatchObject({ title: "Alpha", parent: "beta", ord: 99, source: "editor", hash: null, extra: JSON.stringify({ custom: [1, 2] }) });
    expect((await api("page/alpha/settings")).body.settings.icon).toBe("old");
    expect(sqlite.query("SELECT * FROM links WHERE src = 'alpha'").get().extra).toBe("link-extension");
    expect(sqlite.query("SELECT dst FROM links WHERE src = 'beta' AND dst = 'alpha'").get()).toBeTruthy();
    expect((await api("page/alpha/comments")).body.comments[0].id).toBe(comment.id);
    const undo = JSON.parse(sqlite.query("SELECT snapshot FROM editor_history WHERE id = ?").get(result.body.versionId).snapshot);
    expect(undo.page.title).toBe("Changed");
    expect(undo.blocks[0].text).toBe("Changed");
    expect(await captureEditorVersion(db, "missing")).toBeNull();
  });

  test("trash and restore retain rows; permanent deletion retains a seed-sync tombstone", async () => {
    await api("page/alpha/settings", "PUT", { favorite: true });
    await api("page/alpha/comments", "POST", { text: "Keep until permanent" });
    sqlite.exec("UPDATE pages SET parent = 'alpha' WHERE slug = 'beta'");
    expect((await api("page/alpha/permanent", "DELETE")).status).toBe(409);
    expect((await api("page/alpha/trash", "POST")).status).toBe(200);
    const count = (await db.prepare("SELECT COUNT(*) AS n FROM editor_history WHERE page = ?").bind("alpha").first()).n;
    await api("page/alpha/trash", "POST");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM editor_history WHERE page = ?").bind("alpha").first()).n).toBe(count);
    expect((await api("editor/trash")).body.pages.map((p) => p.slug)).toEqual(["alpha"]);
    expect((await readEditorPageMeta(db, "alpha")).trashed).toBe(true);
    expect((await api("page/alpha/settings")).status).toBe(404);
    expect(sqlite.query("SELECT id FROM blocks WHERE page = 'alpha'").get()).toBeTruthy();
    expect((await api("page/alpha/restore", "POST")).status).toBe(200);
    expect((await readEditorPageMeta(db, "alpha")).trashed).toBe(false);
    expect(sqlite.query("SELECT source, hash FROM pages WHERE slug = 'alpha'").get()).toEqual({ source: "editor", hash: null });
    await api("page/alpha/trash", "POST");
    expect((await api("page/alpha/permanent", "DELETE")).status).toBe(200);
    for (const table of ["blocks", "editor_page_settings", "editor_comments", "editor_history"]) expect(sqlite.query(`SELECT COUNT(*) AS n FROM ${table} WHERE page = 'alpha'`).get().n).toBe(0);
    expect(sqlite.query("SELECT * FROM pages WHERE slug = 'alpha'").get()).toBeNull();
    expect(sqlite.query("SELECT parent FROM pages WHERE slug = 'beta'").get().parent).toBeNull();
    expect(sqlite.query("SELECT permanent FROM editor_trash WHERE page = 'alpha'").get().permanent).toBe(1);
    expect((await api("editor/trash")).body.pages).toHaveLength(0);
    expect((await api("page/alpha/restore", "POST")).status).toBe(404);
  });

  test("duplicate preserves opaque page/block/link/settings data but not discussion or history", async () => {
    await api("page/alpha/settings", "PUT", { cover: "/cover.png", width: "full", favorite: true });
    await api("page/alpha/comments", "POST", { text: "Source only" });
    sqlite.exec("INSERT INTO editor_trash (page, deleted, permanent) VALUES ('reserved', 1, 1)");
    const result = await api("page/alpha/duplicate", "POST", { title: "Copy", slug: "reserved", parent: "beta" });
    expect(result.status).toBe(201);
    const slug = result.body.slug;
    expect(slug).not.toBe("reserved");
    expect(result.body.page).toMatchObject({ title: "Copy", parent: "beta", source: "editor", hash: null, extra: JSON.stringify({ custom: [1, 2] }) });
    const original = sqlite.query("SELECT * FROM blocks WHERE page = 'alpha'").get();
    expect(sqlite.query("SELECT * FROM blocks WHERE page = ?").get(slug)).toEqual({ ...original, page: slug });
    expect(sqlite.query("SELECT extra FROM links WHERE src = ?").get(slug).extra).toBe("link-extension");
    expect((await api(`page/${slug}/settings`)).body.settings).toMatchObject({ cover: "/cover.png", favorite: true });
    expect((await api(`page/${slug}/comments`)).body.comments).toEqual([]);
    expect((await api(`page/${slug}/history`)).body.versions).toEqual([]);
    expect((await api("page/alpha/duplicate", "POST", { parent: "missing" })).status).toBe(400);
    expect((await api("page/alpha/duplicate", "POST", { title: false })).status).toBe(400);
    expect((await api("page/alpha/duplicate", "POST")).status).toBe(201);
  });

  test("templates are independent snapshots, preserve opaque data, and snapshot their target before applying", async () => {
    await api("page/alpha/settings", "PUT", { font: "mono" });
    const saved = await api("editor/templates", "POST", { slug: "alpha", name: "Project" });
    expect(saved.status).toBe(201);
    const templateId = saved.body.template.id;
    expect((await api("editor/templates")).body.templates).toHaveLength(1);
    const original = sqlite.query("SELECT * FROM blocks WHERE page = 'alpha'").get();
    await api("page/alpha/trash", "POST");
    expect((await api("editor/templates", "POST", { slug: "alpha", name: "Gone" })).status).toBe(404);
    await api("page/alpha/permanent", "DELETE");
    sqlite.exec("UPDATE pages SET extra = 'target-extra', ord = 77 WHERE slug = 'beta'");
    const applied = await api("page/beta/from-template", "POST", { templateId });
    expect(applied.status).toBe(200);
    expect(sqlite.query("SELECT * FROM blocks WHERE page = 'beta'").get()).toEqual({ ...original, page: "beta" });
    expect(sqlite.query("SELECT title, ord, extra FROM pages WHERE slug = 'beta'").get()).toEqual({ title: "Alpha", ord: 77, extra: JSON.stringify({ custom: [1, 2] }) });
    expect((await api("page/beta/settings")).body.settings.font).toBe("mono");
    const before = JSON.parse(sqlite.query("SELECT snapshot FROM editor_history WHERE id = ?").get(applied.body.versionId).snapshot);
    expect(before.page.title).toBe("Beta");
    expect(before.page.extra).toBe("target-extra");
    expect((await api("page/beta/from-template", "POST", { templateId: "missing" })).status).toBe(404);
    expect((await api("page/beta/from-template", "POST", {})).status).toBe(400);
    expect((await api("editor/templates", "POST", { slug: "beta", name: " " })).status).toBe(400);
  });

  test("failed batch mutations roll back their version and existing data", async () => {
    sqlite.exec("CREATE TRIGGER reject_settings BEFORE INSERT ON editor_page_settings BEGIN SELECT RAISE(ABORT, 'test constraint'); END");
    await expect(api("page/alpha/settings", "PUT", { icon: "new" })).rejects.toThrow("test constraint");
    expect((await api("page/alpha/history")).body.versions).toHaveLength(0);
    expect((await api("page/alpha/settings")).body.settings.icon).toBeNull();
  });
});
