import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgD1 } from "../gate/pg-d1";
import { assembleWorkerSource } from "./assemble-worker";
import { setup } from "./db-harness";

const ROOT = join(import.meta.dir, "..");
const block = (id: string, indent = 0, text = id, meta?: any) => ({ id, type: "paragraph", text, checked: false, indent, ...(meta ? { meta } : {}) });
const synced = (id: string, source: any = null, indent = 0) => ({ id, type: "synced", text: "", checked: false, indent, meta: { synced: { v: 1, source } } });
const strip = (sql: string) => sql.replace(/REVOKE[^;]*;/g, "").replace(/GRANT[^;]*;/g, "").replace(/DROP POLICY[^;]*;/g, "").replace(/CREATE POLICY[^;]*;/g, "");
// The fixture exposes the real feature dispatcher and helpers, not an alternate implementation.
// Guest outer-route allowlisting belongs to the lead's share.js integration, outside this task's write scope.
const source = assembleWorkerSource().replace("return Object.assign(__worker, { acardHost });", `return Object.assign(__worker, { acardHost,
  syncedTest: { clean: typeof cleanSyncedMeta === "function" ? cleanSyncedMeta : null,
    ensureAgentSchema,
    validate: typeof validateSyncedBlocks === "function" ? validateSyncedBlocks : null,
    resolve: typeof resolveSyncedBlocks === "function" ? resolveSyncedBlocks : null,
    async api(db, env, method, path, body) {
      const request = new Request("https://notes.test" + path, { method, headers: {"content-type":"application/json"}, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const hook of ACARD_FEATURES.api) {
        const response = await hook(featureContext(request, env, db, new URL(request.url)));
        if (response !== null) return response;
      }
      return new Response("{}", { status: 404 });
    }
  }
});`);

