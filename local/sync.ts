// Multi-device sync v1, local side (docs/local-first.md 14장). Turned on in "내 데이터" for a subscribed account.
// Every run: pull the server's changes after the last seen number, then push every page whose content differs from the
// copy last agreed with the server (the "base", kept in <data>/sync.sqlite next to the app's own database, so the app's
// tables and backup format stay unchanged). Pages and their blocks, settings, view and tags travel; a database page also
// carries its database (properties, views, templates, rules, form) and a row page its db_rows row and outgoing relation
// links. Images and attachments referenced by a page or a row cell go up and come down by id. Conflicts follow
// sync-merge.ts. Every conflict a PC finds is kept in sync_conflicts and rides along (doc.conflicts) with the next push
// of that page and of its conflict copy, so every PC counts it once (#136). A table or row page that another PC made
// separately under the same address is moved to a new address before the incoming one is written, so neither table
// is overwritten and no row loses its table (#136).
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveDb, Row } from "../gate/archive";
import type { LocalArchiveEnv } from "./archive";
import type { CloudClient } from "./cloud";
import { mergePage, type Side, type SyncBlock, type SyncConflict, type SyncDoc } from "./sync-merge";

export const SYNC = {
  intervalMs: Number(process.env.ACARD_SYNC_INTERVAL_MS) > 0 ? Number(process.env.ACARD_SYNC_INTERVAL_MS) : 15_000,
  afterEditMs: Number(process.env.ACARD_SYNC_AFTER_EDIT_MS) > 0 ? Number(process.env.ACARD_SYNC_AFTER_EDIT_MS) : 2_000,
  firstMs: Number(process.env.ACARD_SYNC_FIRST_MS) > 0 ? Number(process.env.ACARD_SYNC_FIRST_MS) : 1_000,
  pushBytes: 8 * 1024 * 1024,
  pushPages: 100,
};
const CONFLICT_SUFFIX = " (충돌 사본)";
const MEDIA_REF = /\/media\/([0-9a-f]{16})/g;

type Base = { slug: string; seq: number; hash: string; deleted: number; doc: string | null };
type Remote = { slug: string; seq: number; updated: number; device: string | null; deleted: boolean; hash: string | null; doc: SyncDoc | null };
export type SyncRun = { at: number; pulled: number; pushed: number; conflicts: string[]; error?: string };
type Saved = { enabled: boolean; device: string; cursor: number; account: string | null; last: SyncRun | null; conflicts: number };

const content = (doc: SyncDoc): SyncDoc => { const { conflicts: _c, ...rest } = doc; return rest; };
const hashOf = (doc: SyncDoc | null) => (doc ? createHash("sha256").update(JSON.stringify({ ...content(doc), page: { ...doc.page, updated: 0 } })).digest("hex") : "deleted");
// Conflict notes arriving from the server are checked here: anything malformed is ignored.
const conflictsIn = (doc: SyncDoc | null): SyncConflict[] => (Array.isArray(doc?.conflicts) ? doc.conflicts : []).slice(0, 50).filter((c): c is SyncConflict =>
  Boolean(c) && typeof c.id === "string" && c.id.length <= 64 && typeof c.slug === "string" && typeof c.title === "string" && Number.isFinite(c.at) && (c.copy === null || typeof c.copy === "string"));

