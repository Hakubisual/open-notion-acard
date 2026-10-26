import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgD1 } from "../gate/pg-d1";
import { newSink, trackDb } from "../gate/live";
import { setup } from "./db-harness";

const block = (id: string, indent = 0, text = id) => ({ id, type: "paragraph", text, checked: false, indent });
const ROOT = join(import.meta.dir, "..");
const strip = (sql: string) => sql.replace(/REVOKE[^;]*;/g, "").replace(/GRANT[^;]*;/g, "").replace(/DROP POLICY[^;]*;/g, "").replace(/CREATE POLICY[^;]*;/g, "");

for (const backend of ["sqlite", "postgres"] as const) describe("block move (" + backend + ")", () => {
  let lite: PGlite, h: ReturnType<typeof setup>, db: any;
  let beforeMoveBatch: (() => Promise<void>) | undefined, moveBatches: number;
  beforeAll(async () => {
    if (backend !== "postgres") return;
    lite = new PGlite();
    for (const file of ["001-acard-schema.sql", "004-acard-agent.sql", "006-acard-folders.sql", "019-acard-page-view.sql", "032-acard-db-button-savers.sql"]) {
      await lite.exec(strip(readFileSync(join(ROOT, "migrations/supabase", file), "utf8")));
    }
    await lite.exec(strip(readFileSync(join(ROOT, "migrations/supabase/002-acard-search.sql"), "utf8")).replace(/CREATE EXTENSION[^;]*;/, "").replace(/CREATE INDEX IF NOT EXISTS page_fts_trgm[^;]*;/, ""));
    await lite.exec("SET search_path = acard");
  });
  afterAll(async () => { if (lite) await lite.close(); });
  beforeEach(async () => {
    h = setup();
    if (backend === "postgres") {
      await lite.exec("TRUNCATE pages, blocks, links, editor_history, editor_trash, editor_page_settings, db_button_savers, page_fts, page_fts_ko, page_fts_dirty, share_rules, share_sessions");
      const query = (q: { query: PGlite["query"] }) => async (sql: string, params: unknown[]) => {
        const result = await q.query<Record<string, unknown>>(sql, params);
        return { rows: result.rows, count: result.affectedRows ?? result.rows.length };
      };
      h.env.DB = pgD1({ query: query(lite), transaction: fn => lite.transaction(tx => fn(query(tx))) });
    }
    db = h.env.DB;
    for (const slug of ["source", "target"]) expect((await h.call("POST", "/api/pages", { slug, title: slug })).status).toBe(200);
    await put("source", [block("a", 0, "[[keep]]"), block("child", 1, "quasar [[moved]]"), block("grand", 2), block("middle", 0, "[[keep]]"), block("z")]);
    await put("target", [block("dest", 0, "[[existing]]")]);
    beforeMoveBatch = undefined; moveBatches = 0;
    // Wrap real statements without replacing transaction semantics; the event runs exactly before the move batch.
    const statement = (sql: string, values: unknown[] = []): any => {
      const inner = db.prepare(sql).bind(...values);
      return { sql, params: values, bind: (...params: unknown[]) => statement(sql, params),
        run: () => inner.run(), all: () => inner.all(), first: () => inner.first(), inner };
    };
    h.env.DB = { dialect: db.dialect, prepare: statement, batch: async (items: any[]) => {
      if (items.some(item => item.sql.startsWith("INSERT INTO editor_history") && item.params.some((value: unknown) => typeof value === "string" && value.includes('"blockMove"')))) {
        moveBatches++;
        const event = beforeMoveBatch; beforeMoveBatch = undefined; await event?.();
      }
      return db.batch(items.map(item => item.inner));
    } };
  });
  afterEach(() => h.sqlite.close());
  async function put(slug: string, blocks: any[]) {
    const result = await h.call("PUT", "/api/page/" + slug, { blocks });
    expect(result.status).toBe(200);
  }
  async function page(slug: string) { return (await h.call("GET", "/api/page/" + slug)).data; }
  async function rows(sql: string, ...params: unknown[]) { return (await db.prepare(sql).bind(...params).all()).results; }
  async function state() {
    return { pages: await rows("SELECT * FROM pages ORDER BY slug"), blocks: await rows("SELECT * FROM blocks ORDER BY page, ord"),
      links: await rows("SELECT * FROM links ORDER BY src, dst"), history: await rows("SELECT * FROM editor_history ORDER BY id"),
      buttons: await rows("SELECT * FROM db_button_savers ORDER BY button") };
  }
  async function payload(extra: any = {}) {
    return { target: "target", ids: ["a"], source_updated: (await page("source")).page.updated, target_updated: (await page("target")).page.updated, ...extra };
  }
  async function move(extra: any = {}) { return h.call("POST", "/api/page/source/move-blocks", await payload(extra)); }

  test("hierarchy, opaque metadata, backlinks, histories, search and live signals commit together", async () => {
    const rawMeta = '{ "opaque": {"nested": [1,"x"]}, "richText": [{"text":"quasar","mention":{"type":"page","slug":"rich"}}] }';
    await db.prepare("UPDATE blocks SET meta = ?, checked = 1 WHERE page = ? AND id = ?").bind(rawMeta, "source", "child").run();
    const sink = newSink("test"); h.env.DB = trackDb(h.env.DB, sink);
    const before = await state(), response = await move({ ids: ["child", "a"], beforeId: "dest" });
    expect(response.status).toBe(200); expect(moveBatches).toBe(1);
    expect((await page("source")).blocks.map((b: any) => b.id)).toEqual(["middle", "z"]);
    expect((await page("target")).blocks.map((b: any) => [b.id, b.indent])).toEqual([["a", 0], ["child", 1], ["grand", 2], ["dest", 0]]);
    expect(await rows("SELECT meta, checked, text FROM blocks WHERE page = ? AND id = ?", "target", "child")).toEqual([{ meta: rawMeta, checked: 1, text: "quasar [[moved]]" }]);
    expect(await rows("SELECT dst FROM links WHERE src = ? ORDER BY dst", "source")).toEqual([{ dst: "keep" }]);
    expect(await rows("SELECT dst FROM links WHERE src = ? ORDER BY dst", "target")).toEqual(["existing", "keep", "moved", "rich"].map(dst => ({ dst })));
    expect((await state()).history.length).toBe(before.history.length + 2);
    expect((await rows("SELECT body FROM page_fts WHERE slug = ?", "source"))[0].body).not.toContain("quasar");
    expect((await rows("SELECT body FROM page_fts WHERE slug = ?", "target"))[0].body).toContain("quasar");
    expect([...sink.slugs]).toContain("source"); expect([...sink.slugs]).toContain("target");
    expect([...sink.kinds]).toContain("page"); expect([...sink.kinds]).toContain("tree");
    expect(response.data.receipt.ids).toEqual(["a", "child", "grand"]);
    expect(response.data.receipt.roots).toEqual([{ id: "a", ord: 0, indent: 0, beforeId: "middle" }]);
    expect(response.data.receipt.placement).toEqual([{ id: "a", ord: 0, indent: 0 }, { id: "child", ord: 1, indent: 1 }, { id: "grand", ord: 2, indent: 2 }]);
  });

  test("inverse receipt restores discontiguous subtrees, depth, original order and text", async () => {
    const before = await state();
    const first = await move({ ids: ["child", "z"] });
    expect(first.status).toBe(200);
    expect((await page("target")).blocks.map((b: any) => [b.id, b.indent])).toEqual([["dest", 0], ["child", 0], ["grand", 1], ["z", 0]]);
    const inverse = first.data.receipt.inverse;
    const undone = await h.call("POST", inverse.path, inverse.body);
    expect(undone.status).toBe(200);
    const after = await state();
    expect(after.blocks).toEqual(before.blocks); expect(after.links).toEqual(before.links);
    expect((await h.call("POST", inverse.path, inverse.body)).status).toBe(409);
  });

  test("moving all blocks leaves an editable paragraph and undo removes only that filler", async () => {
    const before = await state(), moved = await move({ ids: ["a", "middle", "z"] });
    expect(moved.status).toBe(200);
    expect((await page("source")).blocks).toEqual([block(moved.data.receipt.filler, 0, "")]);
    const inverse = moved.data.receipt.inverse;
    expect((await h.call("POST", inverse.path, inverse.body)).status).toBe(200);
    expect((await state()).blocks).toEqual(before.blocks);
  });

  test("stale source and stale destination reject without content or history writes", async () => {
    const before = await state(), body = await payload();
    for (const field of ["source_updated", "target_updated"]) {
      expect((await h.call("POST", "/api/page/source/move-blocks", { ...body, [field]: body[field] - 1 })).status).toBe(409);
      expect(await state()).toEqual(before);
    }
    expect(moveBatches).toBe(0);
  });

  for (const slug of ["source", "target"]) test("atomic claim rejects a racing " + slug + " version", async () => {
    const before = await state();
    beforeMoveBatch = async () => { await db.prepare("UPDATE pages SET updated = updated + 1 WHERE slug = ?").bind(slug).run(); };
    expect((await move()).status).toBe(409);
    const after = await state();
    expect(after.blocks).toEqual(before.blocks); expect(after.history).toEqual(before.history); expect(after.links).toEqual(before.links);
    expect(moveBatches).toBe(1);
  });

  test("a real destination insert failure rolls back source, destination and both histories", async () => {
    const before = await state();
    if (backend === "sqlite") h.sqlite.exec("CREATE TRIGGER reject_move BEFORE INSERT ON blocks WHEN new.page = 'target' AND new.id = 'child' BEGIN SELECT RAISE(ABORT, 'test move rejection'); END");
    else await lite.exec("ALTER TABLE blocks ADD CONSTRAINT reject_move CHECK (NOT (page = 'target' AND id = 'child'))");
    try { expect((await move()).status).toBe(500); expect(await state()).toEqual(before); }
    finally { if (backend === "postgres") await lite.exec("ALTER TABLE blocks DROP CONSTRAINT reject_move"); }
  });

  test("collisions, invalid IDs, missing destinations and self insertion never remove source", async () => {
    await put("target", [block("dest"), block("child")]);
    const before = await state();
    for (const [extra, status] of [[{}, 409], [{ ids: ["missing"] }, 400], [{ ids: ["a", "a"] }, 400], [{ ids: [] }, 400],
      [{ beforeId: "child" }, 400], [{ target: "source" }, 400], [{ target: "missing" }, 404]] as const) {
      expect((await move(extra)).status).toBe(status); expect(await state()).toEqual(before);
    }
    expect(moveBatches).toBe(0);
  });

  test("write helper rejects unauthorized destination or source before a batch", async () => {
    const body = await payload(), before = await state();
    for (const roles of [new Map([["source", "edit"]]), new Map([["source", "edit"], ["target", "read"]]), new Map([["source", "read"], ["target", "full"]])]) {
      h.env.DB.acardRoles = roles;
      expect((await h.call("POST", "/api/page/source/move-blocks", body)).status).toBe(401);
      expect(await state()).toEqual(before);
    }
    h.env.DB.acardRoles = new Map([["source", "edit"], ["target", "full"]]);
    expect((await h.call("POST", "/api/page/source/move-blocks", body)).status).toBe(200);
  });

  test("missing insertion anchor, selected subpage destination and trashed destination fail unchanged", async () => {
    let before = await state();
    expect((await move({ beforeId: "absent" })).status).toBe(400);
    expect(await state()).toEqual(before);
    await db.prepare("UPDATE blocks SET meta = ? WHERE page = ? AND id = ?").bind('{"subpage":"target"}', "source", "a").run();
    before = await state();
    expect((await move()).status).toBe(400); expect(await state()).toEqual(before);
    await db.prepare("INSERT INTO editor_trash (page, deleted) VALUES (?, ?)").bind("target", Date.now()).run();
    before = await state();
    const body = { target: "target", ids: ["a"], source_updated: (await page("source")).page.updated,
      target_updated: Number(before.pages.find((row: any) => row.slug === "target").updated) };
    expect((await h.call("POST", "/api/page/source/move-blocks", body)).status).toBe(404); expect(await state()).toEqual(before);
  });

  test("anonymous route and real guest session with only source access fail closed", async () => {
    const body = await payload(), before = await state();
    expect((await h.call("POST", "/api/page/source/move-blocks", body, true)).status).toBe(401);
    const token = "x".repeat(43), hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
    await db.prepare("INSERT INTO share_sessions (token_hash, email, links, created, expires) VALUES (?, ?, ?, ?, ?)").bind(hash, "guest@test.dev", "[]", Date.now(), Date.now() + 60000).run();
    await db.prepare("INSERT INTO share_rules (id, page, principal, role, created) VALUES (?, ?, ?, ?, ?)").bind("guest-rule", "source", "email:guest@test.dev", "edit", Date.now()).run();
    const guestEnv = (h.worker as any).acardHost.trust({ ...h.env, ACARD_GUEST_TOKEN: token });
    const response = await h.worker.fetch(new Request("https://notes.test/api/page/source/move-blocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), guestEnv);
    expect(response.status).toBe(401); expect(await state()).toEqual(before); expect(moveBatches).toBe(0);
  });

  test("a real guest can move only when both pages grant write access", async () => {
    const token = "y".repeat(43);
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
    await db.prepare("INSERT INTO share_sessions (token_hash, email, links, created, expires) VALUES (?, ?, ?, ?, ?)").bind(hash, "move-guest@test.dev", "[]", Date.now(), Date.now() + 60000).run();
    await db.prepare("INSERT INTO share_rules (id, page, principal, role, created) VALUES (?, ?, ?, ?, ?)").bind("target-guest", "target", "email:move-guest@test.dev", "edit", Date.now()).run();
    const host = Reflect.get(h.worker, "acardHost");
    const guestEnv = host.trust({ ...h.env, ACARD_GUEST_TOKEN: token });
    const request = async () => h.worker.fetch(new Request("https://notes.test/api/page/source/move-blocks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await payload()),
    }), guestEnv);
    const before = await state();
    expect((await request()).status).toBe(401);
    expect(await state()).toEqual(before);
    await db.prepare("INSERT INTO share_rules (id, page, principal, role, created) VALUES (?, ?, ?, ?, ?)").bind("source-guest", "source", "email:move-guest@test.dev", "edit", Date.now()).run();

    const response = await request();

    expect(response.status).toBe(200);
    expect((await page("source")).blocks.map((entry: { id: string }) => entry.id)).toEqual(["middle", "z"]);
    expect((await page("target")).blocks.map((entry: { id: string }) => entry.id)).toEqual(["dest", "a", "child", "grand"]);
  });

  test("button saver identity follows the move and inverse without privilege escalation", async () => {
    await db.prepare("UPDATE blocks SET type = ?, meta = ? WHERE page = ? AND id = ?").bind("button", '{"actions":[{"type":"open","target":"url","url":"/"}]}', "source", "z").run();
    await db.prepare("INSERT INTO db_button_savers (button, kind, session, email, roles, saved) VALUES (?, ?, ?, ?, ?, ?)").bind("block:source:z", "guest", "session", "guest@test.dev", '{"source":"edit"}', 12).run();
    const before = await state(), moved = await move({ ids: ["z"] });
    expect(moved.status).toBe(200);
    expect(await rows("SELECT * FROM db_button_savers")).toEqual([{ ...before.buttons[0], button: "block:target:z" }]);
    expect((await h.call("POST", moved.data.receipt.inverse.path, moved.data.receipt.inverse.body)).status).toBe(200);
    expect((await state()).buttons).toEqual(before.buttons);
  });

  test("undo is version guarded and rejects forged history receipts", async () => {
    const moved = await move(), inverse = moved.data.receipt.inverse;
    expect(moved.status).toBe(200);
    const before = await state();
    expect((await h.call("POST", inverse.path, { ...inverse.body, undo: "forged" })).status).toBe(400);
    expect(await state()).toEqual(before);
    await put("target", [...(await page("target")).blocks, block("new")]);
    const edited = await state();
    expect((await h.call("POST", inverse.path, inverse.body)).status).toBe(409);
    expect(await state()).toEqual(edited);
  });
});
