import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgD1 } from "../gate/pg-d1";
import { cookie, setup } from "./db-harness";
import { impAcardPlan } from "../import-acard";

const plain = (id: string, indent = 0) => ({ id, type: "paragraph", text: id, indent });
const synced = (id: string, source: any = null, indent = 0) => ({ id, type: "synced", text: "", indent, meta: { synced: { v: 1, source } } });
const sourceMd = '<!--acard synced {"v":1,"id":"root"}-->\n\nChild\n\n<!--acard /synced-->';
const referenceMd = '[Synced content](/source/#block-root)\n<!--acard {"synced":{"v":1,"source":{"page":"source","block":"root"}}}-->';
const strip = (sql: string) => sql.replace(/REVOKE[^;]*;/g, "").replace(/GRANT[^;]*;/g, "").replace(/DROP POLICY[^;]*;/g, "").replace(/CREATE POLICY[^;]*;/g, "");

test("Acard archive plans preserve raw synced identity for server validation", async () => {
  const files = {
    "acard-export.json": JSON.stringify({ format: "acard-export", version: 1, pages: [{ slug: "source", file: "source.md" }, { slug: "reference", file: "reference.md" }] }),
    "source.md": sourceMd,
    "reference.md": referenceMd,
  };
  const plan = await impAcardPlan(Object.entries(files).map(([path, text]) => ({ path, size: text.length, read: async () => new TextEncoder().encode(text) })), { name: "synced" });
  expect(plan.pages[0].blocks[0]).toMatchObject(synced("root"));
  expect(plan.pages[0].blocks[1]).toMatchObject({ type: "paragraph", text: "Child", indent: 1 });
  expect(plan.pages[1].blocks).toHaveLength(1);
  expect(plan.pages[1].blocks[0]).toMatchObject({ type: "synced", meta: { synced: { v: 1, source: { page: "source", block: "root" } } } });
});