export function startSync(options: { env: LocalArchiveEnv; dataDir: string; ready: () => Promise<void>; cloud: CloudClient; notify: (slugs: string[]) => void; intervalMs?: number }) {
  const { env, dataDir, cloud } = options;
  const db = env.DB as ArchiveDb;
  const file = join(dataDir, "sync.json");
  const store = new Database(join(dataDir, "sync.sqlite"), { create: true });
  store.run("PRAGMA journal_mode = WAL");
  store.run("CREATE TABLE IF NOT EXISTS sync_base (slug TEXT PRIMARY KEY, seq INTEGER NOT NULL, hash TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, doc TEXT)");
  store.run("CREATE TABLE IF NOT EXISTS sync_media (id TEXT PRIMARY KEY)");
  store.run("CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, at INTEGER NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, copy TEXT, sent INTEGER NOT NULL DEFAULT 0)");
  let saved: Saved = { enabled: false, device: "d" + randomBytes(8).toString("hex"), cursor: 0, account: null, last: null, conflicts: 0 };
  if (existsSync(file)) try { saved = { ...saved, ...JSON.parse(readFileSync(file, "utf8")) }; } catch {}
  const save = () => writeFileSync(file, JSON.stringify(saved));
  save();
  const columns = new Map<string, Set<string>>();

  const all = async (sql: string, ...params: unknown[]) => ((await db.prepare(sql).bind(...params).all()).results ?? []) as Row[];
  async function cols(table: string) {
    if (!columns.has(table)) columns.set(table, new Set((await all("SELECT name FROM pragma_table_info('" + table + "')")).map((r) => String(r.name))));
    return columns.get(table)!;
  }
  const baseOf = (slug: string) => store.query("SELECT * FROM sync_base WHERE slug = ?").get(slug) as Base | null;
  const setBase = (slug: string, seq: number, doc: SyncDoc | null, deleted: boolean) =>
    store.query("INSERT OR REPLACE INTO sync_base (slug, seq, hash, deleted, doc) VALUES (?, ?, ?, ?, ?)").run(slug, seq, deleted ? "deleted" : hashOf(doc), deleted ? 1 : 0, doc ? JSON.stringify(doc) : null);
  const baseDoc = (b: Base | null) => (b?.doc ? (JSON.parse(b.doc) as SyncDoc) : null);
  // A conflict is counted once per PC: the PC that found it (mine, sent with the next push) and every PC that receives it.
  function noteConflict(c: SyncConflict, run: SyncRun, mine: boolean) {
    if (store.query("SELECT 1 FROM sync_conflicts WHERE id = ?").get(c.id)) return;
    store.query("INSERT INTO sync_conflicts (id, at, slug, title, copy, sent) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, c.at, c.slug, c.title.slice(0, 200), c.copy, mine ? 0 : 1);
    saved.conflicts += 1;
    run.conflicts.push(c.copy ?? c.slug);
  }
  const newConflict = (slug: string, title: string, copy: string | null): SyncConflict => ({ id: "k" + randomBytes(8).toString("hex"), at: Date.now(), slug, title, copy });
  const conflictsOf = (slug: string) => store.query("SELECT id, at, slug, title, copy FROM sync_conflicts WHERE slug = ? OR copy = ? ORDER BY at DESC LIMIT 20").all(slug, slug) as SyncConflict[];
  const unsentConflict = (slug: string) => Boolean(store.query("SELECT 1 FROM sync_conflicts WHERE sent = 0 AND (slug = ? OR copy = ?)").get(slug, slug));

  async function readDoc(slug: string): Promise<Side> {
    const page = (await all("SELECT slug, title, parent, ord, kind, updated FROM pages WHERE slug = ?", slug))[0];
    if (!page) return { deleted: true, doc: null };
    const trashed = (await all("SELECT page FROM editor_trash WHERE page = ?", slug)).length > 0;
    const strip = (row: Row | undefined) => { if (!row) return null; const { page: _p, ...rest } = row; return rest; };
    const [blocks, links, settings, view, tags] = await Promise.all([
      all("SELECT id, type, text, checked, indent, meta FROM blocks WHERE page = ? ORDER BY ord", slug),
      all("SELECT dst FROM links WHERE src = ? ORDER BY dst", slug),
      (await cols("editor_page_settings")).size ? all("SELECT * FROM editor_page_settings WHERE page = ?", slug) : Promise.resolve([]),
      (await cols("page_view")).size ? all("SELECT * FROM page_view WHERE page = ?", slug) : Promise.resolve([]),
      (await cols("page_tags")).size ? all("SELECT tag FROM page_tags WHERE page = ? ORDER BY tag", slug) : Promise.resolve([]),
    ]);
    const doc: SyncDoc = {
      page: { slug, title: String(page.title ?? ""), parent: page.parent == null ? null : String(page.parent), ord: Number(page.ord) || 0, kind: String(page.kind ?? "note"), updated: Number(page.updated) || 0 },
      blocks: blocks.map((b) => ({ id: String(b.id), type: String(b.type), text: String(b.text ?? ""), checked: Number(b.checked) ? 1 : 0, indent: Number(b.indent) || 0, meta: b.meta == null ? null : String(b.meta) })),
      links: links.map((l) => String(l.dst)),
      settings: strip(settings[0]),
      view: strip(view[0]),
      tags: tags.map((t) => String(t.tag)),
    };
    if (page.kind === "db") {
      const database = (await all("SELECT * FROM databases WHERE slug = ?", slug))[0];
      if (database) {
        const id = String(database.id);
        const [props, views, templates] = await Promise.all(["db_properties", "db_views", "db_templates"].map((table) => all("SELECT * FROM " + table + " WHERE database_id = ? ORDER BY id", id)));
        doc.database = { ...database, id, props, views, templates };
        if ((await cols("db_rules")).size) doc.database.rules = await all("SELECT * FROM db_rules WHERE database_id = ? ORDER BY id", id);
        if ((await cols("db_forms")).size) doc.database.forms = (await all("SELECT * FROM db_forms WHERE database_id = ?", id))[0] ?? null;
      }
    }
    if (page.kind === "db_row") {
      const row = (await all("SELECT id, database_id, props, ord, created, updated FROM db_rows WHERE page = ?", slug))[0];
      if (row) doc.row = {
        id: String(row.id), database_id: String(row.database_id), props: row.props == null ? null : String(row.props), ord: Number(row.ord) || 0, created: Number(row.created) || 0, updated: Number(row.updated) || 0,
        relations: await all("SELECT * FROM db_relation_links WHERE src_row = ? ORDER BY prop_id, dst_row", row.id),
      };
    }
    return { deleted: trashed, doc };
  }

  async function localSlugs() {
    return (await all("SELECT slug FROM pages")).map((r) => String(r.slug));
  }

  async function upsert(table: string, row: Record<string, unknown>) {
    const allowed = await cols(table);
    const keys = Object.keys(row).filter((k) => allowed.has(k));
    if (!keys.length) return null;
    return db.prepare("INSERT OR REPLACE INTO " + table + " (" + keys.map((k) => '"' + k + '"').join(", ") + ") VALUES (" + keys.map(() => "?").join(", ") + ")")
      .bind(...keys.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k] ?? null)));
  }

  async function fetchMedia(doc: SyncDoc) {
    for (const id of new Set([...JSON.stringify(doc).matchAll(MEDIA_REF)].map((m) => m[1]))) {
      const have = await env.MEDIA.getWithMetadata("media/" + id, { type: "arrayBuffer" });
      if (have.value) continue;
      const res = await cloud.call("/api/v1/cloud/sync/media/" + id);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const name = res.headers.get("x-acard-name") ?? "file";
      await env.MEDIA.put("media/" + id, bytes, { metadata: { mime, name, size: bytes.length } });
      const stmt = await upsert("media", { id, page: doc.page.slug, name, mime, bytes: bytes.length, created: Date.now() });
      if (stmt) await db.batch([stmt]);
      store.query("INSERT OR IGNORE INTO sync_media (id) VALUES (?)").run(id);
    }
  }

  async function sendMedia(doc: SyncDoc) {
    for (const id of new Set([...JSON.stringify(doc).matchAll(MEDIA_REF)].map((m) => m[1]))) {
      if (store.query("SELECT 1 FROM sync_media WHERE id = ?").get(id)) continue;
      const found = await env.MEDIA.getWithMetadata("media/" + id, { type: "arrayBuffer" });
      if (!found.value) continue;
      const meta = (found.metadata ?? {}) as { mime?: string; name?: string };
      const res = await cloud.call("/api/v1/cloud/sync/media/" + id, { method: "PUT", headers: { "content-type": meta.mime ?? "application/octet-stream", "x-acard-name": encodeURIComponent(meta.name ?? "file") }, body: new Uint8Array(found.value as ArrayBuffer) });
      if (!res.ok) throw new Error("파일을 올리지 못했어요 (" + res.status + ")");
      store.query("INSERT OR IGNORE INTO sync_media (id) VALUES (?)").run(id);
    }
  }

  async function writeDoc(doc: SyncDoc) {
    await fetchMedia(doc);
    const slug = doc.page.slug;
    const statements = [
      db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, ?, ?, 'editor', NULL) ON CONFLICT(slug) DO UPDATE SET title = excluded.title, parent = excluded.parent, ord = excluded.ord, updated = excluded.updated, source = 'editor', hash = NULL")
        .bind(slug, doc.page.title, doc.page.parent, doc.page.ord, doc.page.kind || "note", doc.page.updated || Date.now()),
      db.prepare("DELETE FROM blocks WHERE page = ?").bind(slug),
      ...doc.blocks.map((b: SyncBlock, i: number) => db.prepare("INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(slug, b.id, i, b.type, b.text, b.checked ? 1 : 0, b.indent || 0, b.meta)),
      db.prepare("DELETE FROM links WHERE src = ?").bind(slug),
      ...doc.links.map((dst) => db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)").bind(slug, dst)),
      db.prepare("DELETE FROM editor_trash WHERE page = ?").bind(slug),
    ];
    if ((await cols("editor_page_settings")).size) {
      statements.push(db.prepare("DELETE FROM editor_page_settings WHERE page = ?").bind(slug));
      if (doc.settings) { const s = await upsert("editor_page_settings", { ...doc.settings, page: slug }); if (s) statements.push(s); }
    }
    if ((await cols("page_view")).size) {
      statements.push(db.prepare("DELETE FROM page_view WHERE page = ?").bind(slug));
      if (doc.view) { const s = await upsert("page_view", { ...doc.view, page: slug }); if (s) statements.push(s); }
    }
    if ((await cols("page_tags")).size) {
      statements.push(db.prepare("DELETE FROM page_tags WHERE page = ?").bind(slug));
      for (const tag of doc.tags) {
        statements.push(db.prepare("INSERT OR IGNORE INTO page_tags (page, tag) VALUES (?, ?)").bind(slug, tag));
        if ((await cols("tags")).has("name")) statements.push(db.prepare("INSERT OR IGNORE INTO tags (name, created) VALUES (?, ?)").bind(tag, Date.now()));
      }
    }
    const add = async (table: string, row: Record<string, unknown>) => { const s = await upsert(table, row); if (s) statements.push(s); };
    if (doc.database) {
      const { props, views, templates, rules, forms, ...database } = doc.database;
      await add("databases", { ...database, slug });
      const lists: [string, Record<string, unknown>[] | undefined][] = [["db_properties", props], ["db_views", views], ["db_templates", templates], ["db_rules", rules], ["db_forms", forms === undefined ? undefined : forms ? [forms] : []]];
      for (const [table, list] of lists) {
        if (!list || !(await cols(table)).size) continue;
        statements.push(db.prepare("DELETE FROM " + table + " WHERE database_id = ?").bind(database.id));
        for (const item of list) await add(table, { ...item, database_id: database.id });
      }
    }
    if (doc.row) {
      const { relations, ...row } = doc.row;
      await add("db_rows", { ...row, page: slug });
      statements.push(db.prepare("DELETE FROM db_relation_links WHERE src_row = ?").bind(row.id));
      for (const link of relations) await add("db_relation_links", { ...link, src_row: row.id });
    }
    await db.batch(statements);
  }

  async function trash(slug: string) {
    if (slug === "index") return;
    const page = (await all("SELECT kind FROM pages WHERE slug = ?", slug))[0];
    if (!page) return;
    const statements = [db.prepare("INSERT INTO editor_trash (page, deleted, permanent) VALUES (?, ?, 0) ON CONFLICT(page) DO NOTHING").bind(slug, Date.now())];
    if (page.kind === "db_row") statements.push(
      db.prepare("DELETE FROM db_relation_links WHERE src_row IN (SELECT id FROM db_rows WHERE page = ?) OR dst_row IN (SELECT id FROM db_rows WHERE page = ?)").bind(slug, slug),
      db.prepare("DELETE FROM db_rows WHERE page = ?").bind(slug),
    );
    await db.batch(statements);
  }

  async function conflictCopy(doc: SyncDoc): Promise<string> {
    const slug = doc.page.slug + "-c" + randomBytes(3).toString("hex");
    const title = doc.page.title.endsWith(CONFLICT_SUFFIX) ? doc.page.title : doc.page.title + CONFLICT_SUFFIX;
    const { database: _d, row: _r, ...rest } = doc;
    await writeDoc({ ...rest, page: { ...doc.page, slug, title, ord: doc.page.ord + 1, kind: doc.database || doc.row ? "note" : doc.page.kind, updated: Date.now() } });
    return slug;
  }

  // A table (or row) page made on another PC under the same address as one here is a different table: the local one moves
  // to a new address, with every row of its own table, its sub-pages and the links that point at it by address, so the
  // incoming one can be written without replacing it. A moved table is marked "(충돌 사본)"; a moved row keeps its title.
  async function moveAside(doc: SyncDoc): Promise<string> {
    const from = doc.page.slug, to = from + "-c" + randomBytes(3).toString("hex"), now = Date.now();
    const title = doc.database && !doc.page.title.endsWith(CONFLICT_SUFFIX) ? doc.page.title + CONFLICT_SUFFIX : doc.page.title;
    const statements = [
      db.prepare("UPDATE pages SET slug = ?, title = ?, updated = ? WHERE slug = ?").bind(to, title, now, from),
      db.prepare("UPDATE links SET src = ? WHERE src = ?").bind(to, from),
    ];
    for (const row of await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('pages', 'links')")) {
      const table = String(row.name);
      if ((await cols(table)).has("page")) statements.push(db.prepare('UPDATE "' + table + '" SET page = ? WHERE page = ?').bind(to, from));
    }
    if (doc.database) {
      const id = doc.database.id;
      statements.push(
        db.prepare("UPDATE databases SET slug = ?, title = ?, updated = ? WHERE id = ?").bind(to, title, now, id),
        db.prepare("UPDATE pages SET parent = ? WHERE parent = ? AND (kind <> 'db_row' OR slug IN (SELECT page FROM db_rows WHERE database_id = ?))").bind(to, from, id),
        db.prepare("UPDATE db_properties SET config = json_set(config, '$.database', ?) WHERE json_valid(config) AND json_extract(config, '$.database') = ?").bind(to, from),
        db.prepare("UPDATE blocks SET meta = json_set(meta, '$.database', ?) WHERE type = 'db_ref' AND json_valid(meta) AND json_extract(meta, '$.database') = ?").bind(to, from),
      );
    }
    await db.batch(statements);
    return to;
  }

  // Every new data folder seeds the same example pages under random example-<uuid> slugs, so two PCs would otherwise
  // end up with both copies. An untouched, never-synced local example equal in title and text to an incoming one is the
  // same page: it goes to the trash (recoverable, identical content) and is never pushed.
  async function dropDuplicateExample(remote: Remote, touched: Set<string>) {
    if (!remote.slug.startsWith("example-") || remote.deleted || !remote.doc) return;
    const sameText = (d: SyncDoc) => JSON.stringify([d.page.title, d.blocks.map((b) => [b.type, b.text, b.checked, b.indent])]);
    const want = sameText(remote.doc);
    for (const row of await all("SELECT slug FROM pages WHERE slug LIKE 'example-%' AND slug <> ? AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = pages.slug)", remote.slug)) {
      const slug = String(row.slug);
      if (baseOf(slug)) continue;
      const local = await readDoc(slug);
      if (local.doc && sameText(local.doc) === want) { await trash(slug); touched.add(slug); }
    }
  }

  async function receive(incoming: Remote, run: SyncRun, touched: Set<string>) {
    const base = baseOf(incoming.slug);
    if (base && base.seq >= incoming.seq) return;
    for (const c of conflictsIn(incoming.doc)) noteConflict(c, run, false);
    const remote: Remote = { ...incoming, doc: incoming.doc ? content(incoming.doc) : null };
    if (!base) await dropDuplicateExample(remote, touched);
    let local = await readDoc(remote.slug);
    const ld = local.doc, rd = remote.doc;
    if (ld && rd && !remote.deleted && ((ld.database && rd.database && ld.database.id !== rd.database.id) || (ld.row && rd.row && ld.row.id !== rd.row.id))) {
      const moved = await moveAside(ld);
      if (ld.database) noteConflict(newConflict(remote.slug, ld.page.title, moved), run, true);
      touched.add(moved);
      local = await readDoc(remote.slug);
    }
    const localExists = Boolean(local.doc);
    const localHash = local.deleted ? "deleted" : hashOf(local.doc);
    const remoteSide: Side = { deleted: remote.deleted, doc: remote.doc };
    const unchanged = base ? localHash === base.hash || (!localExists && base.deleted === 1) : !localExists || local.deleted;
    if (!unchanged && !remote.deleted && localHash === hashOf(remote.doc)) { setBase(remote.slug, remote.seq, local.doc, false); return; }
    if (unchanged) {
      if (remote.deleted) await trash(remote.slug); else if (remote.doc) await writeDoc(remote.doc);
    } else {
      const merged = mergePage(base ? { deleted: base.deleted === 1, doc: baseDoc(base) } : null, local, remoteSide);
      const title = (merged.doc ?? remote.doc ?? local.doc)?.page.title ?? remote.slug;
      if (merged.copy) { const copy = await conflictCopy(merged.copy); noteConflict(newConflict(remote.slug, title, copy), run, true); touched.add(copy); }
      else if (merged.clash) noteConflict(newConflict(remote.slug, title, null), run, true);
      if (merged.deleted) await trash(remote.slug);
      else if (merged.doc && hashOf(merged.doc) !== localHash) await writeDoc(merged.doc);
      else if (merged.doc && local.deleted) await writeDoc(merged.doc);
    }
    const after = await readDoc(remote.slug);
    if (remote.deleted && (unchanged || after.deleted || !after.doc)) setBase(remote.slug, remote.seq, baseDoc(base) ?? remote.doc, true);
    else setBase(remote.slug, remote.seq, unchanged ? after.doc : remote.doc, false);
    touched.add(remote.slug);
    run.pulled += 1;
  }

  async function pull(run: SyncRun, touched: Set<string>) {
    for (let guard = 0; guard < 1000; guard++) {
      const res = await cloud.call("/api/v1/cloud/sync?since=" + saved.cursor);
      const body = (await res.json().catch(() => ({}))) as { account?: string; cursor?: number; more?: boolean; changes?: Remote[]; error?: string };
      if (!res.ok) throw Object.assign(new Error(body.error === "subscription_required" ? "구독이 필요해요." : body.error || "동기화 서버 오류 (" + res.status + ")"), { status: res.status });
      if (saved.account && body.account && saved.account !== body.account) {
        store.run("DELETE FROM sync_base"); store.run("DELETE FROM sync_media");
        saved.cursor = 0; saved.account = body.account; save();
        continue;
      }
      saved.account = body.account ?? saved.account;
      const rank = (change: Remote) => (change.doc?.page.kind === "db" ? 0 : 1);
      for (const change of (body.changes ?? []).sort((a, b) => rank(a) - rank(b))) await receive(change, run, touched);
      saved.cursor = Number(body.cursor) || saved.cursor;
      save();
      if (!body.more) return;
    }
  }

  async function push(run: SyncRun, touched: Set<string>) {
    for (let round = 0; round < 3; round++) {
      const slugs = new Set([...(await localSlugs()), ...(store.query("SELECT slug FROM sync_base").all() as { slug: string }[]).map((r) => r.slug)]);
      const pending: { slug: string; base: number; deleted: boolean; updated: number; hash: string; doc: SyncDoc | null }[] = [];
      for (const slug of slugs) {
        const base = baseOf(slug);
        const local = await readDoc(slug);
        const deleted = local.deleted || !local.doc;
        if (deleted && (!base || base.deleted === 1)) continue;
        const hash = deleted ? "deleted" : hashOf(local.doc);
        if (base && base.hash === hash && (deleted || !unsentConflict(slug))) continue;
        const conflicts = deleted ? [] : conflictsOf(slug);
        pending.push({ slug, base: base?.seq ?? 0, deleted, updated: local.doc?.page.updated ?? Date.now(), hash, doc: deleted ? null : conflicts.length ? { ...local.doc!, conflicts } : local.doc });
      }
      if (!pending.length) return;
      pending.sort((a, b) => Number(b.doc?.page.kind === "db") - Number(a.doc?.page.kind === "db"));
      let conflicted = false;
      while (pending.length) {
        const batch: typeof pending = [];
        let size = 0;
        while (pending.length && batch.length < SYNC.pushPages && (batch.length === 0 || size + JSON.stringify(pending[0]).length < SYNC.pushBytes)) { size += JSON.stringify(pending[0]).length; batch.push(pending.shift()!); }
        for (const item of batch) if (item.doc) await sendMedia(item.doc);
        const res = await cloud.call("/api/v1/cloud/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: saved.device, changes: batch }) });
        const body = (await res.json().catch(() => ({}))) as { results?: { slug: string; ok?: boolean; seq?: number; conflict?: boolean; current?: Remote | null; error?: string }[]; error?: string };
        if (!res.ok) throw Object.assign(new Error(body.error === "subscription_required" ? "구독이 필요해요." : body.error || "동기화 서버 오류 (" + res.status + ")"), { status: res.status });
        for (const result of body.results ?? []) {
          const item = batch.find((b) => b.slug === result.slug);
          if (!item) continue;
          if (result.ok && typeof result.seq === "number") {
            setBase(item.slug, result.seq, item.deleted ? baseDoc(baseOf(item.slug)) : item.doc && content(item.doc), item.deleted);
            if (item.doc?.conflicts) store.query("UPDATE sync_conflicts SET sent = 1 WHERE sent = 0 AND (slug = ? OR copy = ?)").run(item.slug, item.slug);
            run.pushed += 1;
          }
          else if (result.conflict && result.current) { conflicted = true; await receive(result.current, run, touched); }
        }
      }
      if (!conflicted) return;
    }
  }

  let running: Promise<SyncRun> | null = null;
  async function once(): Promise<SyncRun> {
    const run: SyncRun = { at: Date.now(), pulled: 0, pushed: 0, conflicts: [] };
    const touched = new Set<string>();
    try {
      await options.ready();
      await pull(run, touched);
      await push(run, touched);
    } catch (error) {
      run.error = String((error as Error).message || error);
    }
    if (touched.size) options.notify([...touched]);
    saved.last = run;
    save();
    return run;
  }
  function sync(): Promise<SyncRun | null> {
    if (!saved.enabled || !cloud.enabled || !cloud.status().connected) return Promise.resolve(null);
    if (running) return running;
    running = once().finally(() => { running = null; });
    return running;
  }
  // A run already under way may have read the pages before the latest edits, so an explicit request waits for it and
  // then runs again; requests made during one run share the next one.
  let next: Promise<SyncRun | null> | null = null;
  function syncFresh(): Promise<SyncRun | null> {
    if (!running) return sync();
    next ??= running.catch(() => null).then(() => { next = null; return sync(); });
    return next;
  }

  let soon: ReturnType<typeof setTimeout> | null = null;
  const intervalMs = options.intervalMs ?? SYNC.intervalMs;
  const timer = setInterval(() => { sync().catch(() => {}); }, intervalMs);
  setTimeout(() => { sync().catch(() => {}); }, SYNC.firstMs);

  return {
    sync: syncFresh,
    edited() {
      if (!saved.enabled) return;
      if (soon) clearTimeout(soon);
      soon = setTimeout(() => { soon = null; syncFresh().catch(() => {}); }, SYNC.afterEditMs);
    },
    async setEnabled(on: boolean) {
      saved.enabled = on;
      if (on) saved.last = null;
      save();
      return on ? sync() : null;
    },
    status: () => ({ enabled: saved.enabled, intervalMs, cursor: saved.cursor, last: saved.last, conflicts: saved.conflicts, running: Boolean(running),
      recent: store.query("SELECT slug, title, copy, at FROM sync_conflicts ORDER BY at DESC LIMIT 5").all() as Omit<SyncConflict, "id">[], synced: (store.query("SELECT count(*) AS n FROM sync_base WHERE deleted = 0").get() as { n: number }).n }),
    stop() { clearInterval(timer); if (soon) clearTimeout(soon); store.close(); },
  };
}

export type SyncEngine = ReturnType<typeof startSync>;