for (const backend of ["sqlite", "postgres"] as const) describe("synced blocks (" + backend + ")", () => {
  let lite: PGlite, h: ReturnType<typeof setup>, db: any, api: any;
  let beforeBatch: (() => Promise<void>) | undefined;
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
    const worker = new Function(source)();
    api = worker.syncedTest;
    h = setup({ worker });
    if (backend === "postgres") {
      await lite.exec("TRUNCATE pages, blocks, links, editor_history, editor_trash, editor_page_settings, db_button_savers, page_fts, page_fts_ko, page_fts_dirty, share_rules, share_sessions, agent_activity, share_pages");
      const query = (q: { query: PGlite["query"] }) => async (sql: string, params: unknown[]) => {
        const result = await q.query<Record<string, unknown>>(sql, params);
        return { rows: result.rows, count: result.affectedRows ?? result.rows.length };
      };
      h.env.DB = pgD1({ query: query(lite), transaction: fn => lite.transaction(tx => fn(query(tx))) });
    }
    db = h.env.DB;
    for (const slug of ["source", "first", "second"]) {
      expect((await h.call("POST", "/api/pages", { slug, title: slug })).status).toBe(200);
      expect((await h.call("PUT", "/api/page/" + slug, { blocks: slug === "source" ? [block("a", 0, "PRIVATE_SENTINEL [[linked]]"), block("child", 1), block("outside")] : [block("tail")] })).status).toBe(200);
    }
    beforeBatch = undefined;
    const statement = (sql: string, params: unknown[] = []): any => {
      const inner = db.prepare(sql).bind(...params);
      return { sql, params, inner, bind: (...values: unknown[]) => statement(sql, values), run: () => inner.run(), all: () => inner.all(), first: () => inner.first() };
    };
    h.env.DB = { dialect: db.dialect, prepare: statement, batch: async (items: any[]) => {
      if (items.some(item => item.sql.startsWith("INSERT INTO editor_history") && item.params.some((v: unknown) => typeof v === "string" && v.includes('"syncedOperation"')))) {
        const event = beforeBatch; beforeBatch = undefined; await event?.();
      }
      return db.batch(items.map(item => item.inner));
    } };
  });
  afterEach(() => h.sqlite.close());
  async function rows(sql: string, ...params: unknown[]) { return (await db.prepare(sql).bind(...params).all()).results; }
  async function version(slug: string) { return (await db.prepare("SELECT updated FROM pages WHERE slug = ?").bind(slug).first()).updated; }
  async function state() {
    return { pages: await rows("SELECT * FROM pages ORDER BY slug"), blocks: await rows("SELECT * FROM blocks ORDER BY page, ord"),
      links: await rows("SELECT * FROM links ORDER BY src, dst"), history: await rows("SELECT * FROM editor_history ORDER BY id"), buttons: await rows("SELECT * FROM db_button_savers ORDER BY button") };
  }
  async function call(method: string, slug: string, suffix = "", body?: any, context?: any) {
    if (!context) return h.call(method, "/api/page/" + slug + "/synced" + suffix, body);
    try {
      const response = await api.api(context.db ?? h.env.DB, context.env ?? h.env, method, "/api/page/" + slug + "/synced" + suffix, body);
      return { status: response.status, data: await response.json() as any };
    } catch (error: any) { return { status: error.status ?? 500, data: { error: error.message } }; }
  }
  async function canonical() {
    const result = await call("POST", "source", "", { ids: ["a"], base_updated: await version("source") });
    expect(result.status).toBe(200);
    return result.data.block.id as string;
  }
  async function reference(root: string, slug = "first") {
    const result = await call("POST", slug, "", { source: { page: "source", block: root }, base_updated: await version(slug), source_updated: await version("source") });
    expect(result.status).toBe(200);
    return result.data.block.id as string;
  }
  test("real guest routing resolves only independently readable sources", async () => {
    const root = await canonical(), instance = await reference(root);
    const token = "s".repeat(43);
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
    await db.prepare("INSERT INTO share_sessions (token_hash, email, links, created, expires) VALUES (?, ?, ?, ?, ?)").bind(hash, "sync-guest@test.dev", "[]", Date.now(), Date.now() + 60000).run();
    await db.prepare("INSERT INTO share_rules (id, page, principal, role, created) VALUES (?, ?, ?, ?, ?)").bind("sync-reference", "first", "email:sync-guest@test.dev", "edit", Date.now()).run();
    const guestEnv = Reflect.get(h.worker, "acardHost").trust({ ...h.env, ACARD_GUEST_TOKEN: token });
    const request = () => h.worker.fetch(new Request("https://notes.test/api/page/first/synced"), guestEnv);

    const denied = await request();
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ updated: await version("first"), resolved: [{ id: instance, status: "unavailable" }] });
    await db.prepare("INSERT INTO share_rules (id, page, principal, role, created) VALUES (?, ?, ?, ?, ?)").bind("sync-source", "source", "email:sync-guest@test.dev", "read", Date.now()).run();
    const allowed = await request();
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("PRIVATE_SENTINEL");
  });

  test("cross-page movement cannot invalidate canonical source identity", async () => {
    const root = await canonical();
    await reference(root);
    const before = await state();

    const response = await h.call("POST", "/api/page/source/move-blocks", {
      target: "second", ids: [root], source_updated: await version("source"), target_updated: await version("second"),
    });

    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });
  test("generic replacement rejects malformed synced content before normalization", async () => {
    const before = await state();
    const malformed = { ...synced("bad"), indent: 7 };

    const response = await h.call("PUT", "/api/page/first", { base_updated: await version("first"), blocks: [malformed] });

    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("ordinary delta edits retain an existing unavailable reference without copying its content", async () => {
    const root = await canonical(), instance = await reference(root);
    await db.prepare("INSERT INTO editor_trash (page, deleted) VALUES (?, ?)").bind("source", Date.now()).run();
    const response = await h.call("PATCH", "/api/page/first/blocks", {
      base_updated: await version("first"), deletes: [], upserts: [{ ...block("tail", 0, "local change"), ord: 0 }],
    });

    expect(response.status).toBe(200);
    expect(await rows("SELECT id, text, meta FROM blocks WHERE page = ? ORDER BY ord", "first")).toEqual([
      { id: "tail", text: "local change", meta: null },
      { id: instance, text: "", meta: JSON.stringify({ synced: { v: 1, source: { page: "source", block: root } } }) },
    ]);
  });

  test("delta writes validate the complete merged source subtree", async () => {
    const root = await canonical(), before = await state();
    const response = await h.call("PATCH", "/api/page/source/blocks", {
      base_updated: await version("source"), deletes: [],
      upserts: [{ ...synced("child", { page: "second", block: "missing" }, 2), ord: 2 }],
    });

    expect(root).toBeTruthy();
    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("generic writes reject new references whose canonical target is absent", async () => {
    const before = await state();
    const response = await h.call("PUT", "/api/page/first", {
      base_updated: await version("first"), blocks: [synced("new-ref", { page: "source", block: "missing" })],
    });

    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("historical restore rejects malformed synced structure without replacing the page", async () => {
    const snapshot = { page: (await rows("SELECT * FROM pages WHERE slug = ?", "first"))[0],
      blocks: [{ ...synced("bad"), indent: 7, page: "first", ord: 0, checked: 0, meta: JSON.stringify(synced("bad").meta) }],
      links: [], settings: {} };
    await db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) VALUES (?, ?, ?, ?, ?)").bind("malformed", "first", "first", Date.now(), JSON.stringify(snapshot)).run();
    const before = await state();

    const response = await h.call("POST", "/api/page/first/history/malformed/restore", {});

    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });
  async function patchBody(extra: any = {}) { return { base_updated: await version("first"), source_updated: await version("source"), blocks: [block("a", 0, "edited [[next]]"), block("child", 1)], ...extra }; }
  function guest(roles: [string, string][]) {
    return { db: { ...h.env.DB, acardVisible: new Set(roles.map(([slug]) => slug)), acardRoles: new Map(roles), acardSaver: { session: "session", email: "guest@test.dev" } },
      env: (h.worker as any).acardHost.trust({ ...h.env, ACARD_SESSION: "guest" }) };
  }

  test("strict metadata and structural validation reject malformed, nested, same-page and overflow input", () => {
    expect(typeof api.validate).toBe("function");
    expect(api.clean({ synced: { v: 1, source: null } })).toEqual({ synced: { v: 1, source: null } });
    expect(api.clean({ synced: { v: 2, source: null } })).toBeNull();
    expect(api.clean({ synced: { v: 1, source: { page: "../bad", block: "x" } } })).toBeNull();
    expect(api.clean({ synced: { v: 1, source: null }, html: "cached" })).toBeNull();
    expect(api.validate([synced("s"), block("c", 1)], "source")).toBeNull();
    for (const blocks of [[synced("s"), synced("n", null, 1)], [synced("r", { page: "other", block: "s" }), block("c", 1)],
      [synced("r", { page: "source", block: "s" })], [block("x"), block("x")], [block("x", 7)], [synced("s"), { ...block("x", 1), meta: { synced: { v: 1, source: null } } }],
      Array.from({ length: 2001 }, (_, i) => block("b" + i))]) expect(api.validate(blocks, "source")).not.toBeNull();
  });

  test("create, reference, read and edit from two instances change only canonical content", async () => {
    const opaque = '{ "opaque": {"x":[1,2]}, "richText": [{"text":"child"}] }';
    await db.prepare("UPDATE blocks SET meta = ? WHERE page = ? AND id = ?").bind(opaque, "source", "child").run();
    const root = await canonical(), first = await reference(root), second = await reference(root, "second");
    expect((await rows("SELECT meta FROM blocks WHERE page = ? AND id = ?", "source", "child"))[0].meta).toBe(opaque);
    const before = await state(), read = await call("GET", "first");
    expect(read.status).toBe(200); expect(read.data.resolved[0].blocks[0].text).toContain("PRIVATE_SENTINEL");
    const edit = await call("PATCH", "first", "/" + first, await patchBody());
    expect(edit.status).toBe(200); expect(edit.data.reference_updated).toBe(await version("first"));
    expect(edit.data.source_updated).toBe(await version("source"));
    expect((await call("GET", "second")).data.resolved[0]).toMatchObject({ id: second, source: { page: "source", block: root }, blocks: [{ id: "a", text: "edited [[next]]" }, { id: "child" }] });
    const after = await state();
    expect(after.blocks.filter((b: any) => b.page !== "source")).toEqual(before.blocks.filter((b: any) => b.page !== "source"));
    expect(after.history.length).toBe(before.history.length + 1);
    expect(after.blocks.find((b: any) => b.page === "source" && b.id === "outside")).toEqual(before.blocks.find((b: any) => b.page === "source" && b.id === "outside"));
    expect(after.links.filter((x: any) => x.src === "source")).toEqual([{ src: "source", dst: "next" }]);
    expect(JSON.parse(after.history.find((x: any) => x.id === edit.data.receipt.history).snapshot).syncedOperation).toMatchObject({ operation: "edit", source: { page: "source", block: root }, reference: { page: "first", block: first } });
    const other = await call("PATCH", "second", "/" + second, { ...await patchBody(), base_updated: await version("second"), blocks: [block("a", 0, "second edit")] });
    expect(other.status).toBe(200); expect((await call("GET", "first")).data.resolved[0].blocks[0].text).toBe("second edit");
  });

  test("both permissions are required, no missing-role owner fallback, denied source is generic", async () => {
    const root = await canonical(), id = await reference(root), body = await patchBody(), before = await state();
    for (const roles of [[["first", "edit"]], [["first", "edit"], ["source", "read"]], [["first", "read"], ["source", "edit"]]] as [string, string][][]) {
      expect((await call("PATCH", "first", "/" + id, body, guest(roles))).status).toBe(403);
      expect(await state()).toEqual(before);
    }
    const hidden = await call("GET", "first", "", undefined, guest([["first", "edit"]]));
    expect(hidden.data.resolved).toEqual([{ id, status: "unavailable" }]);
    expect(JSON.stringify(hidden.data)).not.toContain("PRIVATE_SENTINEL");
    expect((await call("GET", "first", "", undefined, { env: guest([]).env })).status).toBe(404);
    expect((await call("PATCH", "first", "/" + id, body, guest([["first", "edit"], ["source", "edit"]]))).status).toBe(200);
  });

  test("source edit undo and redo use immutable receipts and reject stale replay", async () => {
    const root = await canonical(), id = await reference(root), before = await state();
    const edit = await call("PATCH", "first", "/" + id, await patchBody());
    expect(edit.status).toBe(200);
    const changed = await state();
    const inverse = { undo: edit.data.receipt.history, base_updated: edit.data.reference_updated, source_updated: edit.data.source_updated };

    const undone = await call("POST", "first", "", inverse);

    expect(undone.status).toBe(200);
    expect((await state()).blocks).toEqual(before.blocks);
    expect((await state()).links).toEqual(before.links);
    expect((await call("POST", "first", "", inverse)).status).toBe(409);
    const redone = await call("POST", "first", "", { undo: undone.data.receipt.history,
      base_updated: undone.data.reference_updated, source_updated: undone.data.source_updated });
    expect(redone.status).toBe(200);
    expect((await state()).blocks).toEqual(changed.blocks);
    expect((await state()).links).toEqual(changed.links);
  });

  test("legacy history endpoint cannot replay a synced receipt without its observed versions", async () => {
    const root = await canonical(), id = await reference(root);
    const edited = await call("PATCH", "first", "/" + id, await patchBody());
    const before = await state();

    const response = await h.call("POST", "/api/page/source/history/" + edited.data.receipt.history + "/restore", {});

    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("detach undo restores the reference and cannot bypass revoked source access", async () => {
    const root = await canonical(), id = await reference(root), before = await state();
    const detached = await call("POST", "first", "/" + id + "/detach", {
      base_updated: await version("first"), source_updated: await version("source"),
    });
    expect(detached.status).toBe(200);
    const body = { undo: detached.data.receipt.history, base_updated: detached.data.reference_updated, source_updated: detached.data.source_updated };
    const afterDetach = await state();

    const denied = await call("POST", "first", "", body, guest([["first", "edit"]]));

    expect(denied.status).toBe(403);
    expect(await state()).toEqual(afterDetach);
    const undone = await call("POST", "first", "", body);
    expect(undone.status).toBe(200);
    expect((await state()).blocks).toEqual(before.blocks);
    expect((await state()).links).toEqual(before.links);
  });

  test("canonical creation undo and redo preserve child identities", async () => {
    const before = await state();
    const created = await call("POST", "source", "", { ids: ["a"], base_updated: await version("source") });
    expect(created.status).toBe(200);
    const afterCreate = await state();
    const undone = await call("POST", "source", "", { undo: created.data.receipt.history,
      base_updated: created.data.reference_updated, source_updated: created.data.source_updated });

    expect(undone.status).toBe(200);
    expect((await state()).blocks).toEqual(before.blocks);
    const redone = await call("POST", "source", "", { undo: undone.data.receipt.history,
      base_updated: undone.data.reference_updated, source_updated: undone.data.source_updated });
    expect(redone.status).toBe(200);
    expect((await state()).blocks).toEqual(afterCreate.blocks);
  });

  test("undo claim loses a racing reference version without restoring source content", async () => {
    const root = await canonical(), id = await reference(root);
    const edited = await call("PATCH", "first", "/" + id, await patchBody());
    expect(edited.status).toBe(200);
    const before = await state();
    beforeBatch = async () => { await db.prepare("UPDATE pages SET updated = updated + 1 WHERE slug = ?").bind("first").run(); };

    const response = await call("POST", "first", "", { undo: edited.data.receipt.history,
      base_updated: edited.data.reference_updated, source_updated: edited.data.source_updated });

    expect(response.status).toBe(409);
    const after = await state();
    expect(after.blocks).toEqual(before.blocks);
    expect(after.history).toEqual(before.history);
  });

  test("public resolution uses the exact visible set and never inherits owner authority", async () => {
    const root = await canonical(), id = await reference(root);
    const blocks = [synced(id, { page: "source", block: root })];
    expect(await api.resolve(db, "first", blocks, {})).toEqual([{ id, status: "unavailable" }]);
    for (const visible of [undefined, new Set(["first"]), new Set(["source"])]) {
      const result = await api.resolve(db, "first", blocks, { principal: { kind: "token" }, visible });
      expect(result).toEqual([{ id, status: "unavailable" }]); expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    }
    const result = await api.resolve(db, "first", blocks, { principal: { kind: "token" }, visible: new Set(["first", "source"]) });
    expect(result[0].blocks[0].text).toContain("PRIVATE_SENTINEL");
    expect(result[0].editable).toBe(false);
  });

  test("agent source scopes narrow independently and AI locks cannot be overwritten", async () => {
    const root = await canonical(), id = await reference(root), before = await state();
    await db.prepare("INSERT INTO share_rules (id, page, principal, role, created) VALUES (?, ?, ?, ?, ?)").bind("agent-rule", "source", "agent:name:test-agent", "read", 1).run();
    const context = { env: { ...h.env, ACARD_SAVE_PRINCIPAL: { name: "test-agent", scopes: ["read", "write"] } } };
    expect((await call("PATCH", "first", "/" + id, await patchBody(), context)).status).toBe(403);
    expect(await state()).toEqual(before);
    await db.prepare("DELETE FROM share_rules WHERE id = ?").bind("agent-rule").run();
    await db.prepare("UPDATE blocks SET meta = ? WHERE page = ? AND id = ?").bind('{"ai":"lock"}', "source", "a").run();
    const locked = await call("PATCH", "first", "/" + id, await patchBody(), context);
    expect(locked.status).toBe(200);
    expect((await rows("SELECT text FROM blocks WHERE page = ? AND id = ?", "source", "a"))[0].text).toContain("PRIVATE_SENTINEL");
  });

  test("stale versions and deterministic racing page changes perform no writes", async () => {
    const root = await canonical(), id = await reference(root), body = await patchBody();
    for (const key of ["base_updated", "source_updated"]) {
      const before = await state();
      expect((await call("PATCH", "first", "/" + id, { ...body, [key]: body[key] - 1 })).status).toBe(409);
      expect(await state()).toEqual(before);
    }
    for (const slug of ["first", "source"]) {
      const before = await state();
      beforeBatch = async () => { await db.prepare("UPDATE pages SET updated = updated + 1 WHERE slug = ?").bind(slug).run(); };
      expect((await call("PATCH", "first", "/" + id, await patchBody())).status).toBe(409);
      const after = await state(); expect(after.blocks).toEqual(before.blocks); expect(after.history).toEqual(before.history); expect(after.links).toEqual(before.links);
    }
  });

  test("actual source insert failure rolls back content, history and versions", async () => {
    const root = await canonical(), id = await reference(root), before = await state();
    if (backend === "sqlite") h.sqlite.run("CREATE TRIGGER reject_synced BEFORE INSERT ON blocks WHEN new.page = 'source' AND new.id = 'a' BEGIN SELECT RAISE(ABORT, 'synced test rejection'); END");
    else await lite.exec("ALTER TABLE blocks ADD CONSTRAINT reject_synced CHECK (NOT (page = 'source' AND id = 'a' AND text = 'edited [[next]]'))");
    try { expect((await call("PATCH", "first", "/" + id, await patchBody())).status).toBe(500); expect(await state()).toEqual(before); }
    finally { if (backend === "postgres") await lite.exec("ALTER TABLE blocks DROP CONSTRAINT reject_synced"); }
  });

  test("detach preserves raw metadata, assigns fresh IDs and leaves source and its history unchanged", async () => {
    const root = await canonical(), id = await reference(root);
    const raw = '{ "opaque": [1,2], "actions": [{"type":"open","target":"url","url":"/"}] }';
    await db.prepare("UPDATE blocks SET type = ?, meta = ? WHERE page = ? AND id = ?").bind("button", raw, "source", "a").run();
    await db.prepare("INSERT INTO db_button_savers (button, kind, session, email, roles, saved) VALUES (?, ?, ?, ?, ?, ?)").bind("block:source:a", "guest", "old", "old@test.dev", '{"source":"edit"}', 12).run();
    const before = await state(), body = await patchBody(); delete body.blocks;
    const result = await call("POST", "first", "/" + id + "/detach", body);
    expect(result.status).toBe(200);
    const after = await state(), copied = after.blocks.filter((b: any) => b.page === "first" && b.id !== "tail");
    expect(copied.map((b: any) => b.indent)).toEqual([0, 1]); expect(copied.map((b: any) => b.id)).not.toContain("a"); expect(copied.map((b: any) => b.id)).not.toContain("child");
    expect(copied[0].meta).toBe(raw);
    expect(after.blocks.filter((b: any) => b.page === "source")).toEqual(before.blocks.filter((b: any) => b.page === "source"));
    expect(after.pages.find((p: any) => p.slug === "source")).toEqual(before.pages.find((p: any) => p.slug === "source"));
    expect(after.history.filter((v: any) => v.page === "source")).toEqual(before.history.filter((v: any) => v.page === "source"));
    expect(after.buttons.find((b: any) => b.button === "block:first:" + copied[0].id)).toEqual({ ...before.buttons[0], button: "block:first:" + copied[0].id });
    expect(JSON.parse(after.history.find((v: any) => v.id === result.data.receipt.history).snapshot).blocks.some((b: any) => b.id === id)).toBe(true);
  });

  test("restricted detach requires source export permission", async () => {
    const root = await canonical(), id = await reference(root), body = await patchBody(); delete body.blocks;
    const context = guest([["first", "edit"], ["source", "read"]]), before = await state();
    expect((await call("POST", "first", "/" + id + "/detach", body, context)).status).toBe(403); expect(await state()).toEqual(before);
    await db.prepare("INSERT INTO share_pages (page, allow_export) VALUES (?, ?)").bind("source", 1).run();
    expect((await call("POST", "first", "/" + id + "/detach", body, context)).status).toBe(200);
  });

  test("deleted source and malformed reference cycles are unavailable without cached data", async () => {
    const root = await canonical(), id = await reference(root);
    await db.prepare("INSERT INTO editor_trash (page, deleted) VALUES (?, ?)").bind("source", 1).run();
    expect((await call("GET", "first")).data.resolved).toEqual([{ id, status: "unavailable" }]);
    const before = await state(), body = await patchBody(); delete body.blocks;
    expect((await call("POST", "first", "/" + id + "/detach", body)).status).toBe(404); expect(await state()).toEqual(before);
    await db.prepare("DELETE FROM editor_trash WHERE page = ?").bind("source").run();
    await db.prepare("DELETE FROM blocks WHERE page = ? AND id IN (?, ?)").bind("source", "a", "child").run();
    await db.prepare("UPDATE blocks SET meta = ? WHERE page = ? AND id = ?").bind(JSON.stringify(synced(root, { page: "first", block: id }).meta), "source", root).run();
    expect((await call("GET", "first")).data.resolved).toEqual([{ id, status: "unavailable" }]);
  });

  test("subtree edit cannot overwrite siblings, nest synced content or clamp limits", async () => {
    const root = await canonical(), id = await reference(root), before = await state();
    for (const blocks of [[block("outside", 0, "attack")], [block("x"), block("x")], [synced("nested")], [block("x", 6)], Array.from({ length: 2001 }, (_, i) => block("b" + i))]) {
      expect((await call("PATCH", "first", "/" + id, await patchBody({ blocks }))).status).toBe(400); expect(await state()).toEqual(before);
    }
    expect((await call("PATCH", "first", "/" + id, await patchBody({ source: { page: "second", block: "tail" } }))).status).toBe(400);
    expect(await state()).toEqual(before);
  });

  test("source creation rejects nested placement and overflow rather than reshaping or truncating", async () => {
    const root = await canonical(), before = await state();
    expect((await call("POST", "source", "", { ids: ["a"], base_updated: await version("source") })).status).toBe(400);
    expect((await call("POST", "first", "", { source: { page: "source", block: "outside" }, base_updated: await version("first"), source_updated: await version("source") })).status).toBe(404);
    expect((await call("POST", "source", "", { source: { page: "source", block: root }, base_updated: await version("source"), source_updated: await version("source") })).status).toBe(400);
    expect(await state()).toEqual(before);
    await db.prepare("UPDATE blocks SET indent = ? WHERE page = ? AND id = ?").bind(6, "source", "outside").run();
    const deep = await state();
    expect((await call("POST", "source", "", { ids: ["outside"], base_updated: await version("source") })).status).toBe(400);
    expect(await state()).toEqual(deep);
  });

  test("resolver fails closed on expansion overflow and enforces export on both pages", async () => {
    const root = await canonical();
    const refs = Array.from({ length: 1001 }, (_, i) => synced("r" + i, { page: "source", block: root }));
    const result = await api.resolve(db, "first", refs, { principal: { kind: "owner" } });
    expect(result.length).toBe(1001); expect(result.every((item: any) => item.status === "unavailable")).toBe(true);
    const options = { principal: { kind: "token" }, visible: new Set(["first", "source"]), export: true, exportable: new Set(["source"]) };
    expect(await api.resolve(db, "first", [refs[0]], options)).toEqual([{ id: "r0", status: "unavailable" }]);
    options.exportable.add("first");
    expect((await api.resolve(db, "first", [refs[0]], options))[0].status).toBe("available");
  });

  test("claim detects source trash and same-version hash changes without writes", async () => {
    const root = await canonical(), id = await reference(root);
    for (const change of ["trash", "hash"]) {
      const before = await state();
      beforeBatch = async () => {
        if (change === "trash") await db.prepare("INSERT INTO editor_trash (page, deleted) VALUES (?, ?)").bind("source", 1).run();
        else await db.prepare("UPDATE pages SET hash = ? WHERE slug = ?").bind("racing-hash", "source").run();
      };
      expect((await call("PATCH", "first", "/" + id, await patchBody())).status).toBe(409);
      const after = await state(); expect(after.blocks).toEqual(before.blocks); expect(after.history).toEqual(before.history); expect(after.links).toEqual(before.links);
      await db.prepare("DELETE FROM editor_trash WHERE page = ?").bind("source").run();
    }
  });

  test("changed button actions record the guest saver and human saves retain AI marks", async () => {
    const root = await canonical(), id = await reference(root);
    await api.ensureAgentSchema(db);
    await db.prepare("INSERT INTO agent_activity (id, agent, action, page, via, created) VALUES (?, ?, ?, ?, ?, ?)").bind("activity", "agent", "write", "source", "test", 1).run();
    await db.prepare("UPDATE blocks SET meta = ? WHERE page = ? AND id = ?").bind('{"human":{"at":1},"suggest":{"text":"pending"}}', "source", "child").run();
    const blocks = [{ ...block("a", 0, "Run"), type: "button", meta: { actions: [{ type: "open", target: "url", url: "/" }] } }, block("child", 1)];
    const result = await call("PATCH", "first", "/" + id, await patchBody({ blocks }), guest([["first", "edit"], ["source", "edit"]]));
    expect(result.status).toBe(200);
    const saver = (await rows("SELECT kind, session FROM db_button_savers WHERE button = ?", "block:source:a"))[0];
    expect(saver).toEqual({ kind: "guest", session: "session" });
    const stored = JSON.parse((await rows("SELECT meta FROM blocks WHERE page = ? AND id = ?", "source", "child"))[0].meta);
    expect(stored.human).toEqual({ at: 1 }); expect(stored.suggest).toEqual({ text: "pending" });
  });
});
