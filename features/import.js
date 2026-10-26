// Import batches (issues 128-131): the browser (or /api/import for a zip up to 30 MB) turns a Notion / Obsidian /
// Acard export into an ImpPlan with the pure modules (import-*.ts, inlined at //__IMPORT_CORE__) and sends it here in
// steps: create (reserve every address) -> files -> chunk (pages, databases, rows) -> finish. Pages of an unfinished batch
// carry editor_trash.permanent = 2, which every list, search and page route already treats as gone and which the trash
// list, restore and permanent delete never touch; finish removes the marker. A batch left unfinished for 30 minutes is
// aborted by the next import request. Each table of a chunk is written with ONE json-array statement, because a member
// workspace counts every INSERT/UPDATE/DELETE statement against 5,000 writes a day (workers/acard-workspace/index.js).
(() => {
  const SCHEMA = [
    "CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, report TEXT)",
    "CREATE TABLE IF NOT EXISTS import_items (batch TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (batch, source, kind))",
    "CREATE INDEX IF NOT EXISTS import_items_source ON import_items(source)",
    "CREATE INDEX IF NOT EXISTS import_items_ref ON import_items(ref)",
    "CREATE TABLE IF NOT EXISTS page_imports (page TEXT PRIMARY KEY, kind TEXT NOT NULL, created INTEGER NOT NULL)",
  ];
  const STALE_MS = 30 * 60 * 1000;
  const IMPORTING = 2;
  const MAX_SOURCES = 60000;
  const CHUNK_BYTES = 2 * 1024 * 1024;
  const ROW_CHUNK = 2000, ROW_CHUNK_BYTES = 1024 * 1024;
  // A file inside a zip has no type of its own; the browser sets one from the name, the /api/import path does it here.
  const EXT_MIME = { pdf: "application/pdf", txt: "text/plain", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg" };
  const KINDS = new Set(["notion-md", "notion-html", "obsidian", "acard", "markdown"]);
  const ready = new WeakSet();

  async function schema(db) {
    if (ready.has(db)) return;
    for (const sql of SCHEMA) await db.prepare(sql).run();
    ready.add(db);
  }

  class ImportError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  const fail = (code, message, status) => { throw new ImportError(code, message, status); };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const sql = (db, sqlite, pg) => (db.dialect === "pg" ? pg : sqlite);
  // One statement that inserts every row of `rows` (arrays in `cols` order) from a JSON parameter.
  function jsonInsert(db, table, cols, rows, tail = "") {
    if (!rows.length) return null;
    const pick = cols.map((col, i) => {
      const [name, kind] = col.split(":");
      const cell = sql(db, "value->>" + i, "x->>" + i);
      return kind === "int" ? sql(db, "CAST(" + cell + " AS INTEGER)", "CAST(" + cell + " AS BIGINT)") : cell;
    });
    const names = cols.map((col) => col.split(":")[0]);
    const from = sql(db, "json_each(?)", "json_array_elements(CAST(? AS json)) AS j(x)");
    return db.prepare("INSERT INTO " + table + " (" + names.join(", ") + ") SELECT " + pick.join(", ") + " FROM " + from + (tail ? " WHERE true " + tail : "")).bind(JSON.stringify(rows));
  }
  function jsonDelete(db, table, column, values) {
    if (!values.length) return null;
    const list = sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))");
    return db.prepare("DELETE FROM " + table + " WHERE " + column + " IN (" + list + ")").bind(JSON.stringify(values));
  }
  const live = (list) => list.filter(Boolean);
  const batchOf = async (db, id) => {
    const row = await db.prepare("SELECT id, kind, name, status, created, updated, report FROM import_batches WHERE id = ?").bind(String(id)).first();
    if (!row) fail("not-found", "가져오기를 찾지 못했어요.", 404);
    return row;
  };
  const itemsOf = async (db, batch, kinds) => ((await db.prepare("SELECT source, kind, ref, state FROM import_items WHERE batch = ?").bind(batch).all()).results ?? []).filter((r) => !kinds || kinds.includes(r.kind));
  const touch = (db, batch, status) => db.prepare("UPDATE import_batches SET status = ?, updated = ? WHERE id = ?").bind(status, Date.now(), batch);

  const slugBase = (title) => slugify(String(title || "").slice(0, 80)) || "page";
  // Which of these slugs are already used (a page, a database, a trashed page or another batch's reservation), 400 per
  // query so a 20,000-row import asks a few dozen times instead of once per page.
  async function usedSlugs(db, slugs) {
    const out = new Set();
    const list = [...new Set(slugs)];
    const inList = sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))");
    for (let i = 0; i < list.length; i += 400) {
      const part = JSON.stringify(list.slice(i, i + 400));
      const rows = (await db.prepare("SELECT slug AS s FROM pages WHERE slug IN (" + inList + ") UNION SELECT slug FROM databases WHERE slug IN (" + inList + ") UNION SELECT page FROM editor_trash WHERE page IN (" + inList + ") UNION SELECT ref FROM import_items WHERE state = 'reserved' AND ref IN (" + inList + ")").bind(part, part, part, part).all()).results ?? [];
      for (const r of rows) out.add(String(r.s));
    }
    return out;
  }
  // used: the preloaded answer for every base slug; only a random suffix after a clash is asked one at a time.
  async function uniqueSlug(db, title, taken, used) {
    const base = slugBase(title);
    for (let n = 0; n < 50; n += 1) {
      const slug = n === 0 ? base : base + "-" + Math.random().toString(36).slice(2, 7);
      if (taken.has(slug) || resolveSlug(slug) !== slug || slug === "index") continue;
      if (n === 0 ? used.has(slug) : (await usedSlugs(db, [slug])).size) continue;
      taken.add(slug);
      return slug;
    }
    fail("conflict", "페이지 주소를 정하지 못했어요. 다시 시도해 주세요.", 409);
  }

  // Everything an unfinished, aborted or swept batch made, removed in one batch of statements per table.
  async function abortBatch(env, db, batch) {
    const items = await itemsOf(db, batch);
    const pages = items.filter((r) => r.kind === "page" || r.kind === "row").map((r) => r.ref);
    const dbs = items.filter((r) => r.kind === "db").map((r) => JSON.parse(r.ref));
    const media = items.filter((r) => r.kind === "media").map((r) => JSON.parse(r.ref));
    const dbIds = dbs.map((d) => d.id), dbSlugs = dbs.map((d) => d.slug);
    const statements = live([
      jsonDelete(db, "blocks", "page", pages.concat(dbSlugs)),
      jsonDelete(db, "links", "src", pages.concat(dbSlugs)),
      jsonDelete(db, "page_tags", "page", pages),
      jsonDelete(db, "page_view", "page", pages),
      jsonDelete(db, "page_imports", "page", pages.concat(dbSlugs)),
      jsonDelete(db, "editor_page_settings", "page", pages.concat(dbSlugs)),
      jsonDelete(db, "db_rows", "database_id", dbIds),
      jsonDelete(db, "db_properties", "database_id", dbIds),
      jsonDelete(db, "db_views", "database_id", dbIds),
      jsonDelete(db, "databases", "id", dbIds),
      jsonDelete(db, "pages", "slug", pages.concat(dbSlugs)),
      jsonDelete(db, "editor_trash", "page", pages.concat(dbSlugs)),
      jsonDelete(db, "media", "id", media.map((m) => m.id)),
      db.prepare("DELETE FROM import_items WHERE batch = ?").bind(batch),
      db.prepare("UPDATE import_batches SET status = 'aborted', updated = ? WHERE id = ?").bind(Date.now(), batch),
    ]);
    await db.batch(statements);
    const store = env[MEDIA_BINDING];
    let freed = 0;
    for (const m of media) {
      if (store) await store.delete("media/" + m.id).catch(() => {});
      freed += Number(m.bytes) || 0;
    }
    if (freed) await releaseMedia(env, freed);
    return { pages: pages.length, databases: dbs.length, media: media.length };
  }

  async function sweep(env, db) {
    const stale = (await db.prepare("SELECT id FROM import_batches WHERE status NOT IN ('done', 'aborted', 'undone') AND updated < ?").bind(Date.now() - STALE_MS).all()).results ?? [];
    for (const row of stale) await abortBatch(env, db, String(row.id));
  }

  // POST /api/import/batches: reserve an address for every page / database / row the plan will write, find what an
  // earlier finished import already brought in (same source), and answer the duplicate question when it is open.
  async function createBatch(env, db, body, url) {
    const format = String(body.format || "");
    if (!KINDS.has(format)) fail("unreadable", "어떤 앱에서 내보낸 파일인지 알아보지 못했어요.");
    const sources = Array.isArray(body.sources) ? body.sources : [];
    if (!sources.length) fail("empty", "가져올 페이지를 찾지 못했어요.");
    if (sources.length > MAX_SOURCES) fail("limit-pages", "한 번에 가져올 수 있는 양을 넘었어요. 나눠서 가져와 주세요.", 413);
    const pageCount = sources.filter((s) => s && s.kind === "page").length;
    const rowCount = sources.filter((s) => s && s.kind === "row").length;
    const dbCount = sources.filter((s) => s && s.kind === "db").length;
    if (rowCount > IMP_LIMITS.rowsPerDatabase * Math.max(1, dbCount)) fail("limit-rows", IMPORT_TEXT["limit-rows"], 413);
    if (pageCount > IMP_LIMITS.pages) fail("limit-pages", "페이지는 한 번에 " + IMP_LIMITS.pages.toLocaleString("en-US") + "개까지 가져올 수 있어요. 나눠서 가져와 주세요.", 413);
    const choice = url.searchParams.get("duplicates");
    const existing = new Map();
    const keys = sources.map((s) => String(s && s.source || "")).filter(Boolean);
    for (let i = 0; i < keys.length; i += 400) {
      const part = keys.slice(i, i + 400);
      const rows = (await db.prepare("SELECT i.source, i.kind, i.ref FROM import_items i JOIN import_batches b ON b.id = i.batch WHERE b.status = 'done' AND i.state = 'done' AND i.source IN (" + sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))") + ")").bind(JSON.stringify(part)).all()).results ?? [];
      for (const row of rows) existing.set(row.kind + ":" + row.source, row.ref);
    }
    // A target that is gone (trashed or deleted) is not a duplicate any more.
    const targets = [...existing].map(([key, ref]) => [key, key.startsWith("db:") ? JSON.parse(ref).slug : ref]);
    const alive = new Set();
    for (let i = 0; i < targets.length; i += 400) {
      const part = JSON.stringify(targets.slice(i, i + 400).map(([, slug]) => slug));
      const rows = (await db.prepare("SELECT p.slug FROM pages p WHERE p.slug IN (" + sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))") + ") AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = p.slug)").bind(part).all()).results ?? [];
      for (const r of rows) alive.add(String(r.slug));
    }
    for (const [key, slug] of targets) if (!alive.has(slug)) existing.delete(key);
    const duplicates = [...existing.keys()].filter((k) => !k.startsWith("media:")).length;
    if (duplicates && choice !== "skip" && choice !== "copy") return reply({ code: "conflict", error: "이미 가져온 페이지가 있어요.", duplicates }, 409);
    const id = "imp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    const taken = new Set();
    const used = await usedSlugs(db, sources.filter((s) => s && typeof s === "object").map((s) => slugBase(s.title)));
    const map = {};
    const items = [];
    for (const raw of sources) {
      if (!raw || typeof raw !== "object") continue;
      const key = String(raw.key || "").slice(0, 600), source = String(raw.source || key).slice(0, 600), kind = String(raw.kind || "");
      if (!key || !["page", "row", "db"].includes(kind)) continue;
      const known = existing.get(kind + ":" + source);
      if (known && choice === "skip") {
        map[key] = kind === "db" ? { ...JSON.parse(known), existing: true } : { slug: known, existing: true };
        continue;
      }
      if (kind === "db") {
        const slug = await uniqueSlug(db, raw.title, taken, used);
        const ref = { id: dbId("d"), slug };
        map[key] = ref;
        items.push([id, source, "db", JSON.stringify(ref), "reserved"]);
      } else {
        const slug = await uniqueSlug(db, raw.title, taken, used);
        map[key] = { slug };
        items.push([id, source, kind, slug, "reserved"]);
      }
    }
    await db.batch(live([
      db.prepare("INSERT INTO import_batches (id, kind, name, status, created, updated, report) VALUES (?, ?, ?, 'open', ?, ?, NULL)").bind(id, format, String(body.name || "import").slice(0, 200), now, now),
      jsonInsert(db, "import_items", ["batch", "source", "kind", "ref", "state"], items),
    ]));
    return reply({ ok: true, id, map, duplicates, skipped: duplicates && choice === "skip" ? duplicates : 0 });
  }

  // POST /api/import/batches/:id/files (multipart: key, file): one attachment, stored like an upload, hidden until finish.
  async function addFile(env, db, batch, request) {
    const store = env[MEDIA_BINDING];
    if (!store) fail("unreadable", "파일 저장소가 연결되지 않았어요.", 503);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > IMP_LIMITS.assetBytes + 64 * 1024) fail("too-big", "파일 하나는 10MB까지 올릴 수 있어요.", 413);
    const form = await request.formData().catch(() => null);
    const file = form ? form.get("file") : null;
    const key = form ? String(form.get("key") || "").slice(0, 600) : "";
    if (!file || typeof file === "string" || !file.size || !key) fail("empty", "올릴 파일이 없어요.");
    if (file.size > IMP_LIMITS.assetBytes) fail("too-big", "파일 하나는 10MB까지 올릴 수 있어요.", 413);
    let bytes = new Uint8Array(await file.arrayBuffer());
    const declaredType = baseMime(file.type);
    const byName = EXT_MIME[String(file.name || key).split(".").pop().toLowerCase()] || "";
    let mime = sniffImage(bytes) || (isSvg(bytes) ? "image/svg+xml" : declaredType && declaredType !== "application/octet-stream" ? declaredType : byName);
    if (!isAllowedMime(mime)) fail("file-type", "이 형식의 파일은 올릴 수 없어요.", 415);
    if (mime === "image/svg+xml") bytes = new TextEncoder().encode(impSanitizeSvg(new TextDecoder().decode(bytes)));
    let name = sanitizeName(file.name || key.split("/").pop());
    let dimensions = imageDimensions(bytes.buffer);
    const compressed = await compressUpload(env, bytes.buffer, mime);
    let stored = bytes.buffer;
    if (compressed) { stored = compressed.bytes; mime = compressed.mime; dimensions = compressed.dimensions; name = webpName(name); }
    try { await reserveMedia(env, db, stored.byteLength); }
    catch (error) { if (error instanceof AgentError) fail("quota", error.message, error.status); throw error; }
    const mediaKey = mediaId();
    const etag = await mediaEtag(stored);
    await store.put("media/" + mediaKey, stored, { metadata: { mime, name, size: stored.byteLength, etag, ...dimensions, source: "import:" + batch } });
    const ref = JSON.stringify({ id: mediaKey, bytes: stored.byteLength });
    await db.batch([
      db.prepare("INSERT INTO media (id, page, name, mime, bytes, created, etag) VALUES (?, NULL, ?, ?, ?, ?, ?)").bind(mediaKey, name, mime, stored.byteLength, Date.now(), etag),
      db.prepare("INSERT INTO import_items (batch, source, kind, ref, state) VALUES (?, ?, 'media', ?, 'reserved') ON CONFLICT (batch, source, kind) DO UPDATE SET ref = excluded.ref").bind(batch, key, ref),
      touch(db, batch, "open"),
    ]);
    return reply({ ok: true, key, url: "/media/" + mediaKey, mime, width: dimensions.width, height: dimensions.height });
  }

  // Swap the plan's placeholders for real addresses, then clean the blocks the same way every page save is cleaned.
  function resolveBlocks(blocks, refs, mediaUrls) {
    const page = (key, heading) => {
      const ref = refs[key];
      if (!ref || !ref.slug) return null;
      return "/" + encodeURIComponent(ref.slug) + "/" + (heading ? "#" + headingSlug(heading) : "");
    };
    const swap = (value) => {
      const parsed = impParseRef(value);
      if (!parsed) return value;
      if (parsed.kind === "asset") return mediaUrls[parsed.key] || "";
      return page(parsed.key, parsed.heading) || "";
    };
    const out = importSyncedBlocks(Array.isArray(blocks) ? blocks : []).map((block) => {
      const next = { ...block, meta: block.meta && typeof block.meta === "object" ? { ...block.meta } : block.meta };
      if (next.meta) {
        for (const field of ["src", "url"]) if (typeof next.meta[field] === "string") next.meta[field] = swap(next.meta[field]);
        if (Array.isArray(next.meta.richText)) next.meta.richText = next.meta.richText.map((run) => {
          if (!run || typeof run !== "object") return run;
          const copy = { ...run };
          if (typeof copy.href === "string") { const href = swap(copy.href); if (href) copy.href = href; else delete copy.href; }
          if (copy.mention && typeof copy.mention.slug === "string" && copy.mention.slug.startsWith(IMP_PAGE)) {
            const ref = refs[impParseRef(copy.mention.slug).key];
            if (ref && ref.slug) copy.mention = { type: "page", slug: ref.slug }; else delete copy.mention;
          }
          return copy;
        });
      }
      return next;
    }).filter((block) => !(block.type === "image" && !(block.meta && block.meta.src)));
    return normaliseBlocks(impSanitizeBlocks(out).blocks);
  }

  // POST /api/import/batches/:id/chunk { pages, databases, rows }: one transaction, a fixed number of statements.
  async function writeChunk(env, db, batch, body) {
    const status = (await batchOf(db, batch)).status;
    if (status !== "open") fail("conflict", "이미 끝났거나 멈춘 가져오기예요.", 409);
    const reserved = await itemsOf(db, batch);
    const refs = {}, mediaUrls = {};
    for (const r of reserved) {
      if (r.kind === "media") mediaUrls[r.source] = "/media/" + JSON.parse(r.ref).id;
    }
    const map = body.map && typeof body.map === "object" ? body.map : {};
    const reservedSlugs = new Set(reserved.filter((r) => r.kind === "page" || r.kind === "row").map((r) => r.ref));
    const reservedDbs = new Map(reserved.filter((r) => r.kind === "db").map((r) => [JSON.parse(r.ref).id, JSON.parse(r.ref)]));
    for (const [key, ref] of Object.entries(map)) refs[key] = ref;
    const now = Date.now();
    const pages = Array.isArray(body.pages) ? body.pages : [];
    const databases = Array.isArray(body.databases) ? body.databases : [];
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (pages.length > IMP_LIMITS.pagesPerChunk + 50) fail("limit-pages", "한 번에 보내는 페이지가 너무 많아요.", 413);
    const pageRows = [], blockRows = [], linkRows = [], trashRows = [], importRows = [], tagRows = [], tagNames = new Set(), viewRows = [], settingRows = [];
    const ownSlug = (key) => {
      const ref = refs[key];
      if (!ref || ref.existing || !ref.slug || !reservedSlugs.has(ref.slug)) return null;
      return ref.slug;
    };
    const parentSlug = (key) => (key && refs[key] && refs[key].slug ? refs[key].slug : null);
    let ord = Number((await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS NULL").first())?.m ?? 0);
    const usedMedia = new Set();
    // Only this batch's own uploads are claimed for its pages; any other /media/ id in a block is left alone.
    const ownMedia = new Set(reserved.filter((r) => r.kind === "media").map((r) => JSON.parse(r.ref).id));
    for (const raw of pages) {
      const slug = ownSlug(raw && raw.key);
      if (!slug) continue;
      const kind = raw.kind === "db_row" ? "db_row" : "note";
      const resolved = resolveBlocks(raw.blocks, refs, mediaUrls);
      const blocks = resolved.length ? resolved : normaliseBlocks([{ id: "b1", type: "paragraph", text: "" }]);
      for (const b of blocks) for (const field of ["src", "url"]) { const m = /^\/media\/([0-9a-f]{16})$/.exec(String(b.meta && b.meta[field] || "")); if (m && ownMedia.has(m[1])) usedMedia.add(m[1] + "|" + slug); }
      ord += 10;
      pageRows.push([slug, String(raw.title || "제목 없음").slice(0, 200), parentSlug(raw.parent), ord, kind, now]);
      blocks.forEach((block, index) => blockRows.push([slug, block.id, index, block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null]));
      for (const dst of linksOf(blocks)) linkRows.push([slug, dst]);
      trashRows.push([slug, now]);
      importRows.push([slug, now]);
      for (const tag of Array.isArray(raw.tags) ? raw.tags.slice(0, 40) : []) {
        const name = String(tag).trim().slice(0, 60);
        if (name) { tagRows.push([slug, name]); tagNames.add(name); }
      }
      if (raw.kind === "folder") viewRows.push([slug, now]);
      if (typeof raw.icon === "string" && raw.icon && [...raw.icon].length <= 8) settingRows.push([slug, raw.icon]);
    }
    const dbRows = [], propRows = [], dbViewRows = [], dbPageRows = [], dbItems = [];
    for (const raw of databases) {
      const ref = refs[raw && raw.key];
      if (!ref || ref.existing || !reservedDbs.has(ref.id)) continue;
      ord += 10;
      const title = String(raw.title || "데이터베이스").slice(0, 200);
      dbRows.push([ref.id, ref.slug, title, parentSlug(raw.parent), ord, now]);
      dbPageRows.push([ref.slug, title, parentSlug(raw.parent), ord, now]);
      trashRows.push([ref.slug, now]);
      importRows.push([ref.slug, now]);
      (Array.isArray(raw.properties) ? raw.properties : []).forEach((p, index) => {
        const prop = normaliseProperty(Object.assign({}, p, { type: index === 0 ? "title" : p.type }), index);
        const config = Object.assign({}, prop.config);
        if (prop.type === "relation") {
          const target = refs[config.database] || refs[p.config && p.config.targetKey];
          Object.assign(config, { database: target && target.slug ? target.slug : "", synced: false, pair: "" });
        }
        propRows.push([scopedId(ref.id, prop.id), ref.id, prop.name, prop.type, JSON.stringify(config), index * 10, prop.width ?? null, 0]);
      });
      dbViewRows.push([scopedId(ref.id, "table"), ref.id, "표", "table", JSON.stringify({ filter: null, sorts: [], group_by: null, visible: null, widths: {}, calculations: {} }), 0]);
      dbItems.push(ref.id);
    }
    const rowRows = [];
    for (const raw of rows) {
      const ref = refs[raw && raw.database];
      if (!ref || ref.existing || !reservedDbs.has(ref.id)) continue;
      const pageSlug = ownSlug(raw.page);
      const props = {};
      for (const [k, v] of Object.entries(raw.values && typeof raw.values === "object" ? raw.values : {})) {
        props[scopedId(ref.id, k)] = Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && "database" in x)
          ? v.map((x) => refs[x.database] && refs[x.database].id ? scopedId(refs[x.database].id, "r" + x.index) : null).filter(Boolean)
          : v;
      }
      rowRows.push([scopedId(ref.id, "r" + String(raw.index ?? rowRows.length)), ref.id, pageSlug, JSON.stringify(props), (Number(raw.index) || rowRows.length) * 10, now, now]);
    }
    const fromJson = sql(db, "json_each(?)", "json_array_elements(CAST(? AS json)) AS j(x)");
    const c = (i, int) => (int ? sql(db, "CAST(value->>" + i + " AS INTEGER)", "CAST(x->>" + i + " AS BIGINT)") : sql(db, "value->>" + i, "x->>" + i));
    const allPages = pageRows.concat(dbPageRows.map((r) => [r[0], r[1], r[2], r[3], "db", r[4]]));
    const mediaPairs = [...usedMedia].map((v) => v.split("|"));
    const statements = live([
      trashRows.length ? db.prepare("INSERT INTO editor_trash (page, deleted, permanent) SELECT " + c(0) + ", " + c(1, true) + ", " + IMPORTING + " FROM " + fromJson).bind(JSON.stringify(trashRows)) : null,
      allPages.length ? db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) SELECT " + [c(0), c(1), c(2), c(3, true), c(4), c(5, true)].join(", ") + ", 'editor', NULL FROM " + fromJson).bind(JSON.stringify(allPages)) : null,
      jsonInsert(db, "blocks", ["page", "id", "ord:int", "type", "text", "checked:int", "indent:int", "meta"], blockRows),
      jsonInsert(db, "links", ["src", "dst"], linkRows, "ON CONFLICT DO NOTHING"),
      jsonInsert(db, "page_imports", ["page", "kind", "created:int"], importRows.map(([page, at]) => [page, "zip", at]), "ON CONFLICT (page) DO NOTHING"),
      jsonInsert(db, "databases", ["id", "slug", "title", "parent", "ord:int", "created:int"], dbRows),
      jsonInsert(db, "db_properties", ["id", "database_id", "name", "type", "config", "ord:int", "width:int", "hidden:int"], propRows),
      jsonInsert(db, "db_views", ["id", "database_id", "name", "type", "config", "ord:int"], dbViewRows),
      jsonInsert(db, "db_rows", ["id", "database_id", "page", "props", "ord:int", "created:int", "updated:int"], rowRows),
      jsonInsert(db, "page_tags", ["page", "tag"], tagRows, "ON CONFLICT DO NOTHING"),
      jsonInsert(db, "tags", ["name", "created:int"], [...tagNames].map((name) => [name, now]), "ON CONFLICT DO NOTHING"),
      jsonInsert(db, "page_view", ["page", "mode", "updated:int"], viewRows.map(([page, at]) => [page, "folder", at]), "ON CONFLICT (page) DO NOTHING"),
      jsonInsert(db, "editor_page_settings", ["page", "icon"], settingRows, "ON CONFLICT (page) DO NOTHING"),
      mediaPairs.length ? db.prepare("UPDATE media SET page = (SELECT " + c(1) + " FROM " + fromJson + " WHERE " + c(0) + " = media.id) WHERE page IS NULL AND id IN (SELECT " + c(0) + " FROM " + fromJson + ")").bind(JSON.stringify(mediaPairs), JSON.stringify(mediaPairs)) : null,
      touch(db, batch, "open"),
    ]);
    if (typeof db.script === "function") await db.script(statements);
    else await db.batch(statements);
    return reply({ ok: true, pages: pageRows.length, databases: dbRows.length, rows: rowRows.length, statements: statements.length });
  }

  // POST /api/import/batches/:id/finish { report }: reveal the pages, drop uploads no page uses, keep the report.
  async function finishBatch(env, db, batch, body) {
    const row = await batchOf(db, batch);
    if (row.status !== "open") fail("conflict", "이미 끝났거나 멈춘 가져오기예요.", 409);
    const items = await itemsOf(db, batch);
    const pages = items.filter((r) => r.kind === "page" || r.kind === "row").map((r) => r.ref);
    const dbSlugs = items.filter((r) => r.kind === "db").map((r) => JSON.parse(r.ref).slug);
    const media = items.filter((r) => r.kind === "media").map((r) => JSON.parse(r.ref));
    const written = new Set(((await db.prepare("SELECT slug FROM pages WHERE slug IN (" + sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))") + ")").bind(JSON.stringify(pages.concat(dbSlugs))).all()).results ?? []).map((r) => String(r.slug)));
    const unused = [];
    for (const m of media) {
      const owner = await db.prepare("SELECT page FROM media WHERE id = ?").bind(m.id).first();
      if (!owner || !owner.page) unused.push(m);
    }
    const report = body && body.report && typeof body.report === "object" ? body.report : {};
    const statements = live([
      db.prepare("DELETE FROM editor_trash WHERE permanent = " + IMPORTING + " AND page IN (" + sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))") + ")").bind(JSON.stringify([...written])),
      db.prepare("UPDATE import_items SET state = 'done' WHERE batch = ? AND kind <> 'media'").bind(batch),
      db.prepare("UPDATE import_items SET state = 'done' WHERE batch = ? AND kind = 'media'").bind(batch),
      jsonDelete(db, "media", "id", unused.map((m) => m.id)),
      jsonDelete(db, "import_items", "ref", unused.map((m) => JSON.stringify(m))),
      jsonDelete(db, "import_items", "ref", pages.concat(dbSlugs).filter((s) => !written.has(s))),
      db.prepare("UPDATE import_batches SET status = 'done', updated = ?, report = ? WHERE id = ?").bind(Date.now(), JSON.stringify({ ...report, pagesWritten: written.size, unusedFiles: unused.length }).slice(0, 200000), batch),
    ]);
    await db.batch(statements);
    const store = env[MEDIA_BINDING];
    let freed = 0;
    for (const m of unused) { if (store) await store.delete("media/" + m.id).catch(() => {}); freed += Number(m.bytes) || 0; }
    if (freed) await releaseMedia(env, freed);
    if (ACARD_FEATURES.services.searchIndexMany && written.size) {
      const visible = [...written];
      const rows = [];
      for (let i = 0; i < visible.length; i += 400) {
        const part = visible.slice(i, i + 400);
        const found = (await db.prepare("SELECT p.slug, p.title, COALESCE((SELECT " + sql(db, "group_concat(text, char(10))", "string_agg(text, E'\\n' ORDER BY ord)") + " FROM " + sql(db, "(SELECT text FROM blocks WHERE page = p.slug ORDER BY ord)", "blocks WHERE page = p.slug") + "), '') AS body FROM pages p WHERE p.slug IN (" + sql(db, "SELECT value FROM json_each(?)", "SELECT json_array_elements_text(CAST(? AS json))") + ")").bind(JSON.stringify(part)).all()).results ?? [];
        rows.push(...found.map((r) => ({ slug: String(r.slug), title: String(r.title || ""), body: String(r.body || "") })));
      }
      await ACARD_FEATURES.services.searchIndexMany(db, rows);
    }
    const first = pages.find((s) => written.has(s)) || dbSlugs.find((s) => written.has(s)) || null;
    return reply({ ok: true, id: batch, pages: written.size, first, unusedFiles: unused.length });
  }

  // POST /api/import/batches/:id/undo: every page of the batch to the trash (one group, so restore brings it back).
  async function undoBatch(env, db, batch) {
    const row = await batchOf(db, batch);
    if (row.status !== "done") fail("conflict", "끝난 가져오기만 되돌릴 수 있어요.", 409);
    const items = await itemsOf(db, batch);
    const slugs = items.filter((r) => r.kind === "page" || r.kind === "row").map((r) => r.ref).concat(items.filter((r) => r.kind === "db").map((r) => JSON.parse(r.ref).slug));
    const now = Date.now();
    await db.batch(live([
      slugs.length ? db.prepare("INSERT INTO editor_trash (page, deleted, permanent) SELECT " + sql(db, "value, ?, 0 FROM json_each(?)", "x, ?, 0 FROM json_array_elements_text(CAST(? AS json)) AS j(x)") + " WHERE NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = " + sql(db, "value", "x") + ")").bind(now, JSON.stringify(slugs)) : null,
      db.prepare("UPDATE import_items SET state = 'undone' WHERE batch = ?").bind(batch),
      db.prepare("UPDATE import_batches SET status = 'undone', updated = ? WHERE id = ?").bind(now, batch),
    ]));
    return reply({ ok: true, id: batch, trashed: slugs.length });
  }

  // POST /api/import (raw zip up to 30 MB): the whole flow on the server, for the API, MCP, the local edition and tests.
  async function importZipRequest(request, env, db) {
    if (db.acardRoles) return reply({ code: "forbidden", error: "가져오기는 작업 공간 주인만 할 수 있어요." }, 403);
    await schema(db);
    await sweep(env, db);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > IMP_LIMITS.requestBytes) return reply({ code: "too-big", error: "압축 파일이 30MB보다 커요. 가져오기 화면에서 올려 주세요(500MB까지)." }, 413);
    const buffer = await request.arrayBuffer().catch(() => null);
    if (!buffer || !buffer.byteLength) return reply({ code: "empty", error: "압축 파일이 비어 있어요." }, 400);
    if (buffer.byteLength > IMP_LIMITS.requestBytes) return reply({ code: "too-big", error: "압축 파일이 30MB보다 커요. 가져오기 화면에서 올려 주세요(500MB까지)." }, 413);
    const url = new URL(request.url);
    let plan;
    try {
      const read = await impReadZip(new Uint8Array(buffer));
      const entries = await impReadNested(read.entries, IMP_LIMITS, read.skipped);
      plan = await impPlanFor(entries, { name: url.searchParams.get("name") || "import" });
      plan.skipped = read.skipped.concat(plan.skipped);
    } catch (error) {
      const code = error && error.code ? String(error.code) : "corrupt";
      return reply({ code, error: IMPORT_TEXT[code] || IMPORT_TEXT.corrupt }, code === "too-big" || code === "too-many" ? 413 : 400);
    }
    if (!plan.pages.length && !plan.databases.length) return reply({ code: "empty", error: IMPORT_TEXT.empty, skipped: plan.skipped.slice(0, 40) }, 400);
    let batch = null;
    try {
      const created = await createBatch(env, db, { format: plan.format, name: plan.name, sources: planSources(plan) }, url);
      const createdBody = await created.clone().json();
      if (created.status !== 200) return created;
      batch = createdBody.id;
      const map = keyMap(plan, createdBody.map);
      for (const asset of plan.assets) {
        if (!plan.pages.some((p) => JSON.stringify(p.blocks).includes(IMP_ASSET + asset.key))) continue;
        const bytes = await asset.read();
        if (bytes.length > IMP_LIMITS.assetBytes) { plan.skipped.push({ path: asset.path, code: "too-big" }); continue; }
        const form = new FormData();
        form.append("key", asset.key);
        form.append("file", new File([bytes], asset.name, { type: EXT_MIME[String(asset.name).split(".").pop().toLowerCase()] || "" }));
        const res = await addFile(env, db, batch, new Request("https://import.local/", { method: "POST", body: form })).catch((error) => error);
        if (res instanceof ImportError) { plan.skipped.push({ path: asset.path, code: res.code }); continue; }
        if (res instanceof Error) throw res;
      }
      for (const chunk of planChunks(plan)) await writeChunk(env, db, batch, { ...chunk, map });
      const done = await (await finishBatch(env, db, batch, { report: { counts: plan.counts, skipped: plan.skipped.slice(0, 500) } })).json();
      const pages = plan.pages.map((p) => ({ title: p.title, slug: map[p.key] && map[p.key].slug, kind: p.kind })).filter((p) => p.slug);
      return reply({ ok: true, batch, imported: done.pages, first: done.first, pages: pages.slice(0, 400), counts: plan.counts, skipped: plan.skipped.slice(0, 200), duplicates: createdBody.duplicates || 0, warnings: [] });
    } catch (error) {
      if (batch) await abortBatch(env, db, batch).catch((e) => console.error("import abort failed", String(e)));
      if (error instanceof ImportError) return reply({ code: error.code, error: error.message }, error.status);
      if (error instanceof AgentError) return reply({ code: error.status === 507 ? "quota" : "too-big", error: error.message }, error.status);
      throw error;
    }
  }

  function planSources(plan) {
    return [
      ...plan.pages.map((p) => ({ key: p.key, source: p.source, kind: p.kind === "db_row" ? "row" : "page", title: p.title })),
      ...plan.databases.map((d) => ({ key: d.key, source: d.source, kind: "db", title: d.title })),
    ];
  }
  function keyMap(plan, map) {
    return map && typeof map === "object" ? map : {};
  }
  // Pages in parent-first order, at most IMP_LIMITS.pagesPerChunk per chunk and about CHUNK_BYTES of JSON; databases and
  // their rows travel with the chunk that holds the database's first row page (or the first chunk).
  function planChunks(plan) {
    const order = [];
    const byKey = new Map(plan.pages.map((p) => [p.key, p]));
    const seen = new Set();
    const visit = (p) => { if (seen.has(p.key)) return; seen.add(p.key); if (p.parent && byKey.has(p.parent)) visit(byKey.get(p.parent)); order.push(p); };
    plan.pages.forEach(visit);
    const chunks = [];
    let cur = { pages: [], databases: [], rows: [] }, size = 0;
    for (const p of order) {
      const len = JSON.stringify(p.blocks).length + 200;
      if (cur.pages.length && (cur.pages.length >= IMP_LIMITS.pagesPerChunk || size + len > CHUNK_BYTES)) { chunks.push(cur); cur = { pages: [], databases: [], rows: [] }; size = 0; }
      cur.pages.push({ key: p.key, title: p.title, parent: p.parent, kind: p.kind, blocks: p.blocks, tags: p.tags, icon: p.icon });
      size += len;
    }
    chunks.push(cur);
    chunks[0].databases = plan.databases.map((d) => ({ key: d.key, title: d.title, parent: d.parent, properties: d.properties }));
    const rowAt = new Map();
    plan.databases.forEach((d) => d.rows.forEach((r, index) => rowAt.set(r.page, { database: d.key, index: index + 1 })));
    // Rows go after every page in chunks of their own (a 20,000-row table is ~12 MB of JSON, over the store's 2 MB string
    // limit in one statement): at most ROW_CHUNK rows and ROW_CHUNK_BYTES of JSON each.
    let rowChunk = null, rowSize = 0;
    for (const d of plan.databases) d.rows.forEach((r, index) => {
      const row = { database: d.key, page: r.page, index: index + 1, values: rowValues(d, r, rowAt) };
      const len = JSON.stringify(row).length;
      if (!rowChunk || rowChunk.rows.length >= ROW_CHUNK || rowSize + len > ROW_CHUNK_BYTES) { rowChunk = { pages: [], databases: [], rows: [] }; rowSize = 0; chunks.push(rowChunk); }
      rowChunk.rows.push(row);
      rowSize += len;
    });
    return chunks;
  }
  function rowValues(database, row, rowAt) {
    const out = {};
    for (const prop of database.properties) {
      let value = row.values[prop.id];
      if (value === undefined) continue;
      if ((prop.type === "select" || prop.type === "status") && prop.config && Array.isArray(prop.config.options)) {
        const option = prop.config.options.find((o) => o.name === value);
        value = option ? option.id : null;
      } else if (prop.type === "relation") {
        value = (Array.isArray(value) ? value : []).map((key) => rowAt.get(key)).filter(Boolean);
      } else if (prop.type === "multi_select" && prop.config && Array.isArray(prop.config.options)) {
        value = (Array.isArray(value) ? value : []).map((name) => (prop.config.options.find((o) => o.name === name) || {}).id).filter(Boolean);
      }
      out[prop.id] = value;
    }
    return out;
  }

  const IMPORT_TEXT = {
    empty: "가져올 페이지를 찾지 못했어요. 노션에서 내보낸 zip이나 옵시디언 볼트인지 확인해 주세요.",
    corrupt: "압축 파일이 손상됐어요. 다시 내보내서 올려 주세요.",
    "too-big": "파일이 너무 커요. 한 번에 500MB까지 가져올 수 있어요.",
    "too-many": "파일이 너무 많아요. 나눠서 가져와 주세요.",
    "limit-rows": "표 하나에는 20,000행까지 가져올 수 있어요. 나눠서 가져와 주세요.",
    unreadable: "이 압축 방식은 읽을 수 없어요. 다시 내보내서 올려 주세요.",
    bomb: "압축을 풀면 너무 커지는 파일이 있어서 멈췄어요.",
  };

  registerFeature({
    schema,
    services: { importZipRequest, importSweep: sweep },
    api: async ({ path, method, request, env, db, url }) => {
      const m = /^\/api\/import\/batches(?:\/([A-Za-z0-9]{4,40})(?:\/(files|chunk|finish|abort|undo))?)?\/?$/.exec(path);
      if (!m) return null;
      if (db.acardRoles) return reply({ code: "forbidden", error: "가져오기는 작업 공간 주인만 할 수 있어요." }, 403);
      try {
        await schema(db);
        await sweep(env, db);
        const [, id, action] = m;
        if (!id && method === "POST") {
          const body = await request.json().catch(() => null);
          if (!body || typeof body !== "object") fail("empty", "가져올 내용이 없어요.");
          return await createBatch(env, db, body, url);
        }
        if (id && !action && method === "GET") {
          const row = await batchOf(db, id);
          return reply({ id: row.id, kind: row.kind, name: row.name, status: row.status, created: Number(row.created), report: parseJson(row.report, null) });
        }
        if (id && method === "POST") {
          if (action === "files") return await addFile(env, db, (await batchOf(db, id)).id, request);
          if (action === "chunk") {
            if (Number(request.headers.get("content-length") ?? 0) > CHUNK_BYTES + 512 * 1024) fail("too-big", "한 번에 보내는 양이 너무 커요.", 413);
            return await writeChunk(env, db, id, (await request.json().catch(() => null)) || {});
          }
          if (action === "finish") return await finishBatch(env, db, id, (await request.json().catch(() => null)) || {});
          if (action === "abort") {
            // A finished import goes back only through undo (into the trash); abort removes an unfinished one.
            const row = await batchOf(db, id);
            if (row.status === "done" || row.status === "undone") fail("conflict", "이미 끝난 가져오기예요. 되돌리기를 써 주세요.", 409);
            return reply({ ok: true, ...(await abortBatch(env, db, id)) });
          }
          if (action === "undo") return await undoBatch(env, db, id);
        }
        return reply({ code: "not-found", error: "없는 주소예요." }, 404);
      } catch (error) {
        if (error instanceof ImportError) return reply({ code: error.code, error: error.message }, error.status);
        throw error;
      }
    },
  });
})();