for (const backend of ["sqlite", "postgres"] as const) describe("synced lifecycle (" + backend + ")", () => {
  let h: ReturnType<typeof setup>, db: any, lite: PGlite;
  beforeAll(async () => {
    if (backend !== "postgres") return;
    lite = new PGlite();
    for (const file of ["001-acard-schema.sql", "004-acard-agent.sql", "006-acard-folders.sql", "019-acard-page-view.sql", "032-acard-db-button-savers.sql", "034-acard-imports.sql", "037-acard-ai-marks.sql"]) {
      await lite.exec(strip(readFileSync(join(import.meta.dir, "../migrations/supabase", file), "utf8")));
    }
    await lite.exec(strip(readFileSync(join(import.meta.dir, "../migrations/supabase/002-acard-search.sql"), "utf8")).replace(/CREATE EXTENSION[^;]*;/, "").replace(/CREATE INDEX IF NOT EXISTS page_fts_trgm[^;]*;/, ""));
    await lite.exec("SET search_path = acard");
  });
  afterAll(async () => { if (lite) await lite.close(); });
  beforeEach(async () => {
    h = setup();
    if (lite) {
      await lite.exec("TRUNCATE pages, blocks, links, editor_history, editor_templates, editor_trash, editor_page_settings, db_button_savers, page_fts, page_fts_ko, page_fts_dirty");
      const query = (q: { query: PGlite["query"] }) => async (sql: string, params: unknown[]) => {
        const result = await q.query<Record<string, unknown>>(sql, params);
        return { rows: result.rows, count: result.affectedRows ?? result.rows.length };
      };
      h.env.DB = pgD1({ query: query(lite), transaction: fn => lite.transaction(tx => fn(query(tx))) });
    }
    db = h.env.DB;
    for (const slug of ["source", "destination"]) {
      expect((await h.call("POST", "/api/pages", { slug, title: slug })).status).toBe(200);
      expect((await h.call("PUT", "/api/page/" + slug, { blocks: [plain("a")] })).status).toBe(200);
    }
  });
  afterEach(() => h.sqlite.close());
  const rows = async (sql: string, ...values: any[]) => (await db.prepare(sql).bind(...values).all()).results;
  const version = async (slug: string) => (await db.prepare("SELECT updated FROM pages WHERE slug = ?").bind(slug).first()).updated;
  const state = async () => ({ pages: await rows("SELECT * FROM pages ORDER BY slug"), blocks: await rows("SELECT * FROM blocks ORDER BY page, ord"), history: await rows("SELECT * FROM editor_history ORDER BY id"), templates: await rows("SELECT * FROM editor_templates ORDER BY id") });
  const snapshot = async (slug: string) => ({ page: (await rows("SELECT * FROM pages WHERE slug = ?", slug))[0], blocks: await rows("SELECT * FROM blocks WHERE page = ? ORDER BY ord", slug), links: [], settings: {} });
  async function history(id: string, slug: string, value: any) {
    await db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) VALUES (?, ?, ?, ?, ?)").bind(id, slug, slug, Date.now(), JSON.stringify(value)).run();
  }
  async function canonical() {
    const result = await h.call("POST", "/api/page/source/synced", { ids: ["a"], base_updated: await version("source") });
    expect(result.status).toBe(200);
    return result.data.block.id;
  }
  async function markdown(text: string) {
    const form = new FormData();
    form.append("file", new File(['---\nacard_meta: 1\n---\n\n' + text], "imported.md"));
    const response = await h.worker.fetch(new Request("https://notes.test/api/import/md", { method: "POST", headers: { cookie: await cookie() }, body: form }), h.env);
    return { status: response.status, data: await response.json() as any };
  }
  async function batch(blocks: any[], extraMap: any = {}) {
    const made = await h.call("POST", "/api/import/batches", { format: "acard", name: "test", sources: [{ key: "copy", source: crypto.randomUUID(), title: "Imported", kind: "page" }] });
    expect(made.status).toBe(200);
    const slug = made.data.map.copy.slug;
    const result = await h.call("POST", "/api/import/batches/" + made.data.id + "/chunk", { map: { ...made.data.map, ...extraMap }, pages: [{ key: "copy", title: "Imported", blocks }] });
    return { ...result, slug };
  }

  test("single Markdown import deactivates external references instead of binding an existing page", async () => {
    await canonical();
    const imported = await markdown(referenceMd);
    expect(imported.status).toBe(200);
    const blocks = await rows("SELECT type, text, meta FROM blocks WHERE page = ?", imported.data.pages[0].slug);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].text.length).toBeGreaterThan(0);
    expect(blocks[0].meta).toBeNull();
  });

  test("batch imports deactivate references even when a supplied map points at an existing page", async () => {
    const root = await canonical(), before = await snapshot("source");
    const imported = await batch([synced("ref", { page: "source", block: root })], { source: { slug: "source" } });
    expect(imported.status).toBe(200);
    expect(await rows("SELECT type, meta FROM blocks WHERE page = ?", imported.slug)).toEqual([{ type: "paragraph", meta: null }]);
    expect(await snapshot("source")).toEqual(before);
  });

  const malformed = [
    [synced("root", null, 7)],
    [synced("root"), plain("child", 7)],
    [synced("root"), synced("nested", null, 1)],
    [synced("ref", { page: "source", block: "a" }), plain("child", 1)],
    [synced("root"), { ...plain("hidden", 1), meta: { synced: { v: 1, source: null } } }],
    [synced("x".repeat(61))],
    [synced("root"), ...Array.from({ length: 2000 }, (_, i) => plain("b" + i))],
    [{ ...synced("root"), text: "<script>discarded</script>" }],
  ];
  for (const [index, blocks] of malformed.entries()) test("batch rejects raw malformed synced structure " + index + " without writes", async () => {
    const before = await state();
    expect((await batch(blocks)).status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("single Markdown import validates overflow before normalization can truncate it", async () => {
    const before = await state();
    const result = await markdown(sourceMd + "\n\n" + Array.from({ length: 2000 }, (_, i) => "paragraph " + i).join("\n\n"));
    expect(result.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("single Markdown import validates depth before normalization can clamp it", async () => {
    const before = await state();
    expect((await markdown(sourceMd.replace("Child", "            - Child"))).status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("legacy history cannot erase a live canonical wrapper using an ordinary snapshot", async () => {
    await history("old", "source", await snapshot("source"));
    await canonical();
    const before = await state();
    expect((await h.call("POST", "/api/page/source/history/old/restore", {})).status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("legacy history cannot overwrite source edits from an untagged snapshot", async () => {
    const root = await canonical();
    await history("old", "source", await snapshot("source"));
    expect((await h.call("PATCH", "/api/page/source/synced/" + root, { base_updated: await version("source"), source_updated: await version("source"), blocks: [{ ...plain("a"), text: "new" }] })).status).toBe(200);
    const before = await state();
    expect((await h.call("POST", "/api/page/source/history/old/restore", {})).status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("legacy restore loses a racing synced creation without content or history writes", async () => {
    await history("old", "source", await snapshot("source"));
    let raced: Awaited<ReturnType<typeof state>> | undefined;
    const statement = (sql: string, params: any[] = []): any => {
      const inner = db.prepare(sql).bind(...params);
      return { sql, inner, bind: (...values: any[]) => statement(sql, values), run: () => inner.run(), first: () => inner.first(), all: () => inner.all() };
    };
    h.env.DB = { dialect: db.dialect, prepare: statement, batch: async (items: any[]) => {
      if (!raced && items.some(item => item.sql.startsWith("INSERT INTO editor_history"))) {
        h.env.DB = db;
        await canonical();
        raced = await state();
      }
      return db.batch(items.map(item => item.inner));
    } };
    expect((await h.call("POST", "/api/page/source/history/old/restore", {})).status).toBe(409);
    expect(raced).toBeDefined();
    expect(await state()).toEqual(raced!);
  });

  test("duplicate and template application allocate fresh canonical wrapper identities", async () => {
    const root = await canonical();
    const duplicate = await h.call("POST", "/api/page/source/duplicate", { slug: "copy" });
    expect(duplicate).toMatchObject({ status: 201 });
    expect((await rows("SELECT id FROM blocks WHERE page = ? AND type = 'synced'", duplicate.data.slug))[0].id).not.toBe(root);
    const template = await h.call("POST", "/api/editor/templates", { slug: "source", name: "Source" });
    expect(template.status).toBe(201);
    expect((await h.call("POST", "/api/page/destination/from-template", { templateId: template.data.template.id })).status).toBe(200);
    expect((await rows("SELECT id FROM blocks WHERE page = ? AND type = 'synced'", "destination"))[0].id).not.toBe(root);
  });

  test("template creation rejects malformed persisted synced structure", async () => {
    await canonical();
    await db.prepare("UPDATE blocks SET indent = 7 WHERE page = ? AND id = ?").bind("source", "a").run();
    const before = await state();
    expect((await h.call("POST", "/api/editor/templates", { slug: "source", name: "Broken" })).status).toBe(400);
    expect(await state()).toEqual(before);
  });
});
