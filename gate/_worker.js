// 보안 계약: GATE_PASSWORD 와 GATE_SECRET 가 Pages 프로젝트의 production 과 preview 양쪽에
// 설정돼 있어야 하고, 하나라도 없으면 정적 파일을 전혀 내주지 않는다(fail closed).
// 게이트를 통과한 쿠키 하나가 곧 API 인가다. 새 인증 경로를 만들지 않는다.

const COOKIE_NAME = "dn_auth";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
const DB_BINDING = "DB";

const ACARD_FEATURES = { api: [], agentApi: [], afterSave: [], beforeRowWrite: [], schema: [], services: {}, publicRoutes: [], authenticatedRoutes: [], agentOps: Object.create(null) };

function registerFeature(def) {
  for (const hook of ["api", "agentApi", "afterSave", "beforeRowWrite", "schema", "publicRoutes", "authenticatedRoutes"]) {
    if (def[hook]) ACARD_FEATURES[hook].push(...[].concat(def[hook]));
  }
  const { mcpTools, ...services } = def.services || {};
  Object.assign(ACARD_FEATURES.services, services);
  if (mcpTools) (ACARD_FEATURES.services.mcpTools ||= []).push(...mcpTools);
  Object.assign(ACARD_FEATURES.agentOps, def.agentOps);
}

function featureContext(request, env, db, url) {
  return {
    request, env, db, url, path: url.pathname, method: request.method.toUpperCase(),
    helpers: { json, readPage, readTree, saveBlocks, normaliseBlocks, slugify, resolveSlug, markdownToBlocks, blocksToMarkdown, readDatabase, escapeHtml },
  };
}

function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function sign(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function hasValidTicket(request, secret) {
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) return false;
  const dot = raw.indexOf(".");
  if (dot < 1) return false;
  const expires = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!/^\d+$/.test(expires)) return false;
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  return constantTimeEqual(signature, await sign(secret, expires));
}

function safeNext(value) {
  if (typeof value !== "string") return "/";
  // A backslash or control character turns "/\evil.test" into "//evil.test" in browsers.
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  return value;
}

// 홈은 notes/home.md 이고 슬러그는 index 다. 오너가 /home/ 이나 /edit/home/ 을 쳐도 열리게 맞춰 준다.
function resolveSlug(slug) {
  return slug === "home" ? "index" : slug;
}

// #39: agents and people hand over a page as the address they see (https://notes.example.com/%EC%.../, /edit/<slug>/, a trailing
// slash, NFD Hangul from a copied path); stored slugs are plain NFC text without "%" or "/", so this maps every such form back.
function pageRef(raw) {
  let ref = String(raw ?? "").trim();
  if (/^https?:\/\//i.test(ref)) { try { ref = new URL(ref).pathname; } catch {} }
  ref = ref.replace(/[?#].*$/, "").replace(/^\/+(?:(?:edit|print)\/+)?/, "").replace(/\/+$/, "");
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(ref); i += 1) { try { ref = decodeURIComponent(ref); } catch { break; } }
  return resolveSlug(ref.normalize("NFC") || "index");
}

const PAGE_REF_KEYS = ["slug", "page", "parent"];
function pageRefs(input) {
  if (!input || typeof input !== "object") return input;
  const out = { ...input };
  for (const key of PAGE_REF_KEYS) if (typeof out[key] === "string" && out[key].trim()) out[key] = pageRef(out[key]);
  return out;
}

// #39: an agent connection belongs to one workspace. A page the person sees in another workspace (their personal one while
// the agent writes to admin, or the reverse) is not in this one, so the plain "없는 페이지예요." sent agents into retries and
// made people think the page was gone. The 404 now says which page was asked for, that it is not in this connection's
// workspace, and lists close titles so the agent can pick the right slug or tell the person to reconnect.
async function missingPageHint(db, error, slug) {
  if (!(error instanceof AgentError) || error.status !== 404 || !/없는 페이지/.test(error.message) || !slug) return error;
  const word = slug.split("-").filter((part) => part.length > 1).sort((a, b) => b.length - a.length)[0] || slug;
  const rows = await db.prepare("SELECT p.slug, p.title FROM pages p WHERE p.kind != 'db_row' AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = p.slug) AND (p.slug LIKE ? OR p.title LIKE ?) ORDER BY p.updated DESC LIMIT 5")
    .bind("%" + word + "%", "%" + word + "%").all().catch(() => ({ results: [] }));
  const near = (rows.results ?? []).map((row) => row.slug + " (" + row.title + ")");
  const trashed = await db.prepare("SELECT page FROM editor_trash WHERE page = ?").bind(slug).first().catch(() => null);
  const message = trashed
    ? "없는 페이지예요. '" + slug + "' 페이지는 휴지통에 있어요. 사람에게 복원할지 물어보세요."
    : "없는 페이지예요. '" + slug + "' 페이지가 이 연결의 워크스페이스에 없어요. 사람이 다른 워크스페이스(개인/팀)에서 보고 있는 페이지일 수 있어요. 새로 만들지 말고 list_pages 로 확인하거나, 그 워크스페이스로 다시 연결해 달라고 알려 주세요."
      + (near.length ? " 비슷한 페이지: " + near.join(", ") : "");
  return Object.assign(new AgentError(message, 404), { cause: error });
}

//__EQUATION_HTML__

//__BLOCK_HTML__
//__DB_MODEL__
//__DB_FORMULA__
//__DB_HTML__
//__EDITOR_PAGES__
//__AGENT_API__

//__MARKDOWN_BLOCKS__

//__NOTION_IMPORT__

//__NOTION_EXPORT__

//__IMPORT_CORE__

function loginPage(message, next) {
  return [
    "<!doctype html>",
    '<html lang="ko"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="robots" content="noindex, nofollow">',
    "<title>__SITE_NAME__</title>",
    '<meta name="application-name" content="__SITE_NAME__">',
    '<meta property="og:site_name" content="__SITE_NAME__">',
    '<link rel="icon" href="__GATE_LOGO__" type="image/svg+xml">',
    "<style>",
    ":root{color-scheme:light dark;--bg:#f8f8fa;--surface:#ffffff;--fg:#26252c;--dim:#6c6a76;--line:#ececf0;--accent:#7b68ee;--on:#fff;--field:#f6f6f8}",
    "body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);",
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;',
    "font-size:var(--fs-17,17px);line-height:1.9;word-break:keep-all}",
    "main{box-sizing:border-box;width:min(92vw,420px);padding:36px;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 32px rgba(30,28,50,.08)}",
    "h1{font-size:var(--fs-28,28px);letter-spacing:-.04em;margin:0 0 12px}",
    "p{color:var(--dim);font-size:var(--fs-15,15px);margin:0 0 24px}",
    "form{display:flex;flex-direction:column;gap:10px}",
    "input{height:48px;padding:0 15px;font:inherit;font-size:var(--fs-16,16px);color:var(--fg);background:var(--field);",
    "border:1px solid var(--line);border-radius:10px}",
    "input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}",
    "button{height:48px;font:inherit;font-size:var(--fs-16,16px);font-weight:600;color:var(--on);background:var(--accent);",
    "border:0;border-radius:10px;cursor:pointer}",
    ".msg{color:var(--accent);font-size:var(--fs-14,14px);margin:0 0 10px}",
    "@media (prefers-color-scheme:dark){:root{--bg:#1b1b20;--surface:#212127;--fg:#ecebf2;--dim:#a3a1ad;--line:#31313a;--accent:#a597ff;--on:#16131f;--field:#26262d}}",
    "</style></head><body><main>",
    '<img src="__GATE_LOGO__" alt="" width="56" height="56">',
    "<h1>__SITE_NAME__</h1>",
    "<p>오너 전용 노트예요. 비밀번호를 넣어 주세요.</p>",
    message ? '<p class="msg">' + escapeHtml(message) + "</p>" : "",
    '<form method="POST" action="/__gate">',
    '<input type="hidden" name="next" value="' + escapeHtml(next) + '">',
    '<input type="password" name="pw" placeholder="비밀번호" autocomplete="current-password" autofocus required>',
    "<button type=\"submit\">들어가기</button>",
    "</form></main></body></html>",
  ].join("\n");
}

function challenge(message, next, status) {
  return new Response(loginPage(message, next), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-dori-gate": "1",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "page";
}

const schemaReady = new Map();

async function ensureSchema(db) {
  const key = (db && db.acardKey) || "d1";
  if (schemaReady.has(key)) return schemaReady.get(key);
  const ready = createSchema(db);
  schemaReady.set(key, ready);
  try { await ready; } catch (error) { schemaReady.delete(key); throw error; }
}

// The bundle entry (gate/agent-entry.ts) authenticates the person and hands over an env scoped to one workspace.
// Only env objects it registered here skip the password gate; a plain Pages env never does.
const TRUSTED_ENVS = new WeakSet();
const isMember = (env) => TRUSTED_ENVS.has(env) && env.ACARD_SESSION === "member";
const isGuest = (env) => TRUSTED_ENVS.has(env) && env.ACARD_SESSION === "guest";
// A guest's view DB (features/share.js) carries the set of pages the resolver lets it read.
const visibleOnly = (db, rows, key = "slug") => (db && db.acardVisible ? rows.filter((row) => db.acardVisible.has(String(row[key]))) : rows);

async function createSchema(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, parent TEXT, ord INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'note', updated INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'editor', hash TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS blocks (page TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0, indent INTEGER NOT NULL DEFAULT 0, meta TEXT, PRIMARY KEY (page, id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst))"),
    db.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS blocks_page_ord ON blocks(page, ord)"),
    db.prepare("CREATE INDEX IF NOT EXISTS pages_parent_ord ON pages(parent, ord)"),
    db.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, page TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS link_cache (url TEXT PRIMARY KEY, title TEXT, description TEXT, image TEXT, site TEXT, created INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS media_page ON media(page)"),
    db.prepare("CREATE TABLE IF NOT EXISTS databases (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', parent TEXT, ord INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS db_properties (id TEXT PRIMARY KEY, database_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'text', config TEXT, ord INTEGER NOT NULL DEFAULT 0, width INTEGER, hidden INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS db_rows (id TEXT PRIMARY KEY, database_id TEXT NOT NULL, page TEXT, props TEXT, ord INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS db_views (id TEXT PRIMARY KEY, database_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'table', config TEXT, ord INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS db_templates (id TEXT PRIMARY KEY, database_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', props TEXT, blocks TEXT, ord INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE INDEX IF NOT EXISTS db_properties_database_ord ON db_properties(database_id, ord)"),
    db.prepare("CREATE INDEX IF NOT EXISTS db_rows_database_ord ON db_rows(database_id, ord)"),
    db.prepare("CREATE INDEX IF NOT EXISTS db_views_database_ord ON db_views(database_id, ord)"),
    db.prepare("CREATE INDEX IF NOT EXISTS db_templates_database_ord ON db_templates(database_id, ord)"),
    db.prepare("CREATE INDEX IF NOT EXISTS databases_slug ON databases(slug)"),
    // 양방향 관계(C2): 연결의 정본은 이 표, 행 JSON 의 관계 값은 여기서 다시 만든 캐시다. 한 연결 = 양쪽 방향 두 줄.
    db.prepare("CREATE TABLE IF NOT EXISTS db_relation_links (prop_id TEXT NOT NULL, src_row TEXT NOT NULL, dst_row TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (prop_id, src_row, dst_row))"),
    db.prepare("CREATE INDEX IF NOT EXISTS db_relation_links_dst ON db_relation_links(dst_row)"),
    // 관계 쌍마다 한 줄: 값을 바꾸는 batch 의 첫 문장이 이 줄을 UPDATE 해 같은 쌍의 다른 batch 를 기다리게 한다(PostgreSQL 행 잠금).
    db.prepare("CREATE TABLE IF NOT EXISTS db_relation_locks (pair_key TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS db_counters (property_id TEXT PRIMARY KEY, next INTEGER NOT NULL DEFAULT 1)"),
    db.prepare("CREATE TABLE IF NOT EXISTS db_template_runs (template_id TEXT NOT NULL, occurrence INTEGER NOT NULL, row_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (template_id, occurrence))"),
    // #86: 속성을 관계로 바꿀 때 링크로 바꾸지 않은 예전 값(행 셀·템플릿 값). kind = row | template, ref = 행 id 또는 템플릿 id.
    db.prepare("CREATE TABLE IF NOT EXISTS db_value_backups (id TEXT PRIMARY KEY, database_id TEXT NOT NULL, prop_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS db_value_backups_database ON db_value_backups(database_id, prop_id)"),
    // #86: 템플릿 값을 마지막으로 저장한 사람(kind owner | guest | legacy). 손님은 공유 세션(token_hash)·이메일과 저장할 때 편집할 수
    // 있던 페이지(roles, {slug: edit|full}). blocked 는 연결 직전 권한 검사가 멈춘 이유(값을 다시 저장할 때까지 그대로).
    db.prepare("CREATE TABLE IF NOT EXISTS db_template_savers (template_id TEXT PRIMARY KEY, kind TEXT NOT NULL, session TEXT, email TEXT, roles TEXT, saved INTEGER NOT NULL, blocked TEXT, blocked_at INTEGER)"),
    // #107: 버튼 동작을 마지막으로 저장한 사람(kind owner | guest). button = prop:<속성 id> 또는 block:<페이지>:<블록 id>.
    db.prepare("CREATE TABLE IF NOT EXISTS db_button_savers (button TEXT PRIMARY KEY, kind TEXT NOT NULL, session TEXT, email TEXT, roles TEXT, saved INTEGER NOT NULL)"),
  ]);
  // 반복 템플릿(C5): 예전 저장소에도 열을 더한다(이미 있으면 duplicate column 오류를 무시).
  await db.prepare("ALTER TABLE db_templates ADD COLUMN recurrence TEXT").run().catch(() => {});
  // 하위 항목(C12) 같은 DB 단위 설정. 예전 저장소에도 열을 더한다.
  await db.prepare("ALTER TABLE databases ADD COLUMN config TEXT").run().catch(() => {});
  // acard-storage-cost 4: each original's ETag, so a repeat view is a 304 without reading R2 (supabase/028 on Postgres).
  await db.prepare("ALTER TABLE media ADD COLUMN etag TEXT").run().catch(() => {});
  await ensureEditorSchema(db);
  for (const schema of ACARD_FEATURES.schema) await schema(db);
}

const IMPORT_MAX_BYTES = 30 * 1024 * 1024;
const IMPORT_MAX_PAGES = 400;

async function importZip(request, db) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > IMPORT_MAX_BYTES) return json({ error: "압축 파일이 너무 커요. 30MB 아래로 나눠 주세요." }, 413);
  const buffer = await request.arrayBuffer().catch(() => null);
  if (!buffer || buffer.byteLength === 0) return json({ error: "압축 파일이 비어 있어요." }, 400);
  if (buffer.byteLength > IMPORT_MAX_BYTES) return json({ error: "압축 파일이 너무 커요. 30MB 아래로 나눠 주세요." }, 413);

  let result;
  try {
    result = await notionImportZip(new Uint8Array(buffer));
  } catch (error) {
    return json({ error: "압축을 읽지 못했어요: " + String(error && error.message ? error.message : error) }, 400);
  }
  if (!result.pages.length) {
    return json({ error: "가져올 페이지를 찾지 못했어요. 노션에서 'Markdown & CSV'로 내보낸 zip 인지 확인해 주세요.", skipped: result.skipped.slice(0, 40), warnings: result.warnings }, 400);
  }

  const pages = result.pages.slice(0, IMPORT_MAX_PAGES);
  const dropped = result.pages.length - pages.length;
  const taken = new Set();
  const rows = await db.prepare("SELECT slug FROM pages").all();
  for (const row of rows.results ?? []) taken.add(String(row.slug));

  const created = [];
  const remap = new Map();
  let ord = Number((await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS NULL").first())?.m ?? 0);
  const now = Date.now();

  for (const page of pages) {
    let slug = page.slug || "page";
    while (taken.has(slug)) slug = slug.replace(/-\d+$/, "") + "-" + Math.random().toString(36).slice(2, 6);
    taken.add(slug);
    remap.set(page.slug, slug);
    const parent = page.parent ? remap.get(page.parent) ?? null : null;
    ord += 10;
    const title = String(page.title ?? slug).slice(0, 200) || slug;
    await db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, ?, ?, 'editor', NULL)")
      .bind(slug, title, parent, ord, page.kind === "db" ? "db" : "note", now).run();
    await saveBlocks(db, slug, normaliseBlocks(page.blocks));
    await db.prepare("INSERT INTO page_imports (page, kind, created) VALUES (?, 'zip', ?) ON CONFLICT (page) DO NOTHING").bind(slug, now).run();
    if (page.kind === "db") {
      // 노션-db 레인이 도입한 databases/db_properties/db_rows 구조에도 등록해야 읽기 화면의 새 렌더러가 표를 그린다.
      // 기존 database 블록(meta.rows)도 남겨 둔다 — 구버전 렌더러와 마크다운 내보내기가 그걸 본다.
      const dbBlock = (page.blocks || []).find((block) => block.type === "database");
      const columns = dbBlock && dbBlock.meta && Array.isArray(dbBlock.meta.columns) ? dbBlock.meta.columns : [];
      const rows = dbBlock && dbBlock.meta && Array.isArray(dbBlock.meta.rows) ? dbBlock.meta.rows : [];
      const createdDb = await createDatabase(db, { title, slug, parent });
      if (createdDb.slug !== slug) {
        await db.prepare("UPDATE pages SET slug = ? WHERE slug = ?").bind(createdDb.slug, slug).run();
        slug = createdDb.slug;
      }
      if (columns.length) {
        const properties = [{ id: "title", name: columns[0], type: "text" }].concat(
          columns.slice(1).map((name, index) => ({ id: "p" + index, name, type: "text" }))
        );
        await saveProperties(db, createdDb.id, properties);
        // saveProperties 가 속성 id 에 데이터베이스 id 를 붙이므로, 행의 props 도 같은 scoped 키로 적는다.
        const propKeys = properties.map((prop) => scopedId(createdDb.id, prop.id));
        const rowStatements = [];
        rows.forEach((row, index) => {
          const props = {};
          columns.forEach((name, columnIndex) => {
            props[propKeys[columnIndex]] = String((row && row[name]) ?? "");
          });
          rowStatements.push(db.prepare("INSERT INTO db_rows (id, database_id, page, props, ord, created, updated) VALUES (?, ?, NULL, ?, ?, ?, ?)")
            .bind(scopedId(createdDb.id, dbId("r")), createdDb.id, JSON.stringify(props), index * 10, now, now));
        });
        if (rowStatements.length) await db.batch(rowStatements);
      }
      created.push({ slug, title, parent, kind: "db", blocks: page.blocks.length, dbSlug: slug });
      continue;
    }
    created.push({ slug, title, parent, kind: page.kind, blocks: page.blocks.length });
  }

  const warnings = result.warnings.slice(0, 20);
  if (dropped > 0) warnings.push("페이지 " + dropped + "개는 한 번에 400개까지만 가져올 수 있어 건너뛰었어요.");
  return json({ ok: true, imported: created.length, pages: created, skipped: result.skipped.slice(0, 40), warnings });
}

function exportFilename(slug, ext) {
  return 'attachment; filename="' + slug.replace(/[^\w.-]+/g, "_").slice(0, 60) + "." + ext + '"';
}

// 마크다운 파일 한 장을 페이지로 만든다. 이름은 파일명(확장자 제거)이고 본문은 markdownToBlocks 로 바꾼다.
async function importMarkdown(request, db) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2 * 1024 * 1024) return json({ error: "파일이 너무 커요. 2MB 아래로 나눠 주세요." }, 413);
  const form = await request.formData().catch(() => null);
  const files = [];
  if (form) {
    for (const value of form.values()) if (value && typeof value === "object" && typeof value.arrayBuffer === "function") files.push(value);
  }
  if (!files.length) return json({ error: "마크다운 파일을 골라 주세요." }, 400);

  const taken = new Set();
  const rows = await db.prepare("SELECT slug FROM pages").all();
  for (const row of rows.results ?? []) taken.add(String(row.slug));
  const created = [];
  const warnings = [];
  const now = Date.now();
  let ord = Number((await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS NULL").first())?.m ?? 0);

  for (const file of files.slice(0, 40)) {
    const raw = await file.text();
    // An Acard markdown export (front matter acard_meta: 1) keeps its block meta and title; any other file reads as before.
    const doc = acardMetaDocument(raw);
    const text = doc.flagged ? doc.body : raw;
    const baseName = (doc.flagged && doc.title.trim()) || String(file.name || "").replace(/\.(md|markdown|txt)$/i, "").trim() || "가져온 노트";
    let slug = slugify(baseName);
    while (taken.has(slug)) slug = slug.replace(/-\d+$/, "") + "-" + Math.random().toString(36).slice(2, 6);
    taken.add(slug);
    ord += 10;
    const title = baseName.slice(0, 200);
    // The page row and its blocks commit together, so a long file that fails midway leaves no empty page.
    const blocks = importSyncedBlocks(markdownToBlocks(text, { meta: doc.flagged }));
    await saveBlocks(db, slug, await guardButtonBlocks(db, [], normaliseBlocks(blocks)), {
      before: [
        db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, NULL, ?, 'note', ?, 'editor', NULL)").bind(slug, title, ord, now),
        db.prepare("INSERT INTO page_imports (page, kind, created) VALUES (?, 'md', ?) ON CONFLICT (page) DO NOTHING").bind(slug, now),
      ],
    });
    created.push({ slug, title, parent: null, kind: "note", blocks: 1 });
  }
  if (files.length > 40) warnings.push("한 번에 40개까지만 가져올 수 있어 나머지는 건너뛰었어요.");
  return json({ ok: true, imported: created.length, pages: created, skipped: [], warnings });
}
function syncedReadOptions(db, env, copying = false) {
  return { principal: env?.ACARD_SAVE_PRINCIPAL ? { ...env.ACARD_SAVE_PRINCIPAL, kind: "agent" }
    : { kind: db.acardRoles || db.acardVisible || env && isGuest(env) ? "guest" : "owner" }, export: copying };
}

async function exportPage(db, url, env) {
  const format = (url.searchParams.get("format") ?? "md").toLowerCase();
  const scope = url.searchParams.get("scope") ?? "page";

  if (scope === "all" || format === "zip") {
    if (db.acardRoles || db.acardVisible || isGuest(env) || env?.ACARD_SAVE_PRINCIPAL) return json({ error: "workspace_export_requires_owner" }, 403);
    if (ACARD_FEATURES.services.exportZip) return await ACARD_FEATURES.services.exportZip(db, env);
    const rows = await db.prepare("SELECT slug, title FROM pages ORDER BY ord, title").all();
    const list = [];
    for (const row of rows.results ?? []) {
      const found = await readPage(db, String(row.slug));
      if (found) list.push({ slug: found.page.slug, title: found.page.title, blocks: found.blocks });
    }
    if (ACARD_FEATURES.services.folderExportMeta) {
      const meta = await ACARD_FEATURES.services.folderExportMeta(db);
      for (const item of list) Object.assign(item, { folder: meta.pathOf(item.slug), tags: meta.tagsOf(item.slug) });
    }
    if (!list.length) return json({ error: "내보낼 페이지가 없어요." }, 404);
    const zip = workspaceToZip(list);
    return new Response(zip, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": exportFilename("acard", "zip"),
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  const slug = (url.searchParams.get("slug") ?? "").trim() || "index";
  const found = await readPage(db, slug);
  if (!found) return json({ error: "없는 페이지예요." }, 404);
  const title = String(found.page.title ?? slug);
  const portable = format !== "acard-md" || db.acardRoles || db.acardVisible || isGuest(env) || env?.ACARD_SAVE_PRINCIPAL;
  const expanded = portable ? materializeSyncedBlocks(found.blocks, await resolveSyncedBlocks(db, slug, found.blocks, syncedReadOptions(db, env, true))) : found.blocks;

  if (format === "html") {
    return new Response(pageToHtml({ title, blocks: expanded }), {
      headers: { "content-type": "text/html; charset=utf-8", "content-disposition": exportFilename(slug, "html"), "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  // acard-md: lossless Acard markdown (colors, icons, embed heights, toggle headings as meta comment lines) that
  // /api/import/md and MCP read back the same; md stays the Notion-style export without them.
  if (format === "acard-md") {
    // AI marks (acard-human-edit) are the editing person's metadata: left out unless the export is meant for re-import.
    const blocks = url.searchParams.get("keep_ai") === "1" ? expanded : globalThis.AiMarks.stripMarks(expanded);
    return new Response(acardMarkdown(title, blocks), {
      headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": exportFilename(slug, "md"), "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  if (format !== "md" && format !== "markdown") return json({ error: "format 은 md, acard-md, html, zip 중 하나여야 해요." }, 400);
  return new Response(notionBlocksToMarkdown(title, expanded), {
    headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": exportFilename(slug, "md"), "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

async function readTree(db) {
  const rows = await db.prepare("SELECT p.slug, p.title, p.parent, p.ord, p.kind, p.updated, p.source, s.icon, s.favorite FROM pages p LEFT JOIN editor_page_settings s ON s.page=p.slug WHERE p.kind != 'db_row' AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page=p.slug) ORDER BY p.ord, p.title").all();
  return visibleOnly(db, rows.results ?? []).map((row) => (db.acardVisible && row.parent && !db.acardVisible.has(String(row.parent)) ? { ...row, parent: null } : row));
}

// Postgres: page, blocks, settings and trash in one statement. Every statement is a ~125 ms round trip through
// Hyperdrive and holds a pooled connection; three parallel reads took all three of a request's connections.
const PG_PAGE_READ = "SELECT s.*, t.page AS trash_page, t.deleted AS trash_deleted, t.permanent AS trash_permanent,"
  + " p.slug AS p_slug, p.title AS p_title, p.parent AS p_parent, p.ord AS p_ord, p.kind AS p_kind, p.updated AS p_updated, p.source AS p_source,"
  + " (SELECT json_agg(json_build_object('id', b.id, 'type', b.type, 'text', b.text, 'checked', b.checked, 'indent', b.indent, 'meta', b.meta) ORDER BY b.ord)::text FROM blocks b WHERE b.page = k.page) AS p_blocks"
  + " FROM (SELECT ? AS page) k LEFT JOIN pages p ON p.slug = k.page LEFT JOIN editor_page_settings s ON s.page = k.page LEFT JOIN editor_trash t ON t.page = k.page";

async function readPageOnce(db, slug) {
  const row = await db.prepare(PG_PAGE_READ).bind(slug).first();
  const { p_slug, p_title, p_parent, p_ord, p_kind, p_updated, p_source, p_blocks, ...rest } = row || {};
  const page = p_slug === null || p_slug === undefined ? null : { slug: p_slug, title: p_title, parent: p_parent, ord: p_ord, kind: p_kind, updated: p_updated, source: p_source };
  return [page, { results: parseJson(p_blocks, []) }, editorPageMeta(rest)];
}

const PAGE_BLOCKS_READ = "SELECT id, type, text, checked, indent, meta FROM blocks WHERE page = ? ORDER BY ord";

async function readPage(db, slug, initial) {
  // One round trip on a member workspace store (gate/tenancy.ts sends same-tick statements together).
  const [page, rows, meta] = !initial && db.dialect === "pg" ? await readPageOnce(db, slug) : await Promise.all([
    initial ? initial.page : db.prepare("SELECT slug, title, parent, ord, kind, updated, source FROM pages WHERE slug = ?").bind(slug).first(),
    initial && initial.rows ? initial.rows : db.prepare(PAGE_BLOCKS_READ).bind(slug).all(),
    initial ? initial.meta : readEditorPageMeta(db, slug),
  ]);
  if (meta.trashed || !page) return null;
  const blocks = (rows.results ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    text: row.text,
    checked: row.checked === 1,
    indent: row.indent,
    ...(row.meta ? { meta: cleanMeta(row.type, parseJson(row.meta, null)) } : {}),
  }));
  return { page, blocks, ...meta };
}

// #21: a block is never cut. HTML / visual / chart / diagram sources take 64 KB (UTF-8, the size visual-html.js renders),
// every other block 100,000 characters; anything longer is refused with 413 so the writer (agent or editor) knows.
const BLOCK_SOURCE_TYPES = new Set(["html", "visual", "chart", "diagram", "part"]);
const BLOCK_TEXT_MAX = 100_000;

function blockTooLong(type, text, index) {
  if (BLOCK_SOURCE_TYPES.has(type)) {
    const bytes = new TextEncoder().encode(text).length;
    if (bytes <= VISUAL_MAX_BYTES) return null;
    return new AgentError("블록이 너무 커요. HTML·시각 자료·차트·다이어그램 블록은 64KB(UTF-8)까지 넣을 수 있어요. 내용을 여러 블록으로 나눠 주세요." + " (#" + (index + 1) + ", " + (Math.ceil(bytes / 102.4) / 10) + " KB)", 413);
  }
  if (text.length <= BLOCK_TEXT_MAX) return null;
  return new AgentError("블록이 너무 길어요. 글 블록은 100,000자까지 넣을 수 있어요. 내용을 여러 블록으로 나눠 주세요." + " (#" + (index + 1) + ", " + text.length.toLocaleString("en-US") + ")", 413);
}

function normaliseBlocks(input) {
  if (!Array.isArray(input)) return [];
  if (input.some(block => block?.type === "synced" || block?.meta?.synced)) {
    if (input.length > 2000 || input.some(block => !block || !Number.isInteger(block.indent ?? 0) || (block.indent ?? 0) < 0 || (block.indent ?? 0) > 6 ||
      (block.type === "synced" && (typeof block.id !== "string" || block.id.length > 60 || block.text !== "" || !cleanSyncedMeta(block.meta))) ||
      (block.type !== "synced" && block.meta?.synced))) throw new AgentError("invalid_synced", 400);
  }
  return input.slice(0, 2000).map((raw, index) => {
    const block = raw && typeof raw === "object" ? raw : {};
    const type = typeof block.type === "string" ? block.type.slice(0, 24) : "paragraph";
    const text = typeof block.text === "string" ? block.text : "";
    const tooLong = blockTooLong(type, text, index);
    if (tooLong) throw tooLong;
    return {
      id: typeof block.id === "string" && block.id ? block.id.slice(0, 60) : "b" + index.toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      type,
      text,
      checked: block.checked === true,
      indent: Number.isFinite(block.indent) ? Math.max(0, Math.min(6, Math.trunc(block.indent))) : 0,
      meta: block.meta && typeof block.meta === "object" ? { ...cleanMeta(typeof block.type === "string" ? block.type.slice(0, 24) : "paragraph", block.meta), ...(Array.isArray(block.meta.richText) ? { richText: globalThis.EditorModel.richText(block.meta.richText, block.text) } : {}) } : null,
    };
  });
}

// Whole-page column rules (notion-parity C13) for a complete ordered block list: old text-only columns become
// column blocks and columns sit at a depth whose children still fit the 0..6 indent range. Runs before
// normaliseBlocks so the per-block indent cut cannot flatten a deep column's children into its siblings.
function pageStructure(blocks) {
  return globalThis.ColumnsModel.clampColumnsDepth(globalThis.ColumnsModel.columnsFromLegacy(blocks));
}

function linksOf(blocks) {
  const found = new Set();
  for (const block of blocks) for (const run of Array.isArray(block.meta?.richText) ? block.meta.richText : []) {
    if (run.mention?.type === "page") found.add(run.mention.slug);
    else if (typeof run.href === "string" && /^\/[^/]+\/$/.test(run.href)) found.add(decodeURIComponent(run.href.slice(1, -1)));
  }
  const text = blocks.map((block) => block.text).join("\n");
  for (const match of text.matchAll(WIKI_LINK)) {
    const link = wikiTarget(match[1], null);
    if (link) found.add(link.slug);
  }
  for (const match of text.matchAll(/\]\(\/([^)\s#?]+?)\/?\)/g)) {
    const slug = match[1];
    if (slug && !slug.includes("/")) found.add(slug);
  }
  return [...found];
}

// [[페이지 제목]] 은 이 워크스페이스 DB 의 페이지로 풀어 links 에 더한다. 모든 저장 경로가 afterSave 를 거치므로 여기서 한 번에 한다.
async function linkWikiTitles(db, slug, blocks) {
  const raws = blocks.flatMap((block) => [...String(block.text ?? "").matchAll(WIKI_LINK)].map((match) => match[1]));
  if (!raws.length) return;
  const rows = await db.prepare("SELECT slug, title, updated FROM pages WHERE kind != 'db_row' AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = pages.slug)").all();
  const index = wikiIndex(rows.results ?? []);
  const known = new Set(linksOf(blocks));
  const found = new Set(raws.map((raw) => wikiTarget(raw, index)?.slug).filter((dst) => dst && index.slugs.has(dst) && !known.has(dst)));
  if (found.size) await db.batch([...found].map((dst) => db.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)").bind(slug, dst)));
}
registerFeature({ afterSave: linkWikiTitles });

// extra.before / extra.after ride in the same transaction as the blocks, so a page row and its blocks land together or not at all.
async function saveBlocks(db, slug, blocks, extra) {
  if (blocks.some(block => block.type === "synced")) {
    const previous = await readPage(db, slug);
    guardSyncedWrite(blocks, slug, previous?.blocks ?? []);
  }
  const statements = [...(extra?.before ?? []), ...blockStatements(db, slug, blocks), ...(extra?.after ?? [])];
  // Postgres: one round trip for the whole replacement instead of one per statement.
  if (typeof db.script === "function") await db.script(statements);
  else await db.batch(statements);
  await afterBlockSave(db, slug, blocks);
}

async function afterBlockSave(db, slug, blocks) {
  if (!ACARD_FEATURES.afterSave.length) return;
  try {
    const page = await db.prepare("SELECT * FROM pages WHERE slug = ?").bind(slug).first();
    for (const hook of ACARD_FEATURES.afterSave) {
      try { await hook(db, slug, blocks, page); }
      catch (error) { console.error("Feature afterSave failed", error); }
    }
  } catch (error) { console.error("Feature afterSave failed", error); }
}

// A snapshot is usable only if its version is still current after the page lock. Retry an agent race,
// but never retry a replacement past a person's save or an explicit expectedUpdated. The claim guards every write.
async function saveAgentBlocks(db, slug, blocks, options) {
  for (;;) {
    const snapshot = await snapshotPage(db, slug);
    if (!snapshot) return false;
    guardSyncedWrite(options.append ? [...snapshot.blocks, ...blocks] : blocks, slug, snapshot.blocks);
    if (options.append) blockLimit(blocks.length, snapshot.blocks.length);
    const claim = crypto.randomUUID();
    const guard = "EXISTS (SELECT 1 FROM pages WHERE slug = ? AND hash = ?)";
    const condition = options.append ? "" : " AND updated <= " + (options.expected === null
      ? "COALESCE((SELECT MAX(created) FROM agent_activity WHERE page = ?), -1)" : "?");
    const statements = [
      db.prepare("UPDATE pages SET updated = updated WHERE slug = ?").bind(slug),
      db.prepare("UPDATE pages SET updated = MAX(updated + 1, ?), source = 'editor', hash = ? WHERE slug = ? AND updated = ? AND hash IS ? AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ?)" + condition)
        .bind(Date.now(), claim, slug, snapshot.page.updated, snapshot.page.hash, slug, ...(options.append ? [] : [options.expected === null ? slug : options.expected])),
      db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) SELECT ?, ?, ?, ?, ? WHERE " + guard)
        .bind(claim, slug, snapshot.page.title, Date.now(), JSON.stringify(snapshot), slug, claim),
    ];
    if (!options.append) statements.push(db.prepare("DELETE FROM blocks WHERE page = ? AND " + guard).bind(slug, slug, claim));
    const rows = blocks.map((block, index) => [slug, block.id, index, block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null]);
    statements.push(...multiRowInsert(db, "WITH incoming (page, id, ord, type, text, checked, indent, meta) AS (VALUES %VALUES%) INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT page, id, "
      + (options.append ? "CAST(ord AS BIGINT) - (SELECT MIN(CAST(ord AS BIGINT)) FROM incoming) + COALESCE((SELECT MAX(ord) + 1 FROM blocks WHERE page = ?), 0)" : "CAST(ord AS BIGINT)")
      + ", type, text, CAST(checked AS BIGINT), CAST(indent AS BIGINT), meta FROM incoming WHERE " + guard, 8, rows, [...(options.append ? [slug] : []), slug, claim]));
    if (!options.append) statements.push(db.prepare("DELETE FROM links WHERE src = ? AND " + guard).bind(slug, slug, claim));
    for (const dst of linksOf(blocks)) statements.push(db.prepare("INSERT OR IGNORE INTO links (src, dst) SELECT ?, ? WHERE " + guard).bind(slug, dst, slug, claim));
    statements.push(db.prepare("INSERT INTO agent_activity (id, page, agent, via, action, created) SELECT ?, ?, ?, ?, ?, updated FROM pages WHERE slug = ? AND hash = ?")
      .bind(options.activity, slug, options.principal.name, options.principal.via, options.append ? "append" : "update", slug, claim));
    statements.push(options.append
      ? db.prepare("UPDATE pages SET hash = NULL WHERE slug = ? AND hash = ?").bind(slug, claim)
      : db.prepare("UPDATE pages SET title = ?, parent = ?, hash = NULL WHERE slug = ? AND hash = ?").bind(options.title, options.parent, slug, claim));
    const saved = await db.batch(statements);
    if (Number(saved[1]?.meta?.changes)) {
      const current = await readPage(db, slug);
      if (current) await afterBlockSave(db, slug, current.blocks);
      return true;
    }
    const current = await db.prepare("SELECT updated, hash FROM pages WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ?)").bind(slug, slug).first();
    if (!current || (current.updated === snapshot.page.updated && current.hash === snapshot.page.hash)) return false;
    if (!options.append) {
      const latest = options.expected === null
        ? (await db.prepare("SELECT MAX(created) AS created FROM agent_activity WHERE page = ?").bind(slug).first())?.created ?? -1
        : options.expected;
      if (current.updated > latest) return false;
    }
  }
}

// Multi-row INSERTs: one statement per block made a 849-block page 849 round trips (~140 ms each on Postgres through
// Hyperdrive, ~2 minutes), so agent writes of long documents timed out. SQLite stores (D1, workspace Durable Objects)
// take at most 100 bound parameters per statement; Postgres takes 65535.
function multiRowInsert(db, head, width, rows, tail = []) {
  const per = Math.max(1, Math.floor(((db.dialect === "pg" ? 8000 : 100) - tail.length) / width));
  const tuple = "(" + Array(width).fill("?").join(", ") + ")";
  const out = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push(db.prepare(head.replace("%VALUES%", chunk.map(() => tuple).join(", "))).bind(...chunk.flat(), ...tail));
  }
  return out;
}

function blockStatements(db, slug, blocks) {
  if (blocks.some(block => block.type === "synced")) {
    const invalid = validateSyncedBlocks(blocks, slug);
    if (invalid) throw new AgentError(invalid.error, 400);
  }
  const rows = blocks.map((block, index) => [slug, block.id, index, block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null]);
  // Locks the page row first, so two replacements of one page run one after the other. Without it, on Postgres the
  // second writer's DELETE ran before the first committed, missed its new rows, and its INSERT hit the same (page, id):
  // duplicate key blocks_pkey, a 500 (acard-db-load, 5 of 221 writes under load). SQLite batches are serial already.
  return [
    db.prepare("UPDATE pages SET updated = updated WHERE slug = ?").bind(slug),
    db.prepare("DELETE FROM blocks WHERE page = ?").bind(slug),
    ...multiRowInsert(db, "INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) VALUES %VALUES%", 8, rows),
    db.prepare("DELETE FROM links WHERE src = ?").bind(slug),
    ...multiRowInsert(db, "INSERT OR IGNORE INTO links (src, dst) VALUES %VALUES%", 2, linksOf(blocks).map((dst) => [slug, dst])),
  ];
}


// ---------- 데이터베이스 ----------

function dbId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function shortHash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// 속성·행·뷰·템플릿 id 는 전역 PK 라서 데이터베이스 id 를 접두사로 붙여 DB 간 충돌을 막는다.
function scopedId(databaseId, local) {
  const prefix = databaseId + "_";
  const text = String(local || "");
  if (text.startsWith(prefix) && text.length <= 40) return text;
  const joined = prefix + text;
  return joined.length <= 40 ? joined : (prefix + shortHash(text) + text.slice(0, Math.max(0, 40 - prefix.length - 8))).slice(0, 40);
}

// db_ref 의 meta.html 은 서버가 렌더해 넣는 값이다. 클라이언트가 보낸 html 은 신뢰하지 않는다.
function cleanMeta(type, meta) {
  if (!meta || typeof meta !== "object") return meta || null;
  if (type === "synced") {
    const clean = cleanSyncedMeta(meta);
    if (!clean) throw new AgentError("invalid_synced", 400);
    return clean;
  }
  if (type !== "db_ref") return meta;
  const out = Object.assign({}, meta);
  delete out.html;
  return out;
}

function parseJson(text, fallback) {
  if (typeof text !== "string" || !text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

async function readDatabase(db, slug, depth = 0, cache) {
  if (cache) {
    if (!cache.has(slug)) cache.set(slug, readDatabase(db, slug, depth));
    return cache.get(slug);
  }
  const database = await db.prepare("SELECT id, slug, title, icon, parent, ord, created, updated, config FROM databases WHERE slug = ?").bind(slug).first();
  if (!database) return null;
  return await readDatabaseById(db, database, depth);
}

// ---------- 반복 템플릿 예약 실행(C5) ----------
// 회차마다 행 id·페이지 slug 를 (템플릿 id, 회차 시각)에서 정해서 만든다. 한 회차의 행·페이지·블록·회차 기록·next_run 전진이
// 한 batch(트랜잭션)라서, 겹쳐 실행되거나 다시 실행돼도 같은 id 에 INSERT OR IGNORE 가 되어 행은 하나뿐이고, 중간에 실패하면
// 전부 되돌아가 다음 실행이 같은 회차를 다시 만든다. next_run 은 읽었던 값일 때만 바꾼다(먼저 끝난 실행이 이미 바꿨으면 그대로).
function recurringKey(templateId, occurrence) {
  const text = templateId + ":" + occurrence;
  return shortHash(text) + shortHash(text + "#");
}

function dueOccurrence(rec, now) {
  let at = rec.next_run;
  if (!Number.isFinite(at) || at > now) return null;
  for (let i = 0; i < 500; i += 1) {
    const next = nextRun(rec, at);
    if (next === null || next > now) return { occurrence: at, next };
    at = next;
  }
  return { occurrence: at, next: nextRun(rec, now) };
}

function recurringTitle(text, occurrence, tz) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(occurrence);
  return String(text || "").replace(/\{\{\s*date\s*\}\}/g, date);
}

async function runDueTemplates(db, now) {
  await ensureSchema(db);
  // #86: 권한 문제로 멈춘 템플릿(db_template_savers.blocked)은 값을 다시 저장할 때까지 돌지 않는다.
  const due = await db.prepare("SELECT t.id, t.database_id, t.name, t.props, t.blocks, t.recurrence, d.slug AS db_slug FROM db_templates t JOIN databases d ON d.id = t.database_id LEFT JOIN db_template_savers s ON s.template_id = t.id WHERE t.recurrence IS NOT NULL AND s.blocked IS NULL").all();
  const created = [];
  for (const row of due.results ?? []) {
    const rec = normaliseRecurrence(parseJson(row.recurrence, null));
    if (!rec) continue;
    const slot = dueOccurrence(rec, now);
    if (!slot) continue;
    const database = { id: row.database_id, slug: row.db_slug };
    const properties = await readProperties(db, database.id);
    const template = { props: parseJson(row.props, {}), blocks: parseJson(row.blocks, []) };
    const titleProp = properties.find((prop) => prop.type === "title");
    const props = {};
    properties.forEach((prop) => {
      // #86: 템플릿 값은 속성 id 키로만 읽는다(저장할 때 검사한 키). 이름 키는 실행 시점의 이름과 맞추지 않는다.
      const incoming = template.props[prop.id];
      props[prop.id] = incoming === undefined ? emptyValue(prop) : normaliseCellValue(prop, incoming);
      if (prop.type === "unique_id") props[prop.id] = null;
    });
    if (titleProp) props[titleProp.id] = recurringTitle(props[titleProp.id] || row.name, slot.occurrence, rec.tz);
    const title = titleProp ? String(props[titleProp.id] || "") : recurringTitle(row.name, slot.occurrence, rec.tz);
    const key = recurringKey(row.id, slot.occurrence);
    const rowId = scopedId(database.id, "r" + key);
    const page = slugify(title || "행").slice(0, 60) + "-" + key;
    const blocks = normaliseBlocks(template.blocks.length ? template.blocks : [{ id: "b1", type: "paragraph", text: "", checked: false, indent: 0, meta: null }]);
    const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM db_rows WHERE database_id = ?").bind(database.id).first();
    const advanced = JSON.stringify({ ...rec, next_run: slot.next });
    // #86: 링크를 만들기 직전, 소유자 권한이 아니라 이 값을 저장한 사람의 권한으로 본다. 안 되면 이 템플릿은 아무것도 쓰지 않고 멈춘다.
    if (await templateSaverDenied(db, database, properties, row.id, props)) continue;
    const relations = await applyRowProps(db, database, properties, rowId, props, { lenient: true });
    if (relations.error) continue;
    const statements = [
      ...relations.locks,
      db.prepare("INSERT OR IGNORE INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, 'db_row', ?, 'editor', NULL)").bind(page, String(title || "제목 없음").slice(0, 200), database.slug, now % 100000, now),
      ...blocks.map((block, index) => db.prepare("INSERT OR IGNORE INTO blocks (page, id, ord, type, text, checked, indent, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(page, block.id, index, block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null)),
      db.prepare("INSERT OR IGNORE INTO db_rows (id, database_id, page, props, ord, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(rowId, database.id, page, JSON.stringify(props), Number(maxRow && maxRow.m ? maxRow.m : 0) + 10, now, now),
      db.prepare("INSERT OR IGNORE INTO db_template_runs (template_id, occurrence, row_id, created) VALUES (?, ?, ?, ?)").bind(row.id, slot.occurrence, rowId, now),
      db.prepare("UPDATE db_templates SET recurrence = ? WHERE id = ? AND recurrence = ?").bind(advanced, row.id, row.recurrence),
      ...relations.statements,
    ];
    await db.batch(statements);
    for (const prop of properties) {
      if (prop.type !== "unique_id") continue;
      const current = await db.prepare("SELECT props FROM db_rows WHERE id = ?").bind(rowId).first();
      const values = parseJson(current && current.props, {});
      if (Number.isInteger(values[prop.id])) continue;
      values[prop.id] = await nextUniqueId(db, database.id, prop.id);
      await db.batch([
        db.prepare("UPDATE db_rows SET props = ? WHERE id = ?").bind(JSON.stringify(values), rowId),
        ...twoWayRelations(properties).map((relation) => relationCacheStatement(db, relation.id, "id = ?", [rowId])),
      ]);
    }
    created.push({ template: row.id, occurrence: slot.occurrence, row: rowId });
  }
  return { created, next: await earliestRecurring(db) };
}

async function earliestRecurring(db) {
  const rows = await db.prepare("SELECT t.recurrence FROM db_templates t LEFT JOIN db_template_savers s ON s.template_id = t.id WHERE t.recurrence IS NOT NULL AND s.blocked IS NULL").all();
  let next = null;
  for (const row of rows.results ?? []) {
    const rec = normaliseRecurrence(parseJson(row.recurrence, null));
    if (rec && Number.isFinite(rec.next_run) && (next === null || rec.next_run < next)) next = rec.next_run;
  }
  return next;
}

// 멤버 워크스페이스는 자기 저장소(DO)의 알람이 깨운다. 반복을 저장·끄거나 템플릿·DB 를 지우면 가장 이른 next_run 으로 다시 건다.
// 오너 워크스페이스는 acard-workspace 워커의 15분 크론이 깨운다(여기서는 할 일 없음).
async function armRecurring(env, db) {
  const ws = env && env.ACARD_WORKSPACE;
  if (!ws || !/^[0-9a-f]{32}$/.test(ws) || !env.WORKSPACE) return;
  try {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName("ws:" + ws));
    await stub.scheduleRecurring(ws, await earliestRecurring(db));
  } catch (error) {
    console.error("acard recurring alarm failed", ws, error instanceof Error ? error.message : String(error));
  }
}

async function readProperties(db, databaseId) {
  const propRows = await db.prepare("SELECT id, name, type, config, ord, width, hidden FROM db_properties WHERE database_id = ? ORDER BY ord, name").bind(databaseId).all();
  return (propRows.results ?? []).map((row, index) => normaliseProperty({
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseJson(row.config, {}),
    ord: row.ord,
    width: row.width,
    hidden: row.hidden === 1,
  }, index));
}

// 갤러리·보드 카드 미리보기(C8): 행 페이지의 커버·아이콘(editor_page_settings)과 본문 첫 이미지 블록을 두 번의 IN 조회로 읽는다.
async function rowPageLooks(db, pages) {
  const out = new Map();
  for (let i = 0; i < pages.length; i += 90) {
    const chunk = pages.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(",");
    const [settings, images] = await Promise.all([
      db.prepare("SELECT page, icon, cover FROM editor_page_settings WHERE page IN (" + marks + ")").bind(...chunk).all().catch(() => ({ results: [] })),
      db.prepare("SELECT page, ord, meta FROM blocks WHERE type = 'image' AND page IN (" + marks + ") ORDER BY page, ord").bind(...chunk).all(),
    ]);
    for (const row of settings.results ?? []) out.set(row.page, { icon: row.icon || "", cover: row.cover || null, firstImage: null });
    for (const row of images.results ?? []) {
      const look = out.get(row.page) || { icon: "", cover: null, firstImage: null };
      if (!look.firstImage) {
        const meta = parseJson(row.meta, {});
        if (typeof meta.src === "string" && meta.src) { look.firstImage = meta.src; look.firstImageMeta = meta; }
      }
      out.set(row.page, look);
    }
  }
  return out;
}

async function readRows(db, databaseId, properties, raw) {
  const rowRows = raw || await db.prepare("SELECT r.id, r.page, r.props, r.ord, r.created, r.updated, p.title AS page_title FROM db_rows r LEFT JOIN pages p ON p.slug = r.page WHERE r.database_id = ? ORDER BY r.ord, r.created").bind(databaseId).all();
  // A row without its own page (imported tables) carries only the database's permission, which the caller checked.
  const all = rowRows.results ?? [];
  const rows = db && db.acardVisible ? all.filter((row) => row.page === null || db.acardVisible.has(String(row.page))) : all;
  const looks = await rowPageLooks(db, rows.map((row) => row.page).filter(Boolean));
  return rows.map((row, index) => {
    const parsed = normaliseRow({ id: row.id, page: row.page, props: parseJson(row.props, {}), ord: row.ord, created: row.created, updated: row.updated }, properties, index);
    const look = (row.page && looks.get(row.page)) || null;
    parsed.icon = "";
    parsed.pageIcon = look && look.icon ? look.icon : "";
    parsed.cover = look ? look.cover : null;
    parsed.firstImage = look ? look.firstImage : null;
    parsed.firstImageMeta = look?.firstImageMeta || null;
    parsed.pageTitle = row.page_title === null || row.page_title === undefined ? null : row.page_title;
    return parsed;
  });
}

async function readDatabaseById(db, database, depth) {
  database = Object.assign({}, database, { config: normaliseDatabaseConfig(parseJson(database.config, {})) });
  const [properties, rawRows, viewRows, templateRows] = await Promise.all([
    readProperties(db, database.id),
    db.prepare("SELECT r.id, r.page, r.props, r.ord, r.created, r.updated, p.title AS page_title FROM db_rows r LEFT JOIN pages p ON p.slug = r.page WHERE r.database_id = ? ORDER BY r.ord, r.created").bind(database.id).all(),
    db.prepare("SELECT id, name, type, config, ord FROM db_views WHERE database_id = ? ORDER BY ord, name").bind(database.id).all(),
    db.prepare("SELECT t.id, t.name, t.icon, t.props, t.blocks, t.ord, t.recurrence, s.blocked FROM db_templates t LEFT JOIN db_template_savers s ON s.template_id = t.id WHERE t.database_id = ? ORDER BY t.ord, t.name").bind(database.id).all(),
  ]);
  const rows = await readRows(db, database.id, properties, rawRows);
  const views = (viewRows.results ?? []).map((row, index) => normaliseView({ id: row.id, name: row.name, type: row.type, config: parseJson(row.config, {}), ord: row.ord }, index));
  const templates = (templateRows.results ?? []).map((row, index) => Object.assign(normaliseTemplate({
    id: row.id,
    name: row.name,
    icon: row.icon,
    props: parseJson(row.props, {}),
    blocks: parseJson(row.blocks, []),
    ord: row.ord,
    recurrence: parseJson(row.recurrence, null),
  }, index), row.blocked ? { blocked: String(row.blocked), notice: "권한 문제로 반복이 멈췄어요" } : { blocked: null }));
  if (!views.length) views.push(normaliseView({ id: "v" + database.id, name: "표", type: "table", ord: 0 }, 0));
  await resolveComputed(db, properties, rows, depth || 0);
  return { database, properties, rows, views, templates };
}

function rowValuesMap(properties, row) {
  const out = {};
  const computed = row.computed || {};
  properties.forEach((prop) => {
    out[prop.id] = prop.type === "title" ? (row.pageTitle || "") : (computed[prop.id] !== undefined ? computed[prop.id] : row.props[prop.id]);
  });
  return out;
}

const COMPUTED_TYPES = ["formula", "rollup", "created_time", "updated_time"];

// 롤업 대상 데이터베이스만 읽는다. 관계 속성만 있고 롤업이 쓰지 않는 데이터베이스는 읽지 않는다.
// 대상 속성이 계산 속성일 때만 한 단계 더 계산한다.
async function readRollupTarget(db, slug, targetKey, depth) {
  if (db.acardVisible && !db.acardVisible.has(String(slug))) return null;
  const database = await db.prepare("SELECT id FROM databases WHERE slug = ?").bind(slug).first();
  if (!database) return null;
  const properties = await readProperties(db, database.id);
  const rows = await readRows(db, database.id, properties);
  const targetProp = findProp(properties, targetKey);
  if (targetProp && COMPUTED_TYPES.indexOf(targetProp.type) >= 0) await resolveComputed(db, properties, rows, depth + 1);
  return { properties, rows };
}

async function resolveComputed(db, properties, rows, depth) {
  rows.forEach((row) => { row.computed = {}; row.errors = {}; });
  if (depth > 3) return;

  const rollups = properties.filter((prop) => prop.type === "rollup");
  const targets = new Map();
  const cache = new Map();
  for (const prop of rollups) {
    const slug = rollupRelationSlug(properties, prop);
    if (!slug) continue;
    const key = slug + "\n" + prop.config.target_property;
    if (!cache.has(key)) cache.set(key, await readRollupTarget(db, slug, prop.config.target_property, depth));
    targets.set(prop.id, cache.get(key));
  }

  rows.forEach((row) => {
    properties.forEach((prop) => {
      if (prop.type === "created_time") row.computed[prop.id] = row.created;
      if (prop.type === "updated_time") row.computed[prop.id] = row.updated;
      if (prop.type === "rollup") {
        const target = targets.get(prop.id) || null;
        const relationProp = findProp(properties, prop.config.relation_property);
        const ids = relationProp && Array.isArray(row.props[relationProp.id]) ? row.props[relationProp.id] : [];
        const related = target
          ? target.rows.filter((entry) => ids.indexOf(entry.id) >= 0).map((entry) => ({
            get: (key) => {
              const found = findProp(target.properties, key);
              if (!found) return null;
              if (found.type === "title") return entry.pageTitle;
              if (entry.computed && entry.computed[found.id] !== undefined) return entry.computed[found.id];
              return entry.props[found.id];
            },
            typeOf: (key) => {
              const found = findProp(target.properties, key);
              return found ? found.type : "text";
            },
          }))
          : [];
        row.computed[prop.id] = rollupValue({ function: prop.config.function, target_property: prop.config.target_property }, {
          related,
          targetType: rollupTargetType(target, prop.config.target_property),
        });
      }
    });
  });

  // 수식은 다른 수식·롤업을 참조할 수 있으므로 값이 안정될 때까지 반복한다(순환은 횟수로 끊는다).
  const formulas = properties.filter((prop) => prop.type === "formula");
  if (!formulas.length) return;
  // 관계 속성은 수식이 실제로 읽을 때만 대상 행 목록으로 바꾼다(깊이 1). 첫 패스는 id 배열로 계산하며 읽힌 관계를
  // 모으고, 그런 관계가 있으면 대상 DB마다 한 번 읽어 수식만 다시 계산한다. 깊이 1 아래의 관계는 id 배열 그대로다.
  const wanted = new Set();
  const relationRows = new Map();
  evaluateFormulas(properties, rows, formulas, depth === 0 ? wanted : null, relationRows);
  if (!wanted.size) return;
  const bySlug = new Map();
  for (const id of wanted) {
    const prop = properties.find((entry) => entry.id === id);
    const slug = prop.config.database;
    if (!bySlug.has(slug)) bySlug.set(slug, await readRelationRows(db, slug, depth));
    relationRows.set(id, bySlug.get(slug));
  }
  evaluateFormulas(properties, rows, formulas, null, relationRows);
}

// 관계 대상 DB의 행을 수식용 행 객체 {__row, id, title, props: {이름: 값}} 로 읽는다. 대상 행의 계산 속성은 한 단계 아래에서
// 계산한다. 없는 DB면 빈 목록이다.
async function readRelationRows(db, slug, depth) {
  const out = new Map();
  if (db.acardVisible && !db.acardVisible.has(String(slug))) return out;
  const database = await db.prepare("SELECT id FROM databases WHERE slug = ?").bind(slug).first();
  if (!database) return out;
  const properties = await readProperties(db, database.id);
  const rows = await readRows(db, database.id, properties);
  if (properties.some((prop) => COMPUTED_TYPES.indexOf(prop.type) >= 0)) await resolveComputed(db, properties, rows, depth + 1);
  for (const row of rows) {
    const values = rowValuesMap(properties, row);
    const props = {};
    for (const prop of properties) props[prop.name] = values[prop.id] === undefined ? null : values[prop.id];
    out.set(row.id, { __row: true, id: row.id, title: row.pageTitle || "", props });
  }
  return out;
}

function evaluateFormulas(properties, rows, formulas, wanted, relationRows) {
  rows.forEach((row) => {
    const scope = rowValuesMap(properties, row);
    const ctx = {
      get: (key) => {
        const found = findProp(properties, key);
        if (!found) return null;
        if (found.type === "relation") {
          if (wanted && found.config && found.config.database) wanted.add(found.id);
          const loaded = relationRows.get(found.id);
          if (loaded) return (Array.isArray(scope[found.id]) ? scope[found.id] : []).map((id) => loaded.get(id)).filter(Boolean);
        }
        return scope[found.id];
      },
      has: (key) => !!findProp(properties, key),
      typeOf: (key) => {
        const found = findProp(properties, key);
        return found ? found.type : "text";
      },
      now: Date.now(),
    };
    for (let pass = 0; pass <= formulas.length; pass += 1) {
      let changed = false;
      for (const prop of formulas) {
        const { value, error } = evaluateFormulaDetailed(prop.config.expression, ctx);
        if (JSON.stringify(value) !== JSON.stringify(scope[prop.id])) changed = true;
        scope[prop.id] = value;
        row.computed[prop.id] = value;
        if (error) row.errors[prop.id] = error;
        else delete row.errors[prop.id];
      }
      if (!changed) break;
    }
  });
}

function findProp(properties, key) {
  if (!key) return null;
  return properties.find((prop) => prop.id === key || prop.name === key) || null;
}

function rollupRelationSlug(properties, prop) {
  const relationProp = findProp(properties, prop.config.relation_property);
  return relationProp && relationProp.type === "relation" ? relationProp.config.database : "";
}

function rollupTargetType(target, key) {
  if (!target) return "text";
  const found = findProp(target.properties, key);
  return found ? found.type : "text";
}

function validBoardProgress(database, properties, props) {
  if (database.slug !== "board") return true;
  const progress = properties.find((prop) => prop.type === "number" && prop.name === "진행률");
  if (!progress) return true;
  const value = Object.prototype.hasOwnProperty.call(props, progress.id) ? props[progress.id] : props[progress.name];
  if (value === undefined || value === null || value === "") return true;
  const number = normaliseCellValue(progress, value);
  return number !== null && number >= 0 && number <= 100;
}

const hasKey = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const incomingValue = (props, prop) => (hasKey(props, prop.id) ? props[prop.id] : (hasKey(props, prop.name) ? props[prop.name] : undefined));

// 행 값 바꾸기(PATCH): 기존 값 위에 들어온 값만 덮고 훅을 돌린다. 쓰기는 호출하는 쪽이 한 batch 로 한다.
async function updatedRowProps(db, rowId, incoming, properties, database, base) {
  const existing = base ? null : await db.prepare("SELECT props FROM db_rows WHERE id = ?").bind(rowId).first();
  const before = base ? { ...base } : parseJson(existing && existing.props, {});
  const normalised = { ...before };
  properties.forEach((prop) => {
    const value = incomingValue(incoming, prop);
    if (value !== undefined && prop.type !== "unique_id") normalised[prop.id] = normaliseCellValue(prop, value);
  });
  for (const hook of ACARD_FEATURES.beforeRowWrite) await hook({ db, database, properties, before, props: normalised });
  return { before, props: normalised };
}

function twoWayRelations(properties) {
  return properties.filter((prop) => prop.type === "relation" && prop.config.synced && prop.config.pair && prop.config.database);
}

// 양방향 관계 속성마다 상대 DB 와 짝 속성. 짝이 사라진 속성은 빠진다(그 값은 한쪽 방향처럼 행 JSON 에만 남는다).
async function relationPairs(db, properties) {
  const out = [];
  for (const prop of twoWayRelations(properties)) {
    const target = await readDatabaseBySlug(db, prop.config.database);
    if (!target) continue;
    const pairRow = await db.prepare("SELECT id, config FROM db_properties WHERE id = ? AND database_id = ?").bind(prop.config.pair, target.id).first();
    if (!pairRow) continue;
    out.push({ prop, target, pairId: String(pairRow.id), pairLimit: normaliseConfig("relation", parseJson(pairRow.config, {})).limit });
  }
  return out;
}

const likeId = (id) => '%"' + String(id) + '"%';
// 순환 가드: 새 부모(dst)의 조상에 이 행이 있으면 NOT NULL 열에 NULL 을 넣어 batch 전체를 실패시킨다(모든 저장소에서 통째 롤백).
// 잠금 문장 바로 뒤에 두므로 PostgreSQL 에서는 앞선 batch 가 커밋한 연결까지 보고 판단한다.
const CYCLE_GUARD = "INSERT INTO db_relation_locks (pair_key, version) SELECT '__cycle__', NULL WHERE CAST(? AS TEXT) = CAST(? AS TEXT) OR EXISTS (WITH RECURSIVE anc(id) AS (SELECT CAST(? AS TEXT) UNION SELECT l.dst_row FROM db_relation_links l JOIN anc ON l.src_row = anc.id WHERE l.prop_id = ?) SELECT 1 FROM anc WHERE anc.id = ?)";
const CYCLE_ERROR = "자기 자신이나 자기 하위 항목 아래로는 넣을 수 없어요.";
function isCycleError(error) {
  return !!error && (error.code === "23502" || /NOT NULL constraint failed: db_relation_locks\.version|"version"/.test(String(error.message || error)));
}

// 관계 값 쓰기(행 만들기·바꾸기·복제·반복 생성·MCP 가 모두 여기로 온다). 돌려주는 locks 는 batch 의 맨 앞에,
// statements 는 행 INSERT/UPDATE 뒤에 둔다. 연결 하나 = 엣지 두 줄(이쪽 속성→, 짝 속성→)이고, 양쪽 행 JSON 캐시는 같은 batch 끝에서
// 엣지로 다시 만든다. 읽고-비교하고-쓰기가 없어서 같은 상대 행을 동시에 고쳐도 서로 덮지 않는다. 상위 항목처럼 limit 1 인 같은 DB
// 관계는 새 연결이 순환을 만들면 조건부 INSERT 가 아무것도 넣지 않는다(check 가 나중에 알려 준다).
async function applyRowProps(db, database, properties, rowId, props, options = {}) {
  const pairs = await relationPairs(db, properties);
  const touched = pairs.filter(({ prop }) => (options.touched ? options.touched.has(prop.id) : (props[prop.id] || []).length > 0));
  const plans = [];
  for (const pair of touched) {
    const self = pair.target.id === database.id;
    const tree = self && (pair.prop.config.limit === 1 || pair.pairLimit === 1);
    let ids = Array.isArray(props[pair.prop.id]) ? props[pair.prop.id].map(String) : [];
    if (pair.prop.config.limit === 1) ids = ids.slice(-1);
    if (ids.length) {
      if (!canWriteSlug(db, pair.target.slug)) return { error: "상대 데이터베이스를 편집할 권한이 없어요.", status: 401 };
      const found = await db.prepare("SELECT id FROM db_rows WHERE database_id = ? AND id IN (" + ids.map(() => "?").join(", ") + ")").bind(pair.target.id, ...ids).all();
      const live = new Set((found.results ?? []).map((row) => String(row.id)));
      if (options.lenient) ids = ids.filter((id) => live.has(id));
      else if (ids.some((id) => !live.has(id))) return { error: "없는 행과는 연결할 수 없어요.", status: 400 };
      if (tree) {
        for (const dst of ids) {
          const loop = dst === rowId || await db.prepare("WITH RECURSIVE anc(id) AS (SELECT CAST(? AS TEXT) UNION SELECT l.dst_row FROM db_relation_links l JOIN anc ON l.src_row = anc.id WHERE l.prop_id = ?) SELECT 1 AS x FROM anc WHERE anc.id = ?").bind(dst, pair.prop.id, rowId).first();
          if (loop) return { error: CYCLE_ERROR, status: 400 };
        }
      }
    }
    const denied = await relationChangeDenied(db, pair, rowId, ids);
    if (denied) return denied;
    props[pair.prop.id] = ids;
    plans.push({ ...pair, ids, tree });
  }
  const locks = [];
  [...new Set(plans.map((plan) => relationPairKey(plan.prop.id, plan.pairId)))].sort().forEach((key) => {
    locks.push(db.prepare("INSERT OR IGNORE INTO db_relation_locks (pair_key, version) VALUES (?, 0)").bind(key));
    locks.push(db.prepare("UPDATE db_relation_locks SET version = version + 1 WHERE pair_key = ?").bind(key));
  });
  plans.filter((plan) => plan.tree).forEach((plan) => plan.ids.forEach((dst) => locks.push(db.prepare(CYCLE_GUARD).bind(dst, rowId, dst, plan.prop.id, rowId))));
  const statements = [];
  for (const plan of plans) {
    const P = plan.prop.id, Q = plan.pairId, ids = plan.ids;
    const marks = ids.map(() => "?").join(", ");
    statements.push(ids.length
      ? db.prepare("DELETE FROM db_relation_links WHERE prop_id = ? AND src_row = ? AND dst_row NOT IN (" + marks + ")").bind(P, rowId, ...ids)
      : db.prepare("DELETE FROM db_relation_links WHERE prop_id = ? AND src_row = ?").bind(P, rowId));
    statements.push(ids.length
      ? db.prepare("DELETE FROM db_relation_links WHERE prop_id = ? AND dst_row = ? AND src_row NOT IN (" + marks + ")").bind(Q, rowId, ...ids)
      : db.prepare("DELETE FROM db_relation_links WHERE prop_id = ? AND dst_row = ?").bind(Q, rowId));
    ids.forEach((dst, index) => {
      statements.push(db.prepare("INSERT INTO db_relation_links (prop_id, src_row, dst_row, ord) SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS INTEGER) WHERE EXISTS (SELECT 1 FROM db_rows r WHERE r.id = ? AND r.database_id = ?) ON CONFLICT (prop_id, src_row, dst_row) DO UPDATE SET ord = excluded.ord")
        .bind(P, rowId, dst, index, dst, plan.target.id));
      const forward = "EXISTS (SELECT 1 FROM db_relation_links f WHERE f.prop_id = ? AND f.src_row = ? AND f.dst_row = ?)";
      statements.push(db.prepare("INSERT INTO db_relation_links (prop_id, src_row, dst_row, ord) SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), (SELECT COALESCE(MAX(m.ord), -1) + 1 FROM db_relation_links m WHERE m.prop_id = ? AND m.src_row = ?) WHERE " + forward + " ON CONFLICT (prop_id, src_row, dst_row) DO NOTHING")
        .bind(Q, dst, rowId, Q, dst, P, rowId, dst));
      if (plan.pairLimit === 1) {
        // 상대 쪽이 연결 하나만 갖는 관계(예: 하위 항목에 넣으면 상위 항목이 바뀜): 그 행의 다른 연결을 양쪽에서 떼어 낸다.
        statements.push(db.prepare("DELETE FROM db_relation_links WHERE prop_id = ? AND src_row = ? AND dst_row <> ? AND " + forward).bind(Q, dst, rowId, P, rowId, dst));
        statements.push(db.prepare("DELETE FROM db_relation_links WHERE prop_id = ? AND dst_row = ? AND src_row <> ? AND " + forward.replace(/\bf\b/g, "g")).bind(P, dst, rowId, P, rowId, dst));
      }
    });
    const here = ["id = ?"].concat(plan.pairLimit === 1 ? ids.map(() => "props LIKE ?") : []).join(" OR ");
    statements.push(relationCacheStatement(db, P, "database_id = ? AND (" + here + ")", [database.id, rowId, ...(plan.pairLimit === 1 ? ids.map(likeId) : [])]));
    statements.push(relationCacheStatement(db, Q, "database_id = ? AND (" + (ids.length ? "id IN (" + marks + ") OR " : "") + "props LIKE ?)", [plan.target.id, ...ids, likeId(rowId)]));
  }
  // 이 행의 다른 양방향 값도 엣지에서 다시 만든다: 앞에서 읽은 행 JSON 을 통째로 쓰는 사이 다른 요청이 넣은 연결을 잃지 않는다.
  pairs.filter((pair) => !plans.some((plan) => plan.prop.id === pair.prop.id)).forEach((pair) => statements.push(relationCacheStatement(db, pair.prop.id, "id = ?", [rowId])));
  return { locks, statements };
}

// ---------- #86: 표 쓰기 권한은 여기서만 판정한다 ----------
// 공유 손님 요청만 db.acardRoles(페이지 slug -> none|read|comment|edit|full)를 갖는다. 소유자·에이전트·예약 실행은 권한 맵이 없어 언제나 된다.
// 행: 자기 페이지가 있으면 그 페이지의 역할, 없으면(ZIP·마크다운으로 가져온 행) 그 행이 속한 데이터베이스의 역할.
// 표의 행·속성·관계 값을 바꾸는 모든 경로는 쓰기(batch) 전에 아래 함수로만 판정하고, 하나라도 안 되면 아무것도 쓰지 않는다.
// tests/share.test.ts 의 전수 확인 테스트가 쓰기 경로 목록과 이 판정 위치를 지킨다.
const WRITE_ROLES = ["edit", "full"];
function canWriteSlug(db, slug) {
  return !db.acardRoles || WRITE_ROLES.includes(db.acardRoles.get(String(slug)) || "none");
}

// row: { page } (db_rows 의 page 열). databaseSlug: 그 행이 속한 데이터베이스.
function canWriteRow(db, row, databaseSlug) {
  return canWriteSlug(db, row.page !== null && row.page !== undefined ? row.page : databaseSlug);
}

// 새 행 만들기·버튼 대상처럼 데이터베이스 단위로 보는 경로.
function canEditDatabase(db, slug) {
  if (db.acardVisible && !db.acardVisible.has(String(slug))) return false;
  return canWriteSlug(db, slug);
}

// D1/SQLite 는 문장마다 바인드 값이 100개까지다. 행 id 목록은 이 크기로 나눠 보낸다.
const ID_CHUNK = 90;
function idChunks(ids, size = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// 이 행들(어느 데이터베이스든)을 모두 편집할 수 있으면 null, 아니면 401 오류 객체.
async function assertCanWriteRows(db, rowIds, error = "연결된 행을 편집할 권한이 없어요.") {
  if (!db.acardRoles || !rowIds.length) return null;
  for (const part of idChunks([...new Set(rowIds.map(String))])) {
    const rows = (await db.prepare("SELECT r.page, d.slug FROM db_rows r JOIN databases d ON d.id = r.database_id WHERE r.id IN (" + part.map(() => "?").join(", ") + ")").bind(...part).all()).results ?? [];
    if (rows.some((row) => !canWriteRow(db, row, row.slug))) return { error, status: 401 };
  }
  return null;
}

// 이 데이터베이스의 모든 행을 편집할 수 있으면 null(속성 타입 바꾸기·지우기처럼 모든 행 값을 바꾸는 경로용).
async function assertCanWriteAllRows(db, databaseId, error = "편집할 수 없는 행이 있어요.") {
  if (!db.acardRoles) return null;
  const rows = (await db.prepare("SELECT r.page, d.slug FROM db_rows r JOIN databases d ON d.id = r.database_id WHERE r.database_id = ?").bind(databaseId).all()).results ?? [];
  return rows.every((row) => canWriteRow(db, row, row.slug)) ? null : { error, status: 401 };
}

// #86: 양방향 관계 값을 ids 로 바꿀 때 값이 바뀌는 다른 행(새로 잇는 상대 행 + 끊기는 이전 상대 행, 상대 쪽이 연결 하나뿐이면
// 그 상대 행에서 떨어져 나가는 이쪽 다른 행까지) 모두에 행 편집 권한이 있어야 한다. 없으면 오류 객체, 있으면 null.
// rowId 가 null 이면 아직 없는 행(템플릿 저장)이다. 권한 맵이 없는 소유자 경로는 검사하지 않는다.
async function relationChangeDenied(db, pair, rowId, ids) {
  if (!db.acardRoles) return null;
  const linked = rowId === null ? { results: [] } : await db.prepare("SELECT dst_row AS id FROM db_relation_links WHERE prop_id = ? AND src_row = ? UNION SELECT src_row AS id FROM db_relation_links WHERE prop_id = ? AND dst_row = ?").bind(pair.prop.id, rowId, pair.pairId, rowId).all();
  const before = new Set((linked.results ?? []).map((row) => String(row.id)));
  const keep = new Set(ids);
  const added = ids.filter((id) => !before.has(id));
  const changed = [...added, ...[...before].filter((id) => !keep.has(id))];
  if (!changed.length) return null;
  if (!canWriteSlug(db, pair.target.slug)) return { error: "상대 데이터베이스를 편집할 권한이 없어요.", status: 401 };
  if (pair.pairLimit === 1 && added.length) {
    for (const part of idChunks(added)) {
      const stolen = await db.prepare("SELECT dst_row AS id FROM db_relation_links WHERE prop_id = ? AND src_row IN (" + part.map(() => "?").join(", ") + ") AND dst_row <> ?").bind(pair.pairId, ...part, rowId === null ? "" : rowId).all();
      changed.push(...(stolen.results ?? []).map((row) => String(row.id)));
    }
  }
  return await assertCanWriteRows(db, changed);
}

// ---------- #86: 템플릿 값은 저장한 사람의 권한으로만 링크가 된다 ----------
// 반복 실행(runDueTemplates)과 템플릿으로 행 만들기는 소유자 권한(권한 맵 없음)으로 돈다. 그래서 링크를 만들기 직전에 그 값을 저장한
// 사람(db_template_savers)의 권한으로 다시 본다. 손님 권한 = 저장할 때 편집할 수 있던 페이지와 지금 편집할 수 있는 페이지의 교집합.
// 저장한 사람을 다시 확인할 수 없으면(세션이 끝남·지워짐, 기록을 못 읽음, 공유 규칙이 빠짐·좁아짐) 거부한다: 아무것도 쓰지 않고
// 이유를 blocked 에 남기며, 값을 다시 저장할 때까지 계속 멈춘다(다른 권한을 빌려 쓰지 않는다).
// 저장한 사람 기록이 없는 예전 템플릿은, 이 데이터베이스를 편집할 수 있던 손님이 한 번이라도 있었고 양방향 관계 값이 있으면 멈춘다.
// blocked 값(멈춘 이유): legacy 저장한 사람 기록 없음 | unreadable 기록을 못 읽음 | session 공유 세션이 끝남·지워짐 |
// database 그 데이터베이스를 편집할 수 없음 | rows 연결된 행을 편집할 수 없음.
const TEMPLATE_STOPPED = "권한 문제로 멈춘 템플릿이에요. 템플릿을 새로 만들어 주세요.";

function templateSaverStatement(db, templateId) {
  const roles = {};
  if (db.acardRoles) for (const [slug, role] of db.acardRoles) if (WRITE_ROLES.includes(role)) roles[slug] = role;
  const env = db.acardSaver || {};
  return db.prepare("INSERT INTO db_template_savers (template_id, kind, session, email, roles, saved, blocked, blocked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT (template_id) DO UPDATE SET kind = excluded.kind, session = excluded.session, email = excluded.email, roles = excluded.roles, saved = excluded.saved, blocked = NULL, blocked_at = NULL")
    .bind(templateId, db.acardRoles ? "guest" : "owner", db.acardRoles ? env.session || null : null, db.acardRoles ? env.email || null : null, JSON.stringify(roles), Date.now());
}

// 이 데이터베이스(또는 그 상위 페이지)에 손님 편집 규칙이 한 번이라도 있었는지(지금 꺼졌거나 끝난 규칙, 상속 끊김 위쪽 규칙도 센다).
async function guestEverEdited(db, slug) {
  const chain = [];
  let current = slug;
  for (let i = 0; current && i < 64 && !chain.includes(current); i += 1) {
    chain.push(current);
    const row = await db.prepare("SELECT parent FROM pages WHERE slug = ?").bind(current).first();
    current = row && row.parent ? String(row.parent) : null;
  }
  try {
    return !!(await db.prepare("SELECT 1 AS x FROM share_rules WHERE page IN (" + chain.map(() => "?").join(", ") + ") AND role IN ('edit', 'full') AND principal NOT LIKE 'agent:%' AND principal <> 'publish' LIMIT 1").bind(...chain).first());
  } catch {
    return true;
  }
}

// null 이면 이 값으로 링크를 만들어도 된다. 아니면 멈춘 이유(그리고 blocked 를 남긴다).
async function templateSaverDenied(db, database, properties, templateId, props) {
  const saver = await db.prepare("SELECT kind, session, email, roles, blocked FROM db_template_savers WHERE template_id = ?").bind(templateId).first();
  const reason = saver && saver.blocked ? String(saver.blocked) : await templateSaverReason(db, database, properties, saver, props);
  if (!reason) return null;
  if (!saver || !saver.blocked) {
    console.warn("acard template stopped", templateId, reason);
    await db.prepare("INSERT INTO db_template_savers (template_id, kind, saved, blocked, blocked_at) VALUES (?, 'legacy', 0, ?, ?) ON CONFLICT (template_id) DO UPDATE SET blocked = excluded.blocked, blocked_at = excluded.blocked_at")
      .bind(templateId, reason, Date.now()).run();
  }
  return reason;
}

async function templateSaverReason(db, database, properties, saver, props) {
  const pairs = await relationPairs(db, properties);
  const linked = pairs.map((pair) => {
    let ids = Array.isArray(props[pair.prop.id]) ? props[pair.prop.id].map(String) : [];
    if (pair.prop.config.limit === 1) ids = ids.slice(-1);
    return { pair, ids };
  }).filter((entry) => entry.ids.length);
  if (!saver || saver.kind === "legacy") return linked.length && await guestEverEdited(db, database.slug) ? "legacy" : null;
  if (saver.kind === "owner") return null;
  const resolved = await guestSaverRoles(db, saver);
  if (resolved.reason) return resolved.reason;
  const as = { prepare: (sql) => db.prepare(sql), batch: (list) => db.batch(list), dialect: db.dialect, acardKey: db.acardKey, acardRoles: resolved.roles };
  if (!canWriteSlug(as, database.slug)) return "database";
  for (const { pair, ids } of linked) {
    if (await relationChangeDenied(as, pair, null, ids)) return "rows";
  }
  return null;
}

// 손님이 저장한 값(템플릿·버튼 동작)의 권한: 저장할 때 편집할 수 있던 페이지와 지금 편집할 수 있는 페이지의 교집합(edit|full 만).
// 기록을 못 읽으면 { reason: "unreadable" }, 세션이 끝났거나 지워졌으면 { reason: "session" }.
async function guestSaverRoles(db, saver) {
  let saved = null;
  try { saved = saver.kind === "guest" ? JSON.parse(String(saver.roles)) : null; } catch { saved = null; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || !saver.session || !saver.email) return { reason: "unreadable" };
  const roleMap = ACARD_FEATURES.services.guestRoles ? await ACARD_FEATURES.services.guestRoles(db, String(saver.session), String(saver.email)) : null;
  if (!roleMap) return { reason: "session" };
  const roles = new Map();
  for (const [slug, role] of Object.entries(saved)) {
    const now = roleMap.get(slug) || "none";
    const narrower = WRITE_ROLES.indexOf(now) < 0 ? "none" : WRITE_ROLES.indexOf(String(role)) < WRITE_ROLES.indexOf(now) ? String(role) : now;
    if (WRITE_ROLES.includes(narrower)) roles.set(slug, narrower);
  }
  return { roles };
}

// 템플릿 값의 저장 형태(#86): 키는 속성 id 만, 관계 값은 연결할 행 id 목록(limit 1 이면 마지막 하나)이다. 템플릿 POST·PATCH 가
// 저장 전에 이 형태로 바꾸고, 권한 검사(templateRelationsDenied)와 실행(runDueTemplates, 템플릿으로 행 만들기)은 저장된 이 값만
// 읽는다. 그래서 저장 뒤 속성 이름이나 limit 이 바뀌어도 검사한 값과 나중에 쓰는 값이 같다.
// 요청 값(strict)은 맞는 속성이 없는 키나 연결할 수 없는 관계 값("a,b", {id}, 숫자, true, 없는 행)이면 400 이다. 이미 저장된
// 값(lenient, 예전 템플릿)은 그런 키·값을 버린다.
async function canonicalTemplateProps(db, database, raw, options = {}) {
  const values = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const properties = await readProperties(db, database.id);
  const byId = new Map(properties.map((prop) => [prop.id, prop]));
  const byName = new Map(properties.map((prop) => [prop.name, prop]));
  const props = {};
  for (const key of Object.keys(values)) {
    // #86 N5: 이름 키는 그 이름의 속성이 하나일 때만 id 로 바꾼다. 둘 이상이면 어느 쪽인지 모르므로 거부한다.
    if (!byId.has(key) && properties.filter((entry) => entry.name === key).length > 1) {
      if (options.lenient) continue;
      return { error: "이름이 같은 속성이 여럿이에요. 속성 id 로 보내 주세요.", status: 400 };
    }
    const prop = byId.get(key) || byName.get(key);
    if (!prop) {
      if (options.lenient) continue;
      return { error: "없는 속성이에요.", status: 400 };
    }
    // 같은 속성을 id 와 이름으로 둘 다 주면 id 키가 이긴다(행 만들기와 같은 규칙).
    if (!byId.has(key) && values[prop.id] !== undefined) continue;
    const value = values[key];
    if (value === undefined || prop.type === "unique_id") continue;
    if (prop.type !== "relation") { props[prop.id] = value; continue; }
    const list = value === null || value === "" ? [] : Array.isArray(value) ? value : [value];
    if (list.some((entry) => typeof entry !== "string")) {
      if (!options.lenient) return { error: "없는 행과는 연결할 수 없어요.", status: 400 };
    }
    let ids = normaliseCellValue(prop, list.filter((entry) => typeof entry === "string"));
    if (prop.config.limit === 1) ids = ids.slice(-1);
    const target = ids.length ? await readDatabaseBySlug(db, prop.config.database) : null;
    if (ids.length && !target) {
      if (!options.lenient) return { error: "없는 행과는 연결할 수 없어요.", status: 400 };
      ids = [];
    }
    if (ids.length) {
      const live = new Set();
      for (const part of idChunks(ids)) {
        const found = await db.prepare("SELECT id FROM db_rows WHERE database_id = ? AND id IN (" + part.map(() => "?").join(", ") + ")").bind(target.id, ...part).all();
        (found.results ?? []).forEach((row) => live.add(String(row.id)));
      }
      if (ids.some((id) => !live.has(id))) {
        if (!options.lenient) return { error: "없는 행과는 연결할 수 없어요.", status: 400 };
        ids = ids.filter((id) => live.has(id));
      }
    }
    props[prop.id] = ids;
  }
  return { props };
}

// #86 B10: 예전 빌드가 저장한 템플릿을 지금 저장 형태로 바꾸는 한 번짜리 이전(/__templates/migrate). 반복이 켜진 템플릿부터
// canonicalTemplateProps(lenient)로 정리하고, 바뀐 템플릿은 원래 props 를 db_value_backups(kind template, reason migrate)에 남긴다.
// 전후로 legacyTemplateCounts 를 센다: i 관계 속성 id 키 값이 문자열, ii limit 1 관계인데 id 가 2개 이상,
// iii 관계 값 id 가 그 관계가 가리키는 데이터베이스의 행이 아님. 이전 뒤에는 셋 다 0 이어야 한다. 다시 돌리면 바뀌는 것이 없다.
async function legacyTemplateCounts(db) {
  const found = { i: new Set(), ii: new Set(), iii: new Set() };
  const templates = (await db.prepare("SELECT id, database_id, props FROM db_templates").all()).results ?? [];
  const propsOf = new Map();
  for (const template of templates) {
    if (!propsOf.has(template.database_id)) propsOf.set(template.database_id, await readProperties(db, template.database_id));
    const values = parseJson(template.props, {});
    for (const prop of propsOf.get(template.database_id).filter((entry) => entry.type === "relation")) {
      const value = values && typeof values === "object" ? values[prop.id] : undefined;
      if (value === undefined || value === null) continue;
      if (typeof value === "string") found.i.add(template.id);
      if (prop.config.limit === 1 && Array.isArray(value) && value.length >= 2) found.ii.add(template.id);
      const ids = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
      if (!ids.length) continue;
      const target = await readDatabaseBySlug(db, prop.config.database);
      if (!target) { found.iii.add(template.id); continue; }
      for (const part of idChunks(ids)) {
        const live = (await db.prepare("SELECT COUNT(*) AS n FROM db_rows WHERE database_id = ? AND id IN (" + part.map(() => "?").join(", ") + ")").bind(target.id, ...part).first());
        if (Number(live && live.n) !== new Set(part).size) found.iii.add(template.id);
      }
    }
  }
  return { i: found.i.size, ii: found.ii.size, iii: found.iii.size };
}

async function migrateTemplates(db) {
  const before = await legacyTemplateCounts(db);
  const templates = (await db.prepare("SELECT t.id, t.props, t.recurrence, d.id AS database_id, d.slug FROM db_templates t JOIN databases d ON d.id = t.database_id").all()).results ?? [];
  templates.sort((a, b) => (a.recurrence ? 0 : 1) - (b.recurrence ? 0 : 1));
  const changed = [];
  for (const template of templates) {
    const original = parseJson(template.props, {});
    const canonical = await canonicalTemplateProps(db, { id: template.database_id, slug: template.slug }, original, { lenient: true });
    if (JSON.stringify(canonical.props) === JSON.stringify(original)) continue;
    await db.batch([
      db.prepare("INSERT INTO db_value_backups (id, database_id, prop_id, kind, ref, value, reason, created) VALUES (?, ?, '', 'template', ?, ?, 'migrate', ?)")
        .bind(dbId("k") + changed.length, template.database_id, template.id, String(template.props ?? "null"), Date.now()),
      db.prepare("UPDATE db_templates SET props = ? WHERE id = ?").bind(JSON.stringify(canonical.props), template.id),
    ]);
    changed.push(String(template.id));
  }
  return { before, after: await legacyTemplateCounts(db), changed, backup_table: "db_value_backups" };
}

// 템플릿의 양방향 관계 값은 나중에 만드는 행(반복 생성은 소유자 권한으로 돈다)이 그 상대 행에 연결을 더한다(#86):
// 저장하는 사람이 그 상대 행을 편집할 수 있을 때만 저장한다. values 는 canonicalTemplateProps 를 거친 저장될 값이고,
// 자르지 않고 저장될 id 전부를 본다.
async function templateRelationsDenied(db, database, values) {
  if (!db.acardRoles) return null;
  for (const pair of await relationPairs(db, await readProperties(db, database.id))) {
    const raw = values ? values[pair.prop.id] : undefined;
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    if (!ids.length) continue;
    const denied = await relationChangeDenied(db, pair, null, ids);
    if (denied) return denied;
  }
  return null;
}

// 행(들) 지우기: 행·행 페이지·엣지를 지우고 상대 쪽 캐시를 다시 만드는 것까지 한 batch.
async function deleteRowsWithRelations(db, database, rowIds) {
  if (!rowIds.length) return;
  const marks = rowIds.map(() => "?").join(", ");
  const rows = (await db.prepare("SELECT page FROM db_rows WHERE database_id = ? AND id IN (" + marks + ")").bind(database.id, ...rowIds).all()).results ?? [];
  if (rows.some((row) => !canWriteRow(db, row, database.slug))) return { error: "이 행을 편집할 권한이 없어요.", status: 401 };
  if (db.acardRoles) {
    // 지우는 행과 양방향으로 이어진 상대 행(다른 데이터베이스의 페이지 없는 행 포함)은 관계 값이 바뀐다(#86): 그 행들도 편집할 수 있어야 지운다.
    const linked = await db.prepare("SELECT dst_row AS id FROM db_relation_links WHERE src_row IN (" + marks + ") UNION SELECT src_row AS id FROM db_relation_links WHERE dst_row IN (" + marks + ")").bind(...rowIds, ...rowIds).all();
    const gone = new Set(rowIds.map(String));
    const denied = await assertCanWriteRows(db, (linked.results ?? []).map((row) => String(row.id)).filter((id) => !gone.has(id)));
    if (denied) return denied;
  }
  const pages = rows.filter((row) => row.page !== null).map((row) => String(row.page));
  const relations = await rowDeleteRelationStatements(db, database, rowIds);
  const pageMarks = pages.map(() => "?").join(", ");
  await db.batch([
    ...relations.locks,
    db.prepare("DELETE FROM db_rows WHERE database_id = ? AND id IN (" + marks + ")").bind(database.id, ...rowIds),
    ...(pages.length ? [
      db.prepare("DELETE FROM blocks WHERE page IN (" + pageMarks + ")").bind(...pages),
      db.prepare("DELETE FROM links WHERE src IN (" + pageMarks + ") OR dst IN (" + pageMarks + ")").bind(...pages, ...pages),
      db.prepare("DELETE FROM pages WHERE kind = 'db_row' AND slug IN (" + pageMarks + ")").bind(...pages),
    ] : []),
    ...relations.statements,
  ]);
}

// 행(들)을 지울 때: 그 행이 들어간 엣지를 지우고, 그 행을 캐시에 들고 있는 상대 행(같은 DB 자기 참조 포함)을 다시 만든다.
async function rowDeleteRelationStatements(db, database, rowIds) {
  const pairs = await relationPairs(db, await readProperties(db, database.id));
  if (!pairs.length || !rowIds.length) return { locks: [], statements: [] };
  const locks = [];
  [...new Set(pairs.map((pair) => relationPairKey(pair.prop.id, pair.pairId)))].sort().forEach((key) => {
    locks.push(db.prepare("INSERT OR IGNORE INTO db_relation_locks (pair_key, version) VALUES (?, 0)").bind(key));
    locks.push(db.prepare("UPDATE db_relation_locks SET version = version + 1 WHERE pair_key = ?").bind(key));
  });
  // 행이 많으면(데이터베이스 지우기) 바인드 값 한도 안에서 나눠 지우고, 나눈 묶음마다 그 행을 들고 있던 캐시를 다시 만든다.
  const statements = [];
  for (const part of idChunks(rowIds, 45)) {
    const marks = part.map(() => "?").join(", ");
    statements.push(db.prepare("DELETE FROM db_relation_links WHERE src_row IN (" + marks + ") OR dst_row IN (" + marks + ")").bind(...part, ...part));
    const likes = part.map(() => "props LIKE ?").join(" OR ");
    for (const pair of pairs) {
      statements.push(relationCacheStatement(db, pair.pairId, "database_id = ? AND (" + likes + ")", [pair.target.id, ...part.map(likeId)]));
      if (pair.target.id === database.id) statements.push(relationCacheStatement(db, pair.prop.id, "database_id = ? AND (" + likes + ")", [database.id, ...part.map(likeId)]));
    }
  }
  return { locks, statements };
}

// ID 속성(unique_id): 번호는 db_counters 의 한 줄을 UPDATE ... RETURNING 으로 올려 받는다. 한 문장이라 동시에 만든
// 행도 같은 번호를 받지 않고, 속성 config 를 통째로 저장(saveProperties)해도 카운터는 되돌아가지 않는다.
async function nextUniqueId(db, databaseId, propId) {
  const take = () => db.prepare("UPDATE db_counters SET next = next + 1 WHERE property_id = ? RETURNING next - 1 AS n").bind(propId).first();
  let got = await take();
  if (!got) { await ensureUniqueIds(db, databaseId, propId, false); got = await take(); }
  return got && Number.isFinite(Number(got.n)) ? Number(got.n) : null;
}

// 카운터가 없으면 만들고, 번호가 없는 행(all 이면 모든 행)에 생성 순서대로 번호를 한 번에 예약해 붙인다.
async function ensureUniqueIds(db, databaseId, propId, all) {
  await db.prepare("INSERT INTO db_counters (property_id, next) VALUES (?, 1) ON CONFLICT(property_id) DO NOTHING").bind(propId).run();
  const rows = await db.prepare("SELECT id, props FROM db_rows WHERE database_id = ? ORDER BY ord, created, id").bind(databaseId).all();
  const missing = (rows.results ?? []).filter((row) => {
    if (all) return true;
    const value = parseJson(row.props, {})[propId];
    return !(Number.isInteger(value) && value > 0);
  });
  if (!missing.length) return;
  const reserved = await db.prepare("UPDATE db_counters SET next = next + ? WHERE property_id = ? RETURNING next - ? AS n").bind(missing.length, propId, missing.length).first();
  const start = reserved ? Number(reserved.n) : 1;
  await db.batch(missing.map((row, index) => {
    const props = parseJson(row.props, {});
    props[propId] = start + index;
    return db.prepare("UPDATE db_rows SET props = ? WHERE id = ?").bind(JSON.stringify(props), row.id);
  }));
}

async function createDatabase(db, input) {
  const title = String((input && input.title) || "새 데이터베이스").trim().slice(0, 200) || "새 데이터베이스";
  let slug = slugify(input && input.slug ? input.slug : title);
  const taken = await db.prepare("SELECT slug FROM databases WHERE slug = ?").bind(slug).first();
  if (taken) slug = slug + "-" + Math.random().toString(36).slice(2, 6);
  const parent = input && input.parent ? String(input.parent) : null;
  const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM databases WHERE parent IS ?").bind(parent).first();
  const now = Date.now();
  const id = dbId("d");
  await db.prepare("INSERT INTO databases (id, slug, title, icon, parent, ord, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, slug, title, String((input && input.icon) || "").slice(0, 8), parent, Number(maxRow && maxRow.m ? maxRow.m : 0) + 10, now, now).run();
  const seedProperties = Array.isArray(input && input.properties) && input.properties.length
    ? input.properties
    : [
      { id: "title", name: "이름", type: "title" },
      { id: "status", name: "상태", type: "status" },
    ];
  await saveProperties(db, id, seedProperties);
  await db.prepare("INSERT INTO db_views (id, database_id, name, type, config, ord) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(scopedId(id, dbId("v")), id, "표", "table", JSON.stringify({ filter: null, sorts: [], group_by: null, visible: null, widths: {}, calculations: {} }), 0).run();
  return { id, slug, title, parent };
}

// ---------- 양방향 관계(C2) ----------

function relationPairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

// 한 관계 속성의 행 JSON 캐시를 엣지 표에서 다시 만든다(ord 순). where 는 "database_id = ?" 또는 "id IN (...)".
// pg-d1 은 JSON 함수를 바꾸지 않으므로 방언별 문장을 쓴다(props 는 두 쪽 모두 TEXT 열).
function relationCacheStatement(db, propId, where, binds) {
  const value = db.dialect === "pg"
    ? "(COALESCE(props, '{}')::jsonb || jsonb_build_object(?::text, COALESCE((SELECT jsonb_agg(l.dst_row ORDER BY l.ord, l.dst_row) FROM db_relation_links l WHERE l.prop_id = ? AND l.src_row = db_rows.id), '[]'::jsonb)))::text"
    : "json_set(COALESCE(props, '{}'), '$.' || json_quote(?), COALESCE((SELECT json_group_array(dst_row) FROM (SELECT l.dst_row FROM db_relation_links l WHERE l.prop_id = ? AND l.src_row = db_rows.id ORDER BY l.ord, l.dst_row)), json('[]')))";
  return db.prepare("UPDATE db_rows SET props = " + value + " WHERE " + where).bind(propId, propId, ...binds);
}

async function readDatabaseBySlug(db, slug) {
  return slug ? await db.prepare("SELECT id, slug, title FROM databases WHERE slug = ?").bind(String(slug)).first() : null;
}

// #86: 관계가 아닌 속성을 관계로 바꿀 때, 그 속성에 남아 있던 행 셀·템플릿 값은 링크로 바꾸지 않는다. 그 값은 관계로 검사된 적이
// 없고(누가 넣었는지도 모른다) 바꾸면 소유자 권한으로 비공개 행과 연결될 수 있다. 값을 db_value_backups 에 남기고 비우는 문장과
// 남긴 수를 돌려준다. 문장은 타입을 바꾸는 batch 에 같이 넣어, 타입만 바뀌고 값이 남는 순간이 없게 한다.
// 템플릿은 id 키와 예전 이름 키(현재 이름) 둘 다 본다.
// reason "delete"(#86 B11): 속성을 지울 때도 같은 값을 옮기고 행에서는 키를 지운다. 남겨 두면 같은 id 로 관계 속성을 다시 만들 때
// 그 값이 검사 없이 링크가 된다.
async function relationConversionStatements(db, database, current, reason = "to_relation") {
  const filled = (value) => value !== undefined && value !== null && value !== "" && value !== false && !(Array.isArray(value) && !value.length);
  const now = Date.now();
  const statements = [];
  let count = 0;
  const keep = (kind, ref, value) => {
    count += 1;
    statements.push(db.prepare("INSERT INTO db_value_backups (id, database_id, prop_id, kind, ref, value, reason, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(dbId("k") + count, database.id, current.id, kind, String(ref), JSON.stringify(value), reason, now));
  };
  const rows = (await db.prepare("SELECT id, props FROM db_rows WHERE database_id = ?").bind(database.id).all()).results ?? [];
  for (const row of rows) {
    const props = parseJson(row.props, {});
    if (!filled(props[current.id])) continue;
    keep("row", row.id, props[current.id]);
    if (reason === "delete") delete props[current.id];
    else props[current.id] = [];
    statements.push(db.prepare("UPDATE db_rows SET props = ?, updated = ? WHERE id = ?").bind(JSON.stringify(props), now, row.id));
  }
  const templates = (await db.prepare("SELECT id, props FROM db_templates WHERE database_id = ?").bind(database.id).all()).results ?? [];
  for (const template of templates) {
    const props = parseJson(template.props, {});
    const keys = [current.id, current.name].filter((key) => Object.prototype.hasOwnProperty.call(props, key));
    if (!keys.length) continue;
    const kept = {};
    keys.forEach((key) => { if (filled(props[key])) kept[key] = props[key]; delete props[key]; });
    if (Object.keys(kept).length) keep("template", template.id, kept[current.id] !== undefined && Object.keys(kept).length === 1 ? kept[current.id] : kept);
    statements.push(db.prepare("UPDATE db_templates SET props = ? WHERE id = ?").bind(JSON.stringify(props), template.id));
  }
  return { statements, count };
}

// 양방향 켜기: 상대 DB 에 짝 속성을 만들고, 이쪽 행의 기존 연결로 엣지를 채우고, 양쪽 캐시를 다시 만든다. 한 batch.
// options.before: 같은 batch 맨 앞에 넣을 문장(관계로 바꾸며 예전 값을 비우는 문장). options.fresh: 관계가 아니던 속성이라
// 기존 값으로 엣지를 만들지 않는다.
async function enableRelationPair(db, database, current, next, options) {
  const target = await readDatabaseBySlug(db, next.config.database);
  if (!target) return { error: "연결할 데이터베이스를 찾지 못했어요.", status: 400 };
  if (!canWriteSlug(db, target.slug)) return { error: "상대 데이터베이스를 편집할 권한이 없어요.", status: 401 };
  // 짝 속성은 상대 DB 의 모든 행 값을, 채우는 엣지는 이쪽 행 값을 다시 쓴다(#86): 두 DB 의 모든 행을 편집할 수 있어야 한다.
  const message = "편집할 수 없는 행이 있어서 양방향으로 바꿀 수 없어요.";
  const denied = await assertCanWriteAllRows(db, database.id, message) || await assertCanWriteAllRows(db, target.id, message);
  if (denied) return denied;
  const targetProps = await readProperties(db, target.id);
  const pairId = scopedId(target.id, dbId("p"));
  const pairName = String(options.pairName || "").trim().slice(0, 120) || database.title || "관계";
  const pair = normaliseProperty({
    id: pairId, name: pairName, type: "relation",
    config: { database: database.slug, synced: true, pair: current.id, limit: options.pairLimit === 1 ? 1 : null },
    ord: (targetProps.length ? Math.max(...targetProps.map((entry) => entry.ord)) : 0) + 10,
  }, targetProps.length);
  next.config = Object.assign({}, next.config, { synced: true, pair: pairId });
  const sourceRows = (await db.prepare("SELECT id, props, ord FROM db_rows WHERE database_id = ? ORDER BY ord, created").bind(database.id).all()).results ?? [];
  const targetIds = new Set(((await db.prepare("SELECT id FROM db_rows WHERE database_id = ?").bind(target.id).all()).results ?? []).map((row) => String(row.id)));
  const edges = new Map();
  if (!options.fresh) sourceRows.forEach((row, rowIndex) => {
    const ids = parseJson(row.props, {})[current.id];
    (Array.isArray(ids) ? ids : []).map(String).filter((id) => targetIds.has(id)).forEach((dst, index) => {
      edges.set(current.id + "\n" + row.id + "\n" + dst, [current.id, String(row.id), dst, index]);
      edges.set(pairId + "\n" + dst + "\n" + row.id, [pairId, dst, String(row.id), rowIndex]);
    });
  });
  const statements = [
    ...(options.before || []),
    db.prepare("INSERT OR IGNORE INTO db_relation_locks (pair_key, version) VALUES (?, 0)").bind(relationPairKey(current.id, pairId)),
    db.prepare("UPDATE db_relation_locks SET version = version + 1 WHERE pair_key = ?").bind(relationPairKey(current.id, pairId)),
    db.prepare("UPDATE db_properties SET name = ?, type = ?, config = ?, ord = ?, width = ?, hidden = ? WHERE id = ?")
      .bind(next.name, next.type, JSON.stringify(next.config), next.ord, next.width, next.hidden ? 1 : 0, current.id),
    db.prepare("INSERT INTO db_properties (id, database_id, name, type, config, ord, width, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(pair.id, target.id, pair.name, pair.type, JSON.stringify(pair.config), pair.ord, pair.width, 0),
    db.prepare("DELETE FROM db_relation_links WHERE prop_id IN (?, ?)").bind(current.id, pairId),
    ...multiRowInsert(db, "INSERT OR IGNORE INTO db_relation_links (prop_id, src_row, dst_row, ord) VALUES %VALUES%", 4, [...edges.values()]),
    relationCacheStatement(db, current.id, "database_id = ?", [database.id]),
    relationCacheStatement(db, pairId, "database_id = ?", [target.id]),
  ];
  await db.batch(statements);
  return { property: next, pair };
}

// #107: 이 양방향 관계(양쪽 속성)의 연결에 걸린 행을 모두 편집할 수 있으면 null, 아니면 401 오류 객체.
async function assertCanWriteLinkedRows(db, prop, error) {
  if (!db.acardRoles) return null;
  const ids = String(prop.config.pair || "") ? [prop.id, String(prop.config.pair)] : [prop.id];
  const marks = ids.map(() => "?").join(", ");
  const rows = (await db.prepare("SELECT src_row AS id FROM db_relation_links WHERE prop_id IN (" + marks + ") UNION SELECT dst_row AS id FROM db_relation_links WHERE prop_id IN (" + marks + ")").bind(...ids, ...ids).all()).results ?? [];
  return await assertCanWriteRows(db, rows.map((row) => String(row.id)), error);
}

// 양방향 끄기: 엣지·잠금 줄을 지우고, dropPair 면 짝 속성도 지운다. 아니면 짝은 단방향으로 남는다(값은 캐시 그대로).
async function disableRelationPairStatements(db, current, dropPair) {
  // #86: 짝은 상대 DB 에 있고 이 속성을 되가리키는 속성일 때만 짝이다. 아니면 이 속성의 엣지만 지운다.
  const target = await readDatabaseBySlug(db, current.config.database);
  const candidate = current.config.pair ? await db.prepare("SELECT id, config, database_id FROM db_properties WHERE id = ?").bind(String(current.config.pair)).first() : null;
  const pairRow = candidate && target && String(candidate.database_id) === String(target.id) && String(parseJson(candidate.config, {}).pair || "") === String(current.id) ? candidate : null;
  const pairId = pairRow ? String(pairRow.id) : "";
  const statements = [
    pairRow ? db.prepare("DELETE FROM db_relation_links WHERE prop_id IN (?, ?)").bind(current.id, pairId) : db.prepare("DELETE FROM db_relation_links WHERE prop_id = ?").bind(current.id),
    db.prepare("DELETE FROM db_relation_locks WHERE pair_key = ?").bind(relationPairKey(current.id, String(current.config.pair || ""))),
  ];
  if (pairRow && dropPair) statements.push(db.prepare("DELETE FROM db_properties WHERE id = ?").bind(pairId));
  else if (pairRow) {
    const config = Object.assign({}, parseJson(pairRow.config, {}), { synced: false, pair: "" });
    statements.push(db.prepare("UPDATE db_properties SET config = ? WHERE id = ?").bind(JSON.stringify(config), pairId));
  }
  return statements;
}

// ---------- 사람 속성(C10) ----------

// 이 DB 페이지에서 지정할 수 있는 사람: 워크스페이스 소유자 + 이 DB 페이지(또는 조상)에 걸린 이메일 공유 규칙. 다른 페이지에만
// 초대된 사람은 들어가지 않는다. 소유자·전체 허용 손님은 전체를, 편집 손님은 자기 자신 + 이미 값에 들어간 사람만 받는다.
async function personCandidates(db, env, database) {
  const shared = ACARD_FEATURES.services.dbPeople ? await ACARD_FEATURES.services.dbPeople(db, database.slug) : [];
  // 손님 요청에는 소유자 로그인 정보가 없으므로, 소유자가 이 목록을 볼 때 워크스페이스 meta 에 이메일을 적어 두고 손님은 그것을 쓴다.
  let owner = env.ACARD_USER_EMAIL && !env.ACARD_GUEST_EMAIL ? String(env.ACARD_USER_EMAIL).toLowerCase() : "";
  if (owner) await db.prepare("INSERT INTO meta (key, value) VALUES ('owner-email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(owner).run().catch(() => {});
  else owner = String((await db.prepare("SELECT value FROM meta WHERE key = 'owner-email'").first().catch(() => null))?.value || "").toLowerCase();
  const all = new Map();
  if (owner) all.set(owner, { email: owner, owner: true });
  for (const entry of shared) if (!all.has(entry.email)) all.set(entry.email, { email: entry.email, role: entry.role });
  const role = db.acardRoles ? db.acardRoles.get(database.slug) || "none" : "full";
  if (role === "full") return { role, people: [...all.values()] };
  const me = env.ACARD_GUEST_EMAIL ? String(env.ACARD_GUEST_EMAIL).toLowerCase() : "";
  const used = new Set();
  const props = (await readProperties(db, database.id)).filter((prop) => prop.type === "person");
  if (props.length) {
    const rows = await db.prepare("SELECT props FROM db_rows WHERE database_id = ?").bind(database.id).all();
    for (const row of rows.results ?? []) {
      const values = parseJson(row.props, {});
      for (const prop of props) for (const email of Array.isArray(values[prop.id]) ? values[prop.id] : []) used.add(String(email).toLowerCase());
    }
  }
  const people = [...all.values()].filter((entry) => entry.email === me || used.has(entry.email));
  if (me && !people.some((entry) => entry.email === me)) people.unshift({ email: me });
  return { role, people };
}

// 사람 값 저장 전: 새로 들어온 이메일은 후보 안에 있어야 한다(이미 저장돼 있던 값은 그대로 둘 수 있다).
async function personGuard(db, env, database, properties, before, props) {
  const people = properties.filter((prop) => prop.type === "person");
  if (!people.length) return null;
  let allowed = null;
  for (const prop of people) {
    const kept = new Set((Array.isArray(before && before[prop.id]) ? before[prop.id] : []).map((email) => String(email).toLowerCase()));
    const fresh = (Array.isArray(props[prop.id]) ? props[prop.id] : []).filter((email) => !kept.has(email));
    if (!fresh.length) continue;
    if (!allowed) allowed = new Set((await personCandidates(db, env, database)).people.map((entry) => entry.email));
    if (fresh.some((email) => !allowed.has(email))) return "이 페이지를 공유받지 않은 사람은 지정할 수 없어요.";
  }
  return null;
}

// 하위 항목 켜기: 같은 DB 에 양방향 관계 한 쌍(상위 항목 limit 1 ↔ 하위 항목)을 만들고 databases.config.subitems 에 적는다.
// 이미 켜져 있고 두 속성이 살아 있으면 그대로 둔다. 끄기는 설정만 지우고 두 속성은 일반 관계로 남긴다(값을 잃지 않음).
async function switchSubitems(db, database, on) {
  const row = await db.prepare("SELECT config FROM databases WHERE id = ?").bind(database.id).first();
  const config = normaliseDatabaseConfig(parseJson(row && row.config, {}));
  if (!on) {
    const next = Object.assign({}, config); delete next.subitems;
    await db.prepare("UPDATE databases SET config = ?, updated = ? WHERE id = ?").bind(JSON.stringify(next), Date.now(), database.id).run();
    return { config: next };
  }
  const properties = await readProperties(db, database.id);
  const current = config.subitems && properties.find((prop) => prop.id === config.subitems.parent);
  if (current && properties.some((prop) => prop.id === config.subitems.children)) return { config };
  // #86: 켜기는 이 DB 의 모든 행 값을 다시 쓴다. 속성을 넣기 전에 본다.
  const denied = await assertCanWriteAllRows(db, database.id, "편집할 수 없는 행이 있어서 양방향으로 바꿀 수 없어요.");
  if (denied) return denied;
  const parentId = scopedId(database.id, dbId("p"));
  const ord = (properties.length ? Math.max(...properties.map((prop) => prop.ord)) : 0) + 10;
  const parent = normaliseProperty({ id: parentId, name: "상위 항목", type: "relation", config: { database: database.slug, synced: false, limit: 1 }, ord }, properties.length);
  await db.prepare("INSERT INTO db_properties (id, database_id, name, type, config, ord, width, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(parent.id, database.id, parent.name, parent.type, JSON.stringify(parent.config), parent.ord, parent.width, 0).run();
  const enabled = await enableRelationPair(db, database, parent, Object.assign({}, parent, { config: Object.assign({}, parent.config, { synced: true }) }), { pairName: "하위 항목" });
  if (enabled.error) {
    await db.prepare("DELETE FROM db_properties WHERE id = ?").bind(parent.id).run();
    return enabled;
  }
  const next = Object.assign({}, config, { subitems: { parent: parent.id, children: enabled.pair.id } });
  await db.prepare("UPDATE databases SET config = ?, updated = ? WHERE id = ?").bind(JSON.stringify(next), Date.now(), database.id).run();
  return { config: next };
}

async function saveProperties(db, databaseId, list) {
  const normalised = list.map((raw, index) => normaliseProperty(raw, index));
  const idMap = new Map();
  normalised.forEach((prop) => idMap.set(prop.id, scopedId(databaseId, prop.id)));
  const statements = [db.prepare("DELETE FROM db_properties WHERE database_id = ?").bind(databaseId)];
  // #107: 버튼 동작은 다른 저장 경로와 같은 검사를 거친다(대상 DB 를 편집할 수 없으면 동작을 버리고, 저장한 사람을 기록한다).
  for (const prop of normalised) {
    if (prop.type !== "button" || !prop.config.actions.length) continue;
    prop.config = Object.assign({}, prop.config, { actions: (await buttonActionsAllowed(db, prop.config.actions)) || [] });
    if (prop.config.actions.length) statements.push(buttonSaverStatement(db, propButtonKey(idMap.get(prop.id))));
  }
  normalised.forEach((prop) => {
    const config = Object.assign({}, prop.config);
    if (prop.type === "rollup" && idMap.has(config.relation_property)) config.relation_property = idMap.get(config.relation_property);
    // #86: 짝(pair)은 서버가 enableRelationPair 로만 만든다. 받은 목록의 pair 를 믿으면 남의 속성을 짝이라 우겨 지울 수 있다.
    if (prop.type === "relation") Object.assign(config, { synced: false, pair: "" });
    statements.push(db.prepare("INSERT INTO db_properties (id, database_id, name, type, config, ord, width, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(idMap.get(prop.id), databaseId, prop.name, prop.type, JSON.stringify(config), prop.ord, prop.width, prop.hidden ? 1 : 0));
  });
  await db.batch(statements);
}

async function syncPageTitleToRow(db, slug, title) {
  const clean = String(title || "").slice(0, 200);
  const row = await db.prepare("SELECT id, database_id, props FROM db_rows WHERE page = ?").bind(slug).first();
  if (row) {
    const titleProp = await db.prepare("SELECT id FROM db_properties WHERE database_id = ? AND type = 'title' ORDER BY ord LIMIT 1").bind(row.database_id).first();
    if (titleProp) {
      const props = parseJson(row.props, {});
      props[titleProp.id] = clean;
      const pairs = twoWayRelations(await readProperties(db, row.database_id));
      await db.batch([
        db.prepare("UPDATE db_rows SET props = ?, updated = ? WHERE id = ?").bind(JSON.stringify(props), Date.now(), row.id),
        ...pairs.map((prop) => relationCacheStatement(db, prop.id, "id = ?", [row.id])),
      ]);
    }
  }
  await db.prepare("UPDATE databases SET title = ?, updated = ? WHERE slug = ?").bind(clean || "제목 없음", Date.now(), slug).run();
}

async function readRowPage(db, databaseId, rowId) {
  const row = await db.prepare("SELECT id, page, props FROM db_rows WHERE id = ? AND database_id = ?").bind(rowId, databaseId).first();
  return row || null;
}

function databasePayload(found) {
  return {
    database: found.database, properties: found.properties,
    rows: found.rows.map((row) => ({ id: row.id, ord: row.ord, page: row.page, pageTitle: row.pageTitle, pageIcon: row.pageIcon || "", cover: row.cover || null, firstImage: row.firstImage || null, firstImageMeta: row.firstImageMeta || null, props: row.props, computed: row.computed || {}, errors: row.errors || {}, created: row.created, updated: row.updated })),
    views: found.views, templates: found.templates,
  };
}

function databaseBoot(slug, found) {
  return dbBootTag(slug, databasePayload(found));
}

async function renderDatabaseHtml(db, slug, view, cache) {
  const found = await readDatabase(db, slug, 0, cache);
  if (!found) return null;
  const titles = {};
  found.rows.forEach((row) => { titles[row.id] = row.pageTitle || ""; });
  return databaseHtml(found.properties, found.rows.map((row) => ({ id: row.id, page: row.page, pageIcon: row.pageIcon, cover: row.cover, firstImage: row.firstImage, firstImageMeta: row.firstImageMeta, values: rowValuesMap(found.properties, row), errors: row.errors })), found.views, { now: Date.now(), rowTitles: titles, slug, viewId: found.views.find((v) => v.id === view || v.type === view)?.id }) + databaseBoot(slug, found);
}

// 시드는 빌드가 만든 notes-seed.json 이다. 도리(마크다운)가 정본인 페이지는 시드가 이기고,
// 오너가 브라우저에서 고친 페이지(source='editor')는 시드가 건드리지 않는다.
async function syncSeed(db, env, request) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/notes-seed.json", request.url)));
  if (!asset.ok) return { imported: 0, updated: 0, skipped: 0 };
  const stamp = seedTag(asset) || String(Date.now());
  let seed;
  try {
    seed = JSON.parse(await asset.text());
  } catch {
    return { imported: 0, updated: 0, skipped: 0 };
  }
  const pages = Array.isArray(seed.pages) ? seed.pages : [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const page of pages) {
    if (!page || typeof page.slug !== "string") continue;
    if (await db.prepare("SELECT page FROM editor_trash WHERE page = ?").bind(page.slug).first()) { skipped += 1; continue; }
    const existing = await db.prepare("SELECT slug, source, hash FROM pages WHERE slug = ?").bind(page.slug).first();
    if (existing && existing.source === "editor") {
      skipped += 1;
      continue;
    }
    if (existing && existing.hash === page.hash) {
      skipped += 1;
      continue;
    }
    const blocks = normaliseBlocks(page.blocks);
    await db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, ?, ?, 'markdown', ?) ON CONFLICT(slug) DO UPDATE SET title = excluded.title, parent = excluded.parent, ord = excluded.ord, kind = excluded.kind, updated = excluded.updated, source = 'markdown', hash = excluded.hash")
      .bind(page.slug, String(page.title ?? page.slug), page.parent ?? null, Number(page.ord ?? 0), String(page.kind ?? "note"), Number(page.updated ?? Date.now()), String(page.hash ?? "")).run();
    await saveBlocks(db, page.slug, blocks);
    if (existing) updated += 1;
    else imported += 1;
  }
  await db.prepare("INSERT INTO meta (key, value) VALUES ('seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(stamp).run();
  return { imported, updated, skipped, stamp };
}

function remapKeys(object, map) {
  const out = {};
  Object.keys(object && typeof object === "object" ? object : {}).forEach((key) => { out[map.has(key) ? map.get(key) : key] = object[key]; });
  return out;
}

function remapFilter(filter, map) {
  if (Array.isArray(filter)) return filter.map((entry) => remapFilter(entry, map));
  if (!filter || typeof filter !== "object") return filter;
  const out = Object.assign({}, filter);
  if (Array.isArray(out.and)) out.and = out.and.map((entry) => remapFilter(entry, map));
  if (Array.isArray(out.or)) out.or = out.or.map((entry) => remapFilter(entry, map));
  if (typeof out.property === "string" && map.has(out.property)) out.property = map.get(out.property);
  return out;
}

function remapViewConfig(config, map) {
  const source = config && typeof config === "object" ? config : {};
  const pick = (key) => (typeof key === "string" && map.has(key) ? map.get(key) : key);
  return Object.assign({}, source, {
    filter: remapFilter(source.filter, map),
    sorts: Array.isArray(source.sorts) ? source.sorts.map((sort) => (sort && typeof sort === "object" ? Object.assign({}, sort, { property: pick(sort.property) }) : sort)) : [],
    group_by: source.group_by ? pick(source.group_by) : null,
    visible: Array.isArray(source.visible) ? source.visible.map(pick) : null,
    widths: remapKeys(source.widths, map),
    calculations: remapKeys(source.calculations, map),
  });
}

// 데이터베이스 시드(/db-seed.json). 슬러그가 이미 있는 데이터베이스는 건드리지 않고, 없는 것만
// 한 번의 배치(트랜잭션)로 넣는다. id 는 슬러그에서 결정적으로 만들어 다시 실행해도 같다.
async function syncDbSeed(db, env, request) {
  const result = { imported: 0, rows: 0, skipped: 0 };
  let asset;
  try {
    asset = await env.ASSETS.fetch(new Request(new URL("/db-seed.json", request.url)));
  } catch {
    return result;
  }
  if (!asset || !asset.ok) return result;
  let seed;
  try {
    seed = JSON.parse(await asset.text());
  } catch {
    return result;
  }
  const entries = (Array.isArray(seed && seed.databases) ? seed.databases : []).filter((entry) => entry && typeof entry.slug === "string" && entry.slug && Array.isArray(entry.properties));

  const idBySlug = new Map();
  const missing = [];
  for (const entry of entries) {
    const existing = await db.prepare("SELECT id FROM databases WHERE slug = ?").bind(entry.slug).first();
    if (existing) {
      idBySlug.set(entry.slug, existing.id);
      result.skipped += 1;
      continue;
    }
    const clash = await db.prepare("SELECT kind FROM pages WHERE slug = ?").bind(entry.slug).first();
    if (clash && clash.kind !== "db") {
      result.skipped += 1;
      continue;
    }
    idBySlug.set(entry.slug, "s" + shortHash(entry.slug));
    missing.push(entry);
  }
  if (!missing.length) return result;

  // 1차: 모든 속성·행 id 를 먼저 정한다(관계가 아직 안 만들어진 다른 DB 를 가리킬 수 있다).
  const propMaps = new Map();
  const rowMaps = new Map();
  for (const entry of missing) {
    const databaseId = idBySlug.get(entry.slug);
    const propMap = new Map();
    entry.properties.forEach((prop) => { if (prop && typeof prop.id === "string") propMap.set(prop.id, scopedId(databaseId, prop.id)); });
    propMaps.set(entry.slug, propMap);
    const rowMap = new Map();
    (Array.isArray(entry.rows) ? entry.rows : []).forEach((row) => { if (row && typeof row.id === "string") rowMap.set(row.id, scopedId(databaseId, row.id)); });
    rowMaps.set(entry.slug, rowMap);
  }
  const seedBySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const takenSlugs = new Set();
  const maxOrd = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM databases WHERE parent IS NULL").first();
  let dbOrd = Number(maxOrd && maxOrd.m ? maxOrd.m : 0);
  const now = Date.now();
  const statements = [];

  // 2차: 실제 삽입 문장을 만든다.
  for (const entry of missing) {
    const databaseId = idBySlug.get(entry.slug);
    const propMap = propMaps.get(entry.slug);
    const title = String(entry.title || entry.slug).slice(0, 200);
    dbOrd += 10;
    statements.push(db.prepare("INSERT OR IGNORE INTO databases (id, slug, title, icon, parent, ord, created, updated) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
      .bind(databaseId, entry.slug, title, String(entry.icon || "").slice(0, 8), dbOrd, now, now));
    statements.push(db.prepare("INSERT OR IGNORE INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, NULL, ?, 'db', ?, 'editor', NULL)")
      .bind(entry.slug, title, dbOrd, now));

    const properties = entry.properties.map((raw, index) => {
      const prop = normaliseProperty(raw, index);
      prop.id = propMap.get(raw && raw.id) || scopedId(databaseId, prop.id);
      const config = Object.assign({}, prop.config);
      if (prop.type === "rollup") {
        if (propMap.has(config.relation_property)) config.relation_property = propMap.get(config.relation_property);
        const rawConfig = raw.config && typeof raw.config === "object" ? raw.config : {};
        const relationRaw = entry.properties.find((item) => item && (item.id === rawConfig.relation_property || item.name === rawConfig.relation_property));
        const targetSlug = relationRaw && relationRaw.config ? relationRaw.config.database : "";
        const targetSeed = seedBySlug.get(targetSlug);
        if (targetSeed) {
          const targetRaw = targetSeed.properties.find((item) => item && (item.id === rawConfig.target_property || item.name === rawConfig.target_property));
          const targetMap = propMaps.get(targetSlug);
          if (targetRaw) config.target_property = targetMap && targetMap.has(targetRaw.id) ? targetMap.get(targetRaw.id) : targetRaw.name;
        }
      }
      prop.config = config;
      return prop;
    });
    properties.forEach((prop) => {
      statements.push(db.prepare("INSERT OR IGNORE INTO db_properties (id, database_id, name, type, config, ord, width, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(prop.id, databaseId, prop.name, prop.type, JSON.stringify(prop.config), prop.ord, prop.width, prop.hidden ? 1 : 0));
    });
    const titleProp = properties.find((prop) => prop.type === "title");

    (Array.isArray(entry.rows) ? entry.rows : []).forEach((raw, index) => {
      if (!raw || typeof raw.id !== "string") return;
      const rowId = rowMaps.get(entry.slug).get(raw.id);
      const incoming = raw.props && typeof raw.props === "object" ? raw.props : {};
      const props = {};
      properties.forEach((prop, propIndex) => {
        const seedId = entry.properties[propIndex] && entry.properties[propIndex].id;
        let value = Object.prototype.hasOwnProperty.call(incoming, seedId) ? incoming[seedId] : incoming[prop.name];
        if (value === undefined) {
          props[prop.id] = emptyValue(prop);
          return;
        }
        if (prop.type === "relation") {
          const targetRows = rowMaps.get(prop.config.database);
          const targetDbId = idBySlug.get(prop.config.database);
          const list = Array.isArray(value) ? value : value ? [value] : [];
          value = list.map((id) => String(id)).map((id) => (targetRows && targetRows.has(id) ? targetRows.get(id) : (targetDbId ? scopedId(targetDbId, id) : id)));
        }
        props[prop.id] = normaliseCellValue(prop, value);
      });
      const rowTitle = String(titleProp ? props[titleProp.id] : "") || "제목 없음";
      let pageSlug = slugify(rowTitle);
      if (takenSlugs.has(pageSlug)) pageSlug = pageSlug + "-" + shortHash(rowId);
      takenSlugs.add(pageSlug);
      statements.push(db.prepare("INSERT OR IGNORE INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, 'db_row', ?, 'editor', NULL)")
        .bind(pageSlug, rowTitle.slice(0, 200), entry.slug, (index + 1) * 10, now));
      const rowBlocks = normaliseBlocks(Array.isArray(raw.blocks) && raw.blocks.length ? raw.blocks : [{ id: "b1", type: "paragraph", text: "", checked: false, indent: 0, meta: null }]);
      blockStatements(db, pageSlug, rowBlocks).forEach((statement) => statements.push(statement));
      statements.push(db.prepare("INSERT OR IGNORE INTO db_rows (id, database_id, page, props, ord, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(rowId, databaseId, pageSlug, JSON.stringify(props), (index + 1) * 10, now, now));
      result.rows += 1;
    });

    (Array.isArray(entry.views) ? entry.views : []).forEach((raw, index) => {
      const view = normaliseView(Object.assign({}, raw, { id: scopedId(databaseId, raw && raw.id ? raw.id : "v" + index), config: remapViewConfig(raw && raw.config, propMap) }), index);
      statements.push(db.prepare("INSERT OR IGNORE INTO db_views (id, database_id, name, type, config, ord) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(view.id, databaseId, view.name, view.type, JSON.stringify(view.config), (index + 1) * 10));
    });
    if (!Array.isArray(entry.views) || !entry.views.length) {
      statements.push(db.prepare("INSERT OR IGNORE INTO db_views (id, database_id, name, type, config, ord) VALUES (?, ?, '표', 'table', ?, 0)")
        .bind(scopedId(databaseId, "table"), databaseId, JSON.stringify({ filter: null, sorts: [], group_by: null, visible: null, widths: {}, calculations: {} })));
    }

    (Array.isArray(entry.templates) ? entry.templates : []).forEach((raw, index) => {
      const template = normaliseTemplate(Object.assign({}, raw, { id: scopedId(databaseId, raw && raw.id ? raw.id : "t" + index), props: remapKeys(raw && raw.props, propMap) }), index);
      statements.push(db.prepare("INSERT OR IGNORE INTO db_templates (id, database_id, name, icon, props, blocks, ord) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(template.id, databaseId, template.name, template.icon, JSON.stringify(template.props), JSON.stringify(template.blocks), (index + 1) * 10));
      statements.push(templateSaverStatement(db, template.id));
    });
    result.imported += 1;
  }
  await db.batch(statements);
  return result;
}

async function seedStamp(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'seed'").first();
  return row ? String(row.value) : "";
}

// 도리가 마크다운을 다시 배포했는지 확인한다. 새 빌드일 때만 시드를 읽어 반영한다.
async function ensureMemberHome(db, env) {
  const claim = "home-" + crypto.randomUUID();
  // issue 147: a local app with ACARD_LANG=en|zh names a new home page in that language; an existing home keeps its title.
  const title = env && env.ACARD_LANG === "zh" ? "开始" : env && env.ACARD_LANG === "en" ? "Start" : "Home";
  // 멤버 홈은 항상 있어야 한다. 휴지통에 들어간 홈은 꺼내서 / 가 404 가 되지 않게 한다.
  await db.batch([
    db.prepare("DELETE FROM editor_trash WHERE page = 'index'"),
    db.prepare("INSERT OR IGNORE INTO pages (slug, title, parent, ord, kind, updated, source, hash) SELECT 'index', ?, NULL, 0, 'note', ?, 'editor', ? WHERE NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = 'index')").bind(title, Date.now(), claim),
    db.prepare("INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT 'index', 'b1', 0, 'paragraph', '', 0, 0, NULL WHERE EXISTS (SELECT 1 FROM pages WHERE slug = 'index' AND hash = ?)").bind(claim),
    db.prepare("UPDATE pages SET hash = NULL WHERE slug = 'index' AND hash = ?").bind(claim),
  ]);
}

// HEAD can answer W/"x" while GET answers "x" for the same file; compare the bare tag so an unchanged seed never looks new.
function seedTag(response) {
  return String(response.headers.get("etag") ?? response.headers.get("last-modified") ?? "").replace(/^W\//, "").replace(/"/g, "");
}

// Seed tags this isolate already saw applied; the seed only changes with a new deploy (a new isolate), so a match
// needs no DB round trip on every API call.
const seedSeen = new Set();
async function syncIfStale(db, env, request) {
  if (isMember(env) || isGuest(env)) return null;
  const head = await env.ASSETS.fetch(new Request(new URL("/notes-seed.json", request.url), { method: "HEAD" }));
  const etag = head.ok ? seedTag(head) : "";
  const seenKey = ((db && db.acardKey) || "d1") + ":" + etag;
  if (etag && seedSeen.has(seenKey)) return null;
  if (etag && (await seedStamp(db)).replace(/^W\//, "").replace(/"/g, "") === etag) { seedSeen.add(seenKey); return null; }
  // Only the request that moves the claim to this tag rewrites the seed; concurrent requests skip instead of
  // deleting and re-inserting the same blocks at the same time (blocks_pkey / page_fts_pkey collisions).
  const claim = await db.prepare("INSERT INTO meta (key, value) VALUES ('seed-claim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value <> excluded.value").bind(etag || String(Date.now())).run();
  if (!(claim && claim.meta && claim.meta.changes)) return null;
  try { return await syncSeed(db, env, request); }
  catch (error) { await db.prepare("DELETE FROM meta WHERE key = 'seed-claim'").run().catch(() => {}); throw error; }
}

async function pageExtras(db, page, blocks, view) {
  const extras = { crumbs: "", dbHtml: "", scripts: "" };
  const databases = new Map();
  const linked = [];
  for (const block of blocks) {
    if (block.type === "db_ref" && !block.syncedReadOnly && block.meta && block.meta.database) linked.push(block);
  }
  await Promise.all(linked.map(async (block) => {
    if (db.acardVisible && !db.acardVisible.has(String(block.meta.database))) { block.meta = Object.assign({}, block.meta, { html: "" }); return; }
    const html = await renderDatabaseHtml(db, String(block.meta.database), undefined, databases);
    block.meta = Object.assign({}, block.meta, { html: html || "" });
  }));
  // A linked database with a button property (notion-parity C4) mounts live so its buttons can be pressed.
  for (const found of await Promise.all([...databases.values()])) {
    if (found && found.properties.some((prop) => prop.type === "button")) {
      extras.scripts = '<script src="/db-model.js"></script><script src="/db-views.js"></script><script src="/db.js"></script>';
      break;
    }
  }
  // 홈은 시안처럼 인트로 아래에 프로젝트 현황 표("주요 작업 목록")를 그대로 띄운다.
  if (page.slug === "index" && (!db.acardVisible || db.acardVisible.has("board"))) {
    const board = await renderDatabaseHtml(db, "board", undefined, databases);
    if (board) {
      extras.homeTasks = '<div class="home-tasks">' + board + "</div>";
      extras.scripts = '<script src="/db-model.js"></script><script src="/db-views.js"></script><script src="/db.js"></script>';
    }
  }
  if (page.kind === "db") {
    extras.dbHtml = (await renderDatabaseHtml(db, page.slug, view, databases)) || '<p class="dbempty">아직 표가 없어요.</p>';
    extras.scripts = '<script src="/db-model.js"></script><script src="/db-views.js"></script><script src="/db.js"></script>';
  }
  if (page.kind === "db_row") {
    const row = await db.prepare("SELECT id, database_id FROM db_rows WHERE page = ?").bind(page.slug).first();
    if (row) {
      const database = await db.prepare("SELECT id, slug, title, icon, parent, ord, created, updated, config FROM databases WHERE id = ?").bind(row.database_id).first();
      if (database && (!db.acardVisible || db.acardVisible.has(String(database.slug)))) {
        if (!databases.has(database.slug)) databases.set(database.slug, readDatabaseById(db, database, 0));
        const found = await databases.get(database.slug);
        const mine = found.rows.filter((entry) => entry.id === row.id);
        const titles = {};
        found.rows.forEach((entry) => { titles[entry.id] = entry.pageTitle || ""; });
        const table = databaseTableHtml(found.properties, mine.map((entry) => ({ id: entry.id, page: entry.page, values: rowValuesMap(found.properties, entry) })), { config: {} }, { now: Date.now(), rowTitles: titles, slug: database.slug });
        extras.crumbs = '<nav class="dbbreadcrumb"><a href="/' + encodeURIComponent(database.slug) + '/">' + escapeHtml(database.title) + "</a></nav>";
        extras.dbHtml = '<div class="dbprops" data-db="' + escapeHtml(database.slug) + '" data-row="' + escapeHtml(row.id) + '">' + table + '</div>' + databaseBoot(database.slug, found) + '<div class="blocks">' + renderBlocks(blocks, { page }) + "</div>";
        extras.scripts = '<script src="/db-model.js"></script><script src="/db-views.js"></script><script src="/db.js"></script>';
      }
    }
  }
  return extras;
}

function pageShell(page, blocks, pages, extras, settings = {}) {
  const extra = extras || {};
  const ctx = { page: page, pages: pages ?? [] };
  const tagRow = page.ws === "guest" || page.slug === "index" ? "" : '<div class="fd-headtags" id="fd-headtags"></div>';
  const report = isReportPage(settings);
  const heading = "<h1>" + escapeHtml(page.title) + "</h1>" + tagRow + bylineHtml(page);
  let top = heading;
  let body;
  if (extra.dbHtml) {
    body = extra.dbHtml;
    if (page.kind === "db" && page.slug === "board") {
      const intro = introSplit(blocks)[0];
      const introHtml = intro.length ? '<div class="blocks">' + renderBlocks(intro, ctx) + "</div>" : "";
      const side = sideImageHtml(Object.assign({}, page, settings.side_image ? { side_image: settings.side_image } : {}));
      top = side ? '<div class="page-top"><div class="page-top-main">' + heading + introHtml + "</div>" + side + "</div>" : heading + introHtml;
    }
  }
  else if (extra.folderHtml) {
    body = extra.folderHtml;
  }
  else {
    const split = introSplit(blocks);
    const side = sideImageHtml(Object.assign({}, page, { side_image: settings.side_image || page.side_image }));
    if (side) top = '<div class="page-top"><div class="page-top-main">' + heading + (split[0].length ? '<div class="blocks">' + renderBlocks(split[0], ctx) + "</div>" : "") + "</div>" + side + "</div>";
    body = '<div class="blocks">' + renderBlocks(side ? split[1] : blocks, ctx) + "</div>";
  }
  const mainClass = [settings.width === "full" ? "full-width" : settings.width === "normal" ? "width-normal" : "", page.kind === "db" ? "wide" : "", report ? "rp" : "", settings.small === true ? "small-text" : ""].filter(Boolean).join(" ");
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="application-name" content="__SITE_NAME__">',
    '<meta property="og:site_name" content="__SITE_NAME__">',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta property="og:image" content="/og.png">',
    "<title>" + escapeHtml(page.title) + " · __SITE_NAME__</title>",
    '<link rel="preload" href="/fonts/pretendard-core.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/style.css">',
    '<link rel="stylesheet" href="/editor.css">',
    '<link rel="stylesheet" href="/db.css">',
    '<link rel="stylesheet" href="/acard-shell.css"><link rel="stylesheet" href="/acard-page.css"><link rel="stylesheet" href="/acard-body.css"><link rel="stylesheet" href="/acard-table.css"><link rel="stylesheet" href="/acard-mobile.css">',
    report ? "<style>" + REPORT_CSS + "</style>" : "",
    //__READER_FEATURE_CSS__
    "</head>",
    '<body class="reader"' + (page.readOnly ? ' data-readonly="1"' : "") + ">",
    '<a class="skip" href="#main">본문으로</a>',
    mobileBarHtml("__SITE_NAME__"),
    '<div class="shell">',
    '<nav class="sidebar" id="sidebar" aria-label="문서 목록">' + sideNavHtml(pages ?? [], page.slug, "__SITE_NAME__").replace('<div class="side-ws">', page.ws === "guest" ? "$&" : PJ_SIDE_PH + "$&") + sideFootHtml() + "</nav>",
    '<main id="main" class="' + mainClass + '" data-font="' + escapeHtml(settings.font || "default") + '">',
    '<div id="results" class="results" hidden></div>',
    '<article id="article">',
    extra.crumbs ? extra.crumbs : "",
    pageHeadHtml(page, settings, pageActionsHtml(page.slug, moreMenu(page.slug, page.ws === "guest" ? null : extra.viewMode))),
    top,
    page.slug === "index" && page.ws !== "member" && page.ws !== "guest" ? (extra.homeTasks || "") + overviewHtml(blocks) : body,
    "</article>",
    page.ws === "guest" ? '<footer class="foot">공유받은 페이지 · ' + escapeHtml(page.guest || "") + ' <form method="POST" action="/s/' + escapeHtml(page.guestWs || "o") + '/logout" style="display:inline"><button type="submit">나가기</button></form></footer>' : page.ws === "member" ? '<footer class="foot">비공개 노트 · 나만 볼 수 있어요</footer>' : '<footer class="foot">비공개 노트 · 오너 전용</footer>',
    "</main>",
    "</div>",
    thumbBarHtml(page.slug),
    paletteHtml(),
    shortcutsHtml(),
    sidePanelHtml(),
    '<script src="/app.js"></script>',
    extra.scripts ? extra.scripts : "",
    page.ws === "guest" ? LIVE_TAG : FOLDERS_TAG,
    page.slug === "index" && page.ws !== "guest" ? HOME_TAG : "",
    //__READER_FEATURE_JS__
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------- 미디어 ----------
// POST /api/upload, GET /media/<id>, DELETE /api/media/<id>, GET /api/link-preview — 모두 게이트 쿠키 검사 뒤에서만 돈다.

const MEDIA_BINDING = "MEDIA";
// One file is at most 50 MB for every account. /api/media-usage tells the
// editor this number (uploadLimit), so the client never keeps its own copy. Small files still go up as one form and are
// read whole (image compression needs the bytes); anything above MEDIA_BUFFER_BYTES must use the streamed upload
// (POST /api/upload?stream=1, raw body), which goes to R2 without ever being held whole in the Worker.
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const MEDIA_BUFFER_BYTES = 4 * 1024 * 1024;
// A streamed upload's ledger lease: settled by the request itself, or swept this long after it started (a request
// cannot outlive it; the 15-minute cron on acard-workspace releases what a dead request left).
const MEDIA_LEASE_MS = 60 * 60 * 1000;
const MEDIA_ID = /^[0-9a-f]{16}$/;
// Page icon / cover uploads (beta request 2026-10-20): images only, 10 MB each. A member workspace stops at its account's
// media quota: env.ACARD_MEDIA_PLAN() (gate/cloud.ts MEDIA_TIERS: 500 MB free, 10 GB beta / free pass / subscription),
// WORKSPACE_MEDIA_QUOTA when no plan is wired (tests, self-host). All of Acard stops at GLOBAL_MEDIA_CAP (same number as
// gate/cloud.ts); R2 past 10 GB is $0.015 per GB-month. The owner gets one mail at each GLOBAL_MEDIA_ALERTS step.
const LOOK_MAX_BYTES = 10 * 1024 * 1024;
const LOOK_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const LOOK_WIDTH = { icon: 512, cover: 2400 };
const WORKSPACE_MEDIA_QUOTA = 500 * 1000 * 1000;
const GLOBAL_MEDIA_CAP = 100 * 1000 * 1000 * 1000;
const GLOBAL_MEDIA_ALERTS = [10, 30, 50, 80].map((gb) => gb * 1000 * 1000 * 1000);
const R2_FREE_BYTES = 10 * 1000 * 1000 * 1000;
const R2_USD_PER_GB_MONTH = 0.015;
const LINK_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_MAX_BYTES = 512 * 1024;

function mediaId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function baseMime(type) {
  return String(type ?? "").split(";")[0].trim().toLowerCase();
}

export function isAllowedMime(type) {
  const mime = baseMime(type);
  return /^(image|video|audio)\/[a-z0-9.+-]+$/.test(mime) || mime === "application/pdf" || mime === "text/plain";
}

export function sanitizeName(name) {
  const clean = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f"\\/]/g, "")
    .trim()
    .slice(0, 200);
  return clean || "file";
}

// SVG 는 같은 오리진에서 inline 으로 열리면 스크립트가 돈다. 그래서 image/* 여도 내려받게 한다.
export function pickDisposition(mime, name) {
  const type = baseMime(mime);
  const inline = /^(image|video|audio)\//.test(type) && type !== "image/svg+xml";
  const encoded = encodeURIComponent(sanitizeName(name)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encoded;
}

// 링크 미리보기는 서버가 대신 남의 주소를 여는 것이라 내부망으로 새지 않게 막는다.
export function isBlockedHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host.startsWith("[") || host.includes(":")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "local" || host.endsWith(".local")) return true;
  return false;
}

export function previewTarget(raw) {
  let target;
  try {
    target = new URL(String(raw ?? ""));
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (isBlockedHost(target.hostname)) return null;
  return target;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html, key) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const named = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const which = named ? (named[1] ?? named[2] ?? named[3] ?? "").toLowerCase() : "";
    if (which !== key) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    if (content) return decodeEntities(content[1] ?? content[2] ?? content[3] ?? "");
  }
  return "";
}

export function parsePreview(html, pageUrl) {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let image = metaContent(html, "og:image");
  if (image) {
    try {
      image = new URL(image, pageUrl).href;
    } catch {
      image = "";
    }
  }
  return {
    title: (metaContent(html, "og:title") || (titleTag ? decodeEntities(titleTag[1]) : "")).slice(0, 300),
    description: (metaContent(html, "og:description") || metaContent(html, "description")).slice(0, 1000),
    image: image.slice(0, 2000),
    site: metaContent(html, "og:site_name").slice(0, 200),
  };
}

async function readLimited(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const merged = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, merged.length - offset);
    merged.set(part, offset);
    offset += part.length;
    if (offset >= merged.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function linkPreview(db, raw) {
  const target = previewTarget(raw);
  if (!target) return json({ ok: false, url: String(raw ?? ""), error: "http 나 https 주소만 미리볼 수 있어요." }, 400);
  const key = target.href;
  const cached = await db.prepare("SELECT title, description, image, site, created FROM link_cache WHERE url = ?").bind(key).first().catch(() => null);
  if (cached && Date.now() - Number(cached.created) < LINK_CACHE_MS) {
    return json({ ok: true, url: key, title: cached.title ?? "", description: cached.description ?? "", image: cached.image ?? "", site: cached.site ?? "" });
  }
  try {
    const response = await fetch(key, {
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) throw new Error("status " + response.status);
    const type = response.headers.get("content-type") ?? "";
    const html = /html|xml/i.test(type) || !type ? await readLimited(response, LINK_MAX_BYTES) : "";
    const preview = parsePreview(html, response.url || key);
    if (!preview.site) preview.site = target.hostname;
    await db.prepare("INSERT OR REPLACE INTO link_cache (url, title, description, image, site, created) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(key, preview.title, preview.description, preview.image, preview.site, Date.now()).run().catch(() => {});
    return json({ ok: true, url: key, ...preview });
  } catch {
    return json({ ok: false, url: key, error: "미리보기를 가져올 수 없었어요." });
  }
}

// Agent uploads: images only (png/jpeg/webp/gif; never SVG, which can carry script), same 4 MB cap and KV layout as /api/upload.
const AGENT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
function isSvg(bytes) {
  const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 1024))).replace(/^\uFEFF/, "").trimStart();
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head);
}
function sniffImage(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && (b[11] === 0x66 || b[11] === 0x73)) return "image/avif";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// Header-only dimensions: do not decode untrusted pixels in the request worker.
export function imageDimensions(bytes) {
  const b = new Uint8Array(bytes), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = (at, n) => String.fromCharCode(...b.subarray(at, at + n));
  const mime = sniffImage(bytes);
  let width = null, height = null, animated = false;
  if (mime === "image/png" && b.length >= 24 && text(12, 4) === "IHDR") {
    width = v.getUint32(16); height = v.getUint32(20);
    for (let at = 8; at + 12 <= b.length;) {
      const size = v.getUint32(at);
      if (text(at + 4, 4) === "acTL") animated = true;
      if (size > b.length - at - 12) break;
      at += size + 12;
    }
  } else if (mime === "image/gif" && b.length >= 10) {
    width = v.getUint16(6, true); height = v.getUint16(8, true); animated = true;
  } else if (mime === "image/jpeg") {
    for (let at = 2; at + 4 <= b.length;) {
      if (b[at++] !== 255) break;
      while (b[at] === 255) at++;
      const marker = b[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > b.length) break;
      const size = v.getUint16(at);
      if (size < 2 || at + size > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) {
        height = v.getUint16(at + 3); width = v.getUint16(at + 5); break;
      }
      at += size;
    }
  } else if (mime === "image/webp") {
    const u24 = at => b[at] + b[at + 1] * 256 + b[at + 2] * 65536;
    for (let at = 12; at + 8 <= b.length;) {
      const kind = text(at, 4), size = v.getUint32(at + 4, true), p = at + 8;
      if (size > b.length - p) break;
      if (kind === "VP8X" && size >= 10) { width = u24(p + 4) + 1; height = u24(p + 7) + 1; animated = Boolean(b[p] & 2); }
      if (kind === "ANIM" || kind === "ANMF") animated = true;
      if (!width && kind === "VP8 " && size >= 10 && b[p + 3] === 0x9d && b[p + 4] === 1 && b[p + 5] === 0x2a) { width = v.getUint16(p + 6, true) & 0x3fff; height = v.getUint16(p + 8, true) & 0x3fff; }
      if (!width && kind === "VP8L" && size >= 5 && b[p] === 0x2f) { width = 1 + (b[p + 1] | (b[p + 2] & 63) << 8); height = 1 + ((b[p + 2] >> 6) | b[p + 3] << 2 | (b[p + 4] & 15) << 10); }
      at = p + size + (size & 1);
    }
  }
  return { width: width || null, height: height || null, animated };
}

// The global ledger is one Durable Object (workers/acard-workspace WorkspaceStore named global:media). Without the
// binding (tests, local) there is no global cap; the per-workspace quota still applies.
function mediaLedger(env) {
  return env && env.WORKSPACE ? env.WORKSPACE.get(env.WORKSPACE.idFromName("global:media")) : null;
}

function memberWorkspace(env) {
  return Boolean(env && env.ACARD_WORKSPACE && env.ACARD_WORKSPACE !== "owner");
}

async function workspaceMediaBytes(db) {
  const row = await db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM media").first();
  return Number(row && row.n) || 0;
}

// The quota of the account that owns this member workspace (gate/agent-entry.ts wires ACARD_MEDIA_PLAN). null when the
// lookup failed: then only the global cap applies, so an outage never refuses a 10 GB account at 500 MB.
async function mediaPlan(env) {
  if (typeof env.ACARD_MEDIA_PLAN !== "function") return { tier: "free", quota: WORKSPACE_MEDIA_QUOTA, passUntil: null };
  try { return await env.ACARD_MEDIA_PLAN(); } catch (error) { console.error("acard media plan lookup failed", String(error)); return null; }
}

function storageSize(bytes) {
  return bytes >= 1e9 ? Number((bytes / 1e9).toFixed(1)) + "GB" : Math.round(bytes / 1e6) + "MB";
}

// Owner mails: one at each GLOBAL_MEDIA_ALERTS step (ledger alert level 1-4) and one at the GLOBAL_MEDIA_CAP stop (level 5).
// `test` (the admin console's storage-alert test, acardHost.storageAlertTest) sends the mail for today's usage with
// "[테스트]" in front of the subject. Returns Resend's answer ({ id } when it was accepted).
export function storageAlertMail(env, used, stopped, test = false) {
  const gb = (used / 1e9).toFixed(2);
  const monthly = Math.max(0, used - R2_FREE_BYTES) / 1e9 * R2_USD_PER_GB_MONTH;
  const cost = "지금 R2 요금은 월 약 $" + monthly.toFixed(2) + " 예요(10GB 를 넘는 만큼 GB당 월 $" + R2_USD_PER_GB_MONTH + ").";
  const step = GLOBAL_MEDIA_ALERTS.filter((n) => used >= n).pop();
  const next = GLOBAL_MEDIA_ALERTS.find((n) => n > used);
  const text = stopped
    ? "Acard 파일 저장 공간이 " + gb + "GB 로 전체 상한(" + storageSize(GLOBAL_MEDIA_CAP) + ")에 닿아 새 업로드를 막았어요. " + cost + " 늘리려면 GLOBAL_MEDIA_CAP(gate/_worker.js, gate/cloud.ts)을 올려 주세요."
    : "Acard 파일 저장 공간이 " + gb + "GB 예요. " + cost + " " + (next ? "다음 경고는 " + storageSize(next) + ", " : "") + "전체 상한 " + storageSize(GLOBAL_MEDIA_CAP) + "에서 새 업로드를 막아요. 많이 쓰는 계정은 관리자 콘솔 > 저장 공간에서 볼 수 있어요.";
  const subject = stopped ? "[Acard] 파일 저장 공간 업로드 중지" : step ? "[Acard] 파일 저장 공간 " + storageSize(step) + " 넘음" : "[Acard] 파일 저장 공간 " + gb + "GB";
  return {
    from: env.MAIL_FROM || "Acard <beta@send.notes.example.com>",
    to: [env.OWNER_ALERT_EMAIL],
    subject: test ? "[테스트] " + subject : subject,
    text: test ? "이 메일은 관리자 콘솔에서 보낸 테스트예요. 실제 사용량은 " + gb + "GB 이고, 아래는 실제 경고에 가는 문구예요.\n\n" + text : text,
  };
}

async function mailOwnerAboutStorage(env, used, stopped, test = false) {
  if (!env.RESEND_API_KEY || !env.OWNER_ALERT_EMAIL) return { ok: false, error: "RESEND_API_KEY 또는 OWNER_ALERT_EMAIL 이 없어요." };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(storageAlertMail(env, used, stopped, test)),
    });
    const body = await response.json().catch(() => null);
    // issue 165: the refusal's name only; Resend's message can quote the recipient address.
    if (!response.ok) console.error("acard storage alert mail refused", response.status, String(body && body.name || ""));
    return { ok: response.ok, status: response.status, id: body && body.id ? String(body.id) : null };
  } catch (error) {
    console.error("acard storage alert mail failed", String(error));
    return { ok: false, error: String(error) };
  }
}

// Every write of a media original goes through here: the account's quota first, then the global ledger, which takes
// the bytes only if the total stays under GLOBAL_MEDIA_CAP. A refused upload stores nothing.
async function reserveMedia(env, db, bytes, lease) {
  if (memberWorkspace(env)) {
    const plan = await mediaPlan(env);
    if (plan && (await workspaceMediaBytes(db)) + bytes > plan.quota) {
      const whose = plan.tier === "free" ? "무료 계정의 " : "";
      throw new AgentError(whose + "파일 저장 공간(" + storageSize(plan.quota) + ")을 다 썼어요. 안 쓰는 파일을 지운 뒤 다시 올려 주세요.", 507);
    }
  }
  const ledger = mediaLedger(env);
  if (!ledger || typeof ledger.mediaUsage !== "function") return;
  const result = lease ? await ledger.mediaReserve(lease, bytes, GLOBAL_MEDIA_CAP, MEDIA_LEASE_MS) : await ledger.mediaUsage(bytes, GLOBAL_MEDIA_CAP);
  const stopLevel = GLOBAL_MEDIA_ALERTS.length + 1;
  if (!result.ok) {
    if (await ledger.mediaMarkAlerted(stopLevel)) await mailOwnerAboutStorage(env, result.used, true);
    throw new AgentError("Acard 전체 파일 저장 공간이 꽉 차서 지금은 올릴 수 없어요. 운영자에게 알렸어요.", 507);
  }
  const level = GLOBAL_MEDIA_ALERTS.filter((n) => result.used >= n).length;
  if (level > result.alerted && await ledger.mediaMarkAlerted(level)) await mailOwnerAboutStorage(env, result.used, false);
}

// New png/jpeg originals (POST /api/upload and every agent image) are stored as WebP through the acard-image Worker
// (Images binding): long side at most COMPRESS_MAX, quality COMPRESS_QUALITY (small UI text stays readable), and only when
// the WebP is smaller. Animated images, gif/webp/svg/avif, video and files stored before this change are never touched.
// Each compression is one unique Images transformation; COMPRESS_MONTHLY (counted in the global:media Durable Object)
// keeps uploads well inside the 5,000 free transformations a month. MEDIA_COMPRESS = "on" in wrangler.toml turns it on.
const COMPRESS_MAX = 2560;
const COMPRESS_QUALITY = 85;
const COMPRESS_MONTHLY = 3000;
const COMPRESS_TYPES = new Set(["image/png", "image/jpeg"]);

export function webpName(name) {
  return String(name).replace(/\.(?:png|jpe?g)$/i, "") + (/\.(?:png|jpe?g)$/i.test(String(name)) ? ".webp" : "");
}

async function compressUpload(env, bytes, mime) {
  if (env.MEDIA_COMPRESS !== "on" || !env.IMAGE_RESIZER || !COMPRESS_TYPES.has(mime) || sniffImage(bytes) !== mime) return null;
  const before = imageDimensions(bytes);
  if (!before.width || !before.height || before.animated) return null;
  const ledger = mediaLedger(env);
  if (ledger && typeof ledger.compressSlot === "function" && !(await ledger.compressSlot(COMPRESS_MONTHLY).catch(() => false))) return null;
  try {
    const response = await env.IMAGE_RESIZER.fetch("https://acard-image/compress?max=" + COMPRESS_MAX + "&q=" + COMPRESS_QUALITY, { method: "POST", body: bytes });
    if (!response.ok) throw new Error("compress " + response.status);
    const out = await response.arrayBuffer();
    const size = imageDimensions(out);
    if (sniffImage(out) !== "image/webp" || !size.width || !size.height || size.width > COMPRESS_MAX || size.height > COMPRESS_MAX) throw new Error("invalid compress output");
    if (out.byteLength >= bytes.byteLength) return null;
    return { bytes: out, mime: "image/webp", dimensions: size };
  } catch (error) {
    console.error("acard upload compression skipped", String(error));
    return null;
  }
}

async function releaseMedia(env, bytes) {
  const ledger = mediaLedger(env);
  if (!ledger || !(bytes > 0) || typeof ledger.mediaUsage !== "function") return;
  await ledger.mediaUsage(-bytes, Infinity).catch((error) => console.error("acard media ledger release failed", String(error)));
}

// What a file's first bytes say it is. Uploads keep the type the browser declared only when the bytes agree with it, so a
// renamed program cannot be stored as a video. Types without a fixed signature (text/plain) pass on the declaration.
export function sniffMedia(head) {
  const b = new Uint8Array(head.slice(0, 16));
  const text = (at, n) => String.fromCharCode(...b.subarray(at, at + n));
  const image = sniffImage(head);
  if (image) return image;
  if (text(4, 4) === "ftyp") {
    const brand = text(8, 4);
    if (brand === "qt  ") return "video/quicktime";
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^M4A |^M4B /.test(brand)) return "audio/mp4";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (text(0, 4) === "%PDF") return "application/pdf";
  if (text(0, 4) === "OggS") return "audio/ogg";
  if (text(0, 4) === "fLaC") return "audio/flac";
  if (text(0, 4) === "RIFF" && text(8, 4) === "WAVE") return "audio/wav";
  if (text(0, 4) === "RIFF" && text(8, 4) === "AVI ") return "video/x-msvideo";
  if (text(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

// Declared type vs bytes for a streamed upload: the family (video/audio/image/pdf) must match, and the stored type is the
// sniffed one (a .mov sent as video/mp4 is stored as quicktime). mp4 audio/video share the ftyp box, so either counts.
export function streamMime(declared, head) {
  const type = baseMime(declared);
  if (!isAllowedMime(type) || type === "image/svg+xml" || type === "text/plain") return null;
  const found = sniffMedia(head);
  if (!found) return null;
  const family = (mime) => (mime === "application/pdf" ? "pdf" : mime.split("/")[0]);
  if (found === "audio/mp4" || found === "video/mp4") return /^(video|audio)\//.test(type) ? (type.startsWith("audio/") ? "audio/mp4" : found) : null;
  return family(found) === family(type) ? found : null;
}

// Passes every byte through and, once the first `size` bytes went by (or the stream ended sooner), calls check(head). A
// check that throws errors the stream there, so the R2 put that reads it fails and nothing is stored; `decided`
// resolves with what check returned. The head is all that is ever held.
function headTap(size, check) {
  let seen = new Uint8Array(0), done = false, settle, fail;
  const decided = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const decide = () => {
    done = true;
    try { settle(check(seen.buffer)); }
    catch (error) { fail(error); throw error; }
  };
  const tap = new TransformStream({
    transform(chunk, controller) {
      if (!done) {
        const next = new Uint8Array(Math.min(size, seen.length + chunk.byteLength));
        next.set(seen); next.set(chunk.subarray(0, next.length - seen.length), seen.length);
        seen = next;
        if (seen.length >= size) decide();
      }
      controller.enqueue(chunk);
    },
    flush() { if (!done) decide(); },
  });
  return { tap, decided };
}

// POST /api/upload?stream=1 (editor files over MEDIA_BUFFER_BYTES, up to MEDIA_MAX_BYTES): the raw file is the body,
// content-length is required (no chunked bodies), the name and page ride in the query and content-type is the declared
// type. The bytes are reserved under a lease before anything is stored, streamed into R2 through a FixedLengthStream
// (an early end or extra bytes fail the put, so a short object is never stored), checked by their first bytes as they go
// by, and the lease is then committed (stored) or released (anything else) exactly once.
async function uploadStream(request, env, db, url) {
  const store = env[MEDIA_BINDING];
  if (!store || typeof store.putStream !== "function") return json({ error: "큰 파일 저장소가 연결되지 않았어요." }, 503);
  const tooBig = "파일이 너무 커요. 한 파일에 50MB 까지 올릴 수 있어요.";
  const size = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isSafeInteger(size) || size <= 0) return json({ error: "파일 크기를 알 수 없어요. 다시 올려 주세요." }, 411);
  if (size > MEDIA_MAX_BYTES) return json({ error: tooBig }, 413);
  const declared = baseMime(request.headers.get("content-type"));
  if (!isAllowedMime(declared) || declared === "image/svg+xml" || declared === "text/plain") return json({ error: "영상, 소리, 이미지, PDF 파일만 올릴 수 있어요." }, 415);
  const name = sanitizeName(url.searchParams.get("name"));
  const page = url.searchParams.get("page") ? String(url.searchParams.get("page")).slice(0, 120) : null;
  const ledger = mediaLedger(env);
  const id = mediaId();
  const lease = (env.ACARD_WORKSPACE || "owner") + ":" + id;
  try { await reserveMedia(env, db, size, lease); }
  catch (error) { if (error instanceof AgentError) return json({ error: error.message }, error.status); throw error; }
  let stored = false, committed = false;
  try {
    const typeError = new AgentError(declared.startsWith("video/") ? "영상 파일이 아니에요. 원본 영상을 그대로 올려 주세요." : "파일 내용이 형식과 맞지 않아요. 원본 파일을 그대로 올려 주세요.", 415);
    const { tap, decided } = headTap(16, (bytes) => { const mime = streamMime(declared, bytes); if (!mime) throw typeError; return mime; });
    const fixed = new FixedLengthStream(size);
    const piped = request.body.pipeThrough(tap).pipeTo(fixed.writable);
    const putting = decided.then((mime) => store.putStream("media/" + id, fixed.readable, { name, size, mime }));
    const [mime, put] = await Promise.all([decided, putting, piped]);
    if (!put) throw new AgentError("파일을 저장하지 못했어요. 다시 올려 주세요.", 502);
    stored = true;
    // Commit first: from here the bytes are counted as stored, so a failed row insert below gives them back once.
    if (ledger) await ledger.mediaCommit(lease, size);
    committed = true;
    const etag = put.httpEtag ? '"r2-' + String(put.httpEtag).replace(/"/g, "") + '"' : null;
    await db.prepare("INSERT INTO media (id, page, name, mime, bytes, created, etag) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, page, name, mime, size, Date.now(), etag).run();
    return json({ ok: true, id, url: "/media/" + id, mime, name, size });
  } catch (error) {
    if (stored) await store.delete("media/" + id).catch((cause) => console.error("acard stream upload cleanup failed", id, String(cause)));
    if (committed) await releaseMedia(env, size);
    if (error instanceof AgentError) return json({ error: error.message }, error.status);
    console.error("acard stream upload failed", id, String(error && error.message || error));
    return json({ error: "올리는 도중 연결이 끊겼어요. 다시 올려 주세요." }, 400);
  } finally {
    if (!committed && ledger) await ledger.mediaRelease(lease).catch((cause) => console.error("acard media lease release failed", lease, String(cause)));
  }
}

async function storeAgentImage(env, db, page, name, declared, bytes, source) {
  const store = env[MEDIA_BINDING];
  if (!store) throw new AgentError("미디어 저장소가 연결되지 않았어요.", 503);
  if (!bytes || !bytes.byteLength) throw new AgentError("올릴 파일이 없어요.");
  if (bytes.byteLength > MEDIA_BUFFER_BYTES) throw new AgentError("파일이 너무 커요. 최대 4MB 까지 올릴 수 있어요.", 413);
  let mime = sniffImage(bytes) || (isSvg(bytes) ? "image/svg+xml" : null);
  if (!mime || !AGENT_IMAGE_MIMES.has(mime) || (declared && baseMime(declared) !== mime)) throw new AgentError("png, jpeg, webp, gif, svg 이미지만 올릴 수 있어요.", 415);
  if (mime === "image/svg+xml") bytes = new TextEncoder().encode(ACARD_FEATURES.services.sanitizeSvg(new TextDecoder().decode(bytes))).buffer;
  const id = mediaId();
  let clean = sanitizeName(name || "image");
  let dimensions = imageDimensions(bytes);
  const originalSize = bytes.byteLength;
  const compressed = await compressUpload(env, bytes, mime);
  if (compressed) { bytes = compressed.bytes; mime = compressed.mime; dimensions = compressed.dimensions; clean = webpName(clean); }
  await reserveMedia(env, db, bytes.byteLength);
  const etag = await mediaEtag(bytes);
  await store.put("media/" + id, bytes, { metadata: { mime, name: clean, size: bytes.byteLength, etag, ...dimensions, ...(compressed ? { originalSize } : {}), ...(source ? { source: String(source).slice(0, 500) } : {}) } });
  await db.prepare("INSERT INTO media (id, page, name, mime, bytes, created, etag) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, page || null, clean, mime, bytes.byteLength, Date.now(), etag).run();
  return { ok: true, id, url: "/media/" + id, mime, name: clean, size: bytes.byteLength, ...(compressed ? { originalSize } : {}), width: dimensions.width, height: dimensions.height, markdown: "![" + clean.replace(/[\]\n]/g, " ") + "](/media/" + id + ")" };
}

// Agent video files (#33): the user's machine extracts keyframes; the file itself is kept only when the agent sends it
// (mp4/mov ftyp or webm EBML bytes, same 4 MB cap and KV layout), and pages link or play it from /media/<id>.
async function storeAgentVideo(env, db, page, name, bytes) {
  const store = env[MEDIA_BINDING];
  if (!store) throw new AgentError("미디어 저장소가 연결되지 않았어요.", 503);
  if (!bytes || !bytes.byteLength) throw new AgentError("올릴 파일이 없어요.");
  if (bytes.byteLength > MEDIA_BUFFER_BYTES) throw new AgentError("영상이 너무 커요. 최대 4MB 까지 올릴 수 있어요.", 413);
  const b = new Uint8Array(bytes.slice(0, 12));
  const ftyp = b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
  const mime = ftyp ? (b[8] === 0x71 && b[9] === 0x74 ? "video/quicktime" : "video/mp4") : b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 ? "video/webm" : null;
  if (!mime) throw new AgentError("mp4, mov, webm 영상만 올릴 수 있어요.", 415);
  const id = mediaId();
  const clean = sanitizeName(name || "video");
  await reserveMedia(env, db, bytes.byteLength);
  const etag = await mediaEtag(bytes);
  await store.put("media/" + id, bytes, { metadata: { mime, name: clean, size: bytes.byteLength, etag } });
  await db.prepare("INSERT INTO media (id, page, name, mime, bytes, created, etag) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, page || null, clean, mime, bytes.byteLength, Date.now(), etag).run();
  return { ok: true, id, url: "/media/" + id, mime, name: clean, size: bytes.byteLength };
}

// POST /api/upload?kind=icon|cover from the editor's page look panel: png/jpeg/webp/gif/avif by their bytes (never SVG),
// 10 MB. A still image wider than the slot is resized once here through the acard-image Worker (#61) to WebP, so pages
// never load more than they show; the reader and shared pages then take their 400-1600 px AVIF/WebP copies from it.
async function uploadLookImage(request, env, db, kind) {
  const store = env[MEDIA_BINDING];
  if (!store) return json({ error: "미디어 저장소가 연결되지 않았어요." }, 503);
  const tooBig = "이미지가 너무 커요. 10MB 까지 올릴 수 있어요.";
  if (Number(request.headers.get("content-length") ?? 0) > LOOK_MAX_BYTES + 64 * 1024) return json({ error: tooBig }, 413);
  const form = await request.formData().catch(() => null);
  const file = form ? form.get("file") : null;
  if (!file || typeof file === "string" || !file.size) return json({ error: "올릴 파일이 없어요." }, 400);
  if (file.size > LOOK_MAX_BYTES) return json({ error: tooBig }, 413);
  let bytes = await file.arrayBuffer();
  let mime = sniffImage(bytes);
  if (!mime || !LOOK_TYPES.has(mime)) return json({ error: "png, jpg, webp, gif, avif 이미지만 올릴 수 있어요." }, 415);
  let dimensions = imageDimensions(bytes);
  const target = LOOK_WIDTH[kind];
  if (env.IMAGE_RESIZER && mime !== "image/gif" && !dimensions.animated && (!dimensions.width || dimensions.width > target)) {
    const resized = await env.IMAGE_RESIZER.fetch("https://acard-image/resize?w=" + target + "&f=webp", { method: "POST", body: bytes }).catch(() => null);
    const out = resized && resized.ok ? await resized.arrayBuffer() : null;
    const size = out ? imageDimensions(out) : null;
    if (out && sniffImage(out) === "image/webp" && size.width && size.width <= target && out.byteLength) { bytes = out; mime = "image/webp"; dimensions = size; }
  }
  const page = form.get("page") ? String(form.get("page")).slice(0, 120) : null;
  const name = sanitizeName(file.name || kind);
  const id = mediaId();
  try { await reserveMedia(env, db, bytes.byteLength); }
  catch (error) { if (error instanceof AgentError) return json({ error: error.message }, error.status); throw error; }
  const etag = await mediaEtag(bytes);
  await store.put("media/" + id, bytes, { metadata: { mime, name, size: bytes.byteLength, etag, ...dimensions } });
  await db.prepare("INSERT INTO media (id, page, name, mime, bytes, created, etag) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, page, name, mime, bytes.byteLength, Date.now(), etag).run();
  return json({ ok: true, id, url: "/media/" + id, mime, name, size: bytes.byteLength, width: dimensions.width, height: dimensions.height });
}

async function mediaUsage(env, db) {
  const [used, plan] = await Promise.all([workspaceMediaBytes(db), memberWorkspace(env) ? mediaPlan(env) : null]);
  return json({ used, quota: plan ? plan.quota : null, tier: plan ? plan.tier : null, passUntil: plan ? plan.passUntil : null, fileLimit: LOOK_MAX_BYTES, types: [...LOOK_TYPES], uploadLimit: MEDIA_MAX_BYTES, bufferLimit: MEDIA_BUFFER_BYTES });
}

async function uploadMedia(request, env, db) {
  const store = env[MEDIA_BINDING];
  if (!store) return json({ error: "미디어 저장소가 연결되지 않았어요." }, 503);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MEDIA_BUFFER_BYTES + 64 * 1024) return json({ error: "파일이 너무 커요. 최대 4MB 까지 올릴 수 있어요." }, 413);
  const form = await request.formData().catch(() => null);
  const file = form ? form.get("file") : null;
  if (!file || typeof file === "string" || !file.size) return json({ error: "올릴 파일이 없어요." }, 400);
  if (file.size > MEDIA_BUFFER_BYTES) return json({ error: "파일이 너무 커요. 최대 4MB 까지 올릴 수 있어요." }, 413);
  let mime = baseMime(file.type);
  if (!isAllowedMime(mime)) return json({ error: "이미지, 영상, 소리, PDF, 텍스트 파일만 올릴 수 있어요." }, 415);
  const id = mediaId();
  let name = sanitizeName(file.name);
  const page = form.get("page") ? String(form.get("page")).slice(0, 120) : null;
  let bytes = await file.arrayBuffer();
  if (mime === "image/svg+xml") bytes = new TextEncoder().encode(ACARD_FEATURES.services.sanitizeSvg(new TextDecoder().decode(bytes))).buffer;
  let dimensions = imageDimensions(bytes);
  const originalSize = bytes.byteLength;
  const compressed = await compressUpload(env, bytes, mime);
  if (compressed) { bytes = compressed.bytes; mime = compressed.mime; dimensions = compressed.dimensions; name = webpName(name); }
  try { await reserveMedia(env, db, bytes.byteLength); }
  catch (error) { if (error instanceof AgentError) return json({ error: error.message }, error.status); throw error; }
  const etag = await mediaEtag(bytes);
  await store.put("media/" + id, bytes, { metadata: { mime, name, size: bytes.byteLength, etag, ...dimensions, ...(compressed ? { originalSize } : {}) } });
  await db.prepare("INSERT INTO media (id, page, name, mime, bytes, created, etag) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, page, name, mime, bytes.byteLength, Date.now(), etag).run();
  return json({ ok: true, id, url: "/media/" + id, mime, name, size: bytes.byteLength, ...(compressed ? { originalSize } : {}), width: dimensions.width, height: dimensions.height });
}

export async function mediaEtag(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return '"' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("") + '"';
}

function etagMatches(request, etag) {
  return Boolean(etag && request?.headers.get("if-none-match")?.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag));
}

const MEDIA_HEADERS = { "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow", "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" };

// The trash check and the stored ETag (media.etag, written at upload or on the first full read) come from one row, before
// any storage read: the access checks run on every request exactly as before, then a matching If-None-Match is a 304
// without reading R2.
async function mediaRow(env, id) {
  const db = env[DB_BINDING];
  if (!db) return null;
  await ensureSchema(db);
  return await db.prepare("SELECT m.etag AS etag, m.mime AS mime, m.name AS name, t.page AS trashed FROM media m LEFT JOIN editor_trash t ON t.page = m.page WHERE m.id = ? LIMIT 1").bind(id).first();
}

async function readMedia(env, id, row) {
  const store = env[MEDIA_BINDING];
  if (!store) return json({ error: "미디어 저장소가 연결되지 않았어요." }, 503);
  if (!MEDIA_ID.test(id)) return json({ error: "없는 파일이에요." }, 404);
  if (row === undefined) row = await mediaRow(env, id);
  if (row && row.trashed) return json({ error: "휴지통에 있는 페이지의 파일이에요." }, 404);
  const found = await store.getWithMetadata("media/" + id, { type: "arrayBuffer", cacheTtl: 86400 });
  if (!found || found.value === null) return json({ error: "없는 파일이에요." }, 404);
  return found;
}

// One `bytes=` range from a Range header against a file of `size` bytes: { offset, length }, "bad" when it cannot be
// served (416), or null for no/ignored range (several ranges are answered whole, as RFC 9110 allows).
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Math.min(Number(m[2]), size);
    return suffix > 0 ? { offset: size - suffix, length: suffix } : "bad";
  }
  const start = Number(m[1]), end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "bad";
  return { offset: start, length: end - start + 1 };
}

// R2 originals with a stored ETag are streamed (never read whole) and answer Range requests with 206, so a 50 MB video
// starts at once and seeks (Safari will not play a video whose server ignores Range). Anything else (KV originals, files
// whose ETag is not saved yet, resized copies) takes the buffered path below.
async function streamMedia(env, id, request, row) {
  const store = env[MEDIA_BINDING];
  const range = request ? request.headers.get("range") : null;
  const wantsBody = request?.method !== "HEAD";
  // No Range: one streamed read. Range or HEAD: the size first (a head call, no bytes), then only the asked part.
  const head = range || !wantsBody ? await store.r2Head("media/" + id) : await store.r2Object("media/" + id);
  if (!head) return null;
  const size = Number(head.size);
  const asked = byteRange(range, size);
  const meta = head.meta || {};
  const mime = row.mime || meta.mime || "application/octet-stream";
  const headers = {
    "content-type": mime,
    "cache-control": "private, no-cache",
    etag: row.etag,
    "content-disposition": pickDisposition(mime, row.name || meta.name || id),
    ...MEDIA_HEADERS,
    "x-acard-store": "r2",
    "accept-ranges": "bytes",
  };
  if (asked === "bad") return new Response(null, { status: 416, headers: { ...headers, "content-range": "bytes */" + size } });
  if (!wantsBody) return new Response(null, { status: 200, headers: { ...headers, "content-length": String(size) } });
  if (!asked) {
    const whole = head.body ? head : await store.r2Object("media/" + id);
    return whole && whole.body ? new Response(whole.body, { status: 200, headers: { ...headers, "content-length": String(size) } }) : null;
  }
  const part = await store.r2Object("media/" + id, { range: asked });
  if (!part || !part.body) return null;
  return new Response(part.body, { status: 206, headers: { ...headers, "content-length": String(asked.length), "content-range": "bytes " + asked.offset + "-" + (asked.offset + asked.length - 1) + "/" + size } });
}

async function serveMedia(env, id, request) {
  const store = env[MEDIA_BINDING];
  const row = store && MEDIA_ID.test(id) ? await mediaRow(env, id) : null;
  const width = request ? Number(new URL(request.url).searchParams.get("w")) : 0;
  const variantKey = [400, 800, 1600].includes(width) ? "media/" + id + "@w" + width : null;
  if (row && !row.trashed && row.etag && !variantKey && typeof store.r2Object === "function" && typeof store.r2Head === "function" && !etagMatches(request, row.etag)) {
    const streamed = await streamMedia(env, id, request, row);
    if (streamed) return streamed;
  }
  if (row && !row.trashed && request?.method !== "HEAD") {
    if (!variantKey && etagMatches(request, row.etag)) {
      return new Response(null, { status: 304, headers: { "cache-control": "private, no-cache", etag: row.etag, ...MEDIA_HEADERS } });
    }
    // A resized copy already in KV answers without the original; its ETag is its own bytes' hash, as before.
    const cached = variantKey && (env.IMAGES || env.IMAGES_SVC) ? await store.getWithMetadata(variantKey, { type: "arrayBuffer", cacheTtl: 86400 }) : null;
    if (cached?.value) return mediaResponse(id, cached, request, await mediaEtag(cached.value));
  }
  let found = await readMedia(env, id, row);
  if (found instanceof Response) return found;
  let meta = found.metadata ?? {};
  let etag = null;
  const dimensions = imageDimensions(found.value);
  if ([400, 800, 1600].includes(width) && ["image/png", "image/jpeg", "image/webp"].includes(meta.mime) && dimensions.width && !dimensions.animated && (env.IMAGES || env.IMAGES_SVC)) {
    const key = "media/" + id + "@w" + width;
    const cached = await env[MEDIA_BINDING].getWithMetadata(key, { type: "arrayBuffer", cacheTtl: 86400 });
    if (cached?.value) found = cached;
    else {
      try {
        const target = Math.min(width, dimensions.width);
        const response = env.IMAGES
          ? (await env.IMAGES.input(new Response(found.value).body).transform({ width: target, fit: "scale-down" }).output({ format: "image/webp" })).response()
          : await env.IMAGES_SVC.fetch("https://acard-images/?w=" + target, { method: "POST", headers: { "content-type": meta.mime }, body: found.value });
        if (!response.ok) throw new Error("Images transform failed: " + response.status);
        const value = await response.arrayBuffer();
        const size = imageDimensions(value);
        if (!size.width || !size.height || size.width > target || sniffImage(value) !== "image/webp") throw new Error("Invalid Images output");
        const { etag: _originalEtag, ...variantMeta } = meta;
        found = { value, metadata: { ...variantMeta, mime: "image/webp", width: size.width, height: size.height, size: value.byteLength, animated: false } };
        await env[MEDIA_BINDING].put(key, value, { metadata: found.metadata });
      } catch (error) { console.error("acard media variant unavailable", String(error)); }
    }
    meta = found.metadata ?? {};
  } else {
    etag = row && row.etag ? row.etag : await mediaEtag(found.value);
    // Files stored before ETags were saved get theirs on the first full read, once.
    if (row && !row.etag) await env[DB_BINDING].prepare("UPDATE media SET etag = ? WHERE id = ? AND etag IS NULL").bind(etag, id).run().catch((error) => console.error("acard media etag backfill failed", String(error)));
  }
  return mediaResponse(id, found, request, etag || await mediaEtag(found.value));
}

function mediaResponse(id, found, request, etag) {
  const meta = found.metadata ?? {};
  const mime = meta.mime || "application/octet-stream";
  const headers = {
      "content-type": mime,
      "cache-control": "private, no-cache",
      "etag": etag,
      "content-disposition": pickDisposition(mime, meta.name || id),
      ...MEDIA_HEADERS,
      "x-acard-store": meta.store === "r2" ? "r2" : "kv",
  };
  const matches = etagMatches(request, etag);
  return new Response(matches || request?.method === "HEAD" ? null : found.value, { status: matches ? 304 : 200, headers });
}

function paletteHtml() {
  return [
    '<div class="overlay" id="palette" hidden role="dialog" aria-modal="true" aria-label="빠른 검색">',
    '<div class="sheet">',
    '<input id="palette-q" type="search" placeholder="노트 제목·본문 검색…" aria-label="빠른 검색" autocomplete="off">',
    '<div id="palette-list" class="palette-list" role="listbox"></div>',
    '<div class="palette-hint">↑↓ 고르기 · Enter 열기 · Esc 닫기</div>',
    "</div>",
    "</div>",
  ].join("");
}

function shortcutsHtml() {
  return [
    '<div class="overlay" id="shortcuts" hidden role="dialog" aria-modal="true" aria-label="키보드 단축키">',
    '<div class="sheet">',
    "<h2>키보드 단축키</h2>",
    '<dl class="keys">',
    "<dt>/ · K</dt><dd>빠른 검색 (입력 중 제외)</dd><dt>N · Q · ?</dt><dd>새 페이지 · 빠른 메모 · 도움말 (입력 중 제외)</dd><dt>G → H / T</dt><dd>홈 / 휴지통 (입력 중 제외)</dd><dt>Ctrl/Cmd + Enter</dt><dd>빠른 메모 저장</dd>",
    "<dt>Ctrl/Cmd + K</dt><dd>빠른 검색</dd>",
    "<dt>Ctrl/Cmd + /</dt><dd>이 단축키 목록</dd>",
    "<dt>Ctrl/Cmd + B · \\</dt><dd>사이드바 접기·펴기</dd>",
    "<dt>Esc</dt><dd>열려 있는 창 닫기</dd>",
    "<dt>/</dt><dd>편집기에서 블록 종류 메뉴</dd>",
    "<dt>Tab / Shift+Tab</dt><dd>편집기에서 들여쓰기·내어쓰기</dd>",
    "<dt>Ctrl/Cmd + B/I/U/E</dt><dd>편집기에서 굵게·기울임·밑줄·코드</dd>",
    "</dl>",
    '<button type="button" class="close" id="shortcuts-close" aria-label="닫기">닫기</button>',
    "</div>",
    "</div>",
  ].join("");
}

// 읽기 화면 상단의 더보기 메뉴. 내보내기·인쇄·단축키를 한 곳에 모은다.
function moreMenu(slug, viewMode) {
  const q = encodeURIComponent(slug);
  return [
    '<div class="menuwrap">',
    '<button class="icon" id="more" aria-label="더보기" aria-expanded="false" title="더보기">⋯</button>',
    '<div class="menu" id="more-menu" hidden>',
    viewMode ? '<button type="button" class="menuitem" data-fv-mode="' + (viewMode === "folder" ? "article" : "folder") + '">' + (viewMode === "folder" ? "글로 보기" : "폴더로 보기") + "</button>" : "",
    '<div class="menu-width"></div>',
    '<button type="button" class="menuitem" id="print-pdf">PDF로 저장</button>',
    '<a href="/print/' + q + '/" target="_blank" rel="noopener">인쇄용 화면</a>',
    '<a href="/api/export?slug=' + q + '&format=acard-md" download="' + escapeHtml(slug) + '.md">마크다운으로 내보내기</a>',
    '<a href="/api/export?slug=' + q + '&format=md" download="' + escapeHtml(slug) + '.notion.md">노션용 마크다운으로 내보내기</a>',
    '<a href="/api/export?slug=' + q + '&format=html" download="' + escapeHtml(slug) + '.html">HTML로 내보내기</a>',
    '<a href="/api/export?scope=all&format=zip" download="acard.zip">전체 노트 내보내기 (zip)</a>',
    '<a class="menuitem" href="/graph?around=' + q + '">그래프 보기</a>',
    '<button type="button" class="menuitem" id="shortcuts-open">키보드 단축키</button>',
    '<button type="button" class="menuitem" id="quick-note-open">빠른 메모</button>',
    "</div>",
    "</div>",
  ].join("");
}

// 인쇄·PDF용 화면. 화면용 CSS 를 쓰지 않고 인쇄에 맞춘 최소 스타일만 쓴다.
function printShell(page, blocks) {
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="color-scheme" content="light">',
    "<title>" + escapeHtml(page.title) + " · __SITE_NAME__</title>",
    "<style>",
    ':root{color-scheme:light}',
    'body{margin:0;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Segoe UI",Roboto,sans-serif;font-size:11.5pt;line-height:1.75;word-break:keep-all}',
    ".sheet{max-width:780px;margin:0 auto;padding:32px 26px 60px}",
    "h1{font-size:22pt;line-height:1.3;margin:0 0 6px;letter-spacing:-.03em}",
    ".meta{color:#666;font-size:9.5pt;margin:0 0 22px;padding-bottom:10px;border-bottom:1px solid #ddd}",
    "h2{font-size:15pt;margin:22px 0 6px}h3{font-size:12.5pt;margin:16px 0 4px}h4{font-size:11.5pt;margin:14px 0 4px}",
    "p{margin:0 0 10px}ul,ol{padding-left:22px;margin:0 0 12px}li{margin:3px 0}",
    "blockquote{margin:12px 0;padding:2px 14px;border-left:2px solid #bbb;color:#444}",
    "pre{background:#f4f4f4;padding:10px 12px;border-radius:6px;overflow-x:auto;white-space:pre-wrap}",
    "code{background:#f1f1f1;padding:0 4px;border-radius:4px}",
    "pre code{background:none;padding:0}",
    "table{border-collapse:collapse;width:100%;margin:12px 0;font-size:10pt}",
    "th,td{border:1px solid #ccc;padding:5px 8px;text-align:left}th{background:#f6f6f6}",
    ".todo{display:flex;gap:7px;margin:0 0 6px}.todo .box{width:13px;height:13px;margin-top:4px;border:1.2px solid #999;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:9pt}",
    ".todo.on span:last-child{color:#777;text-decoration:line-through}",
    ".callout{margin:12px 0;padding:9px 13px;border-radius:8px;background:#f6f2ea;border-left:3px solid #9a6a2f}",
    ".toggle{margin:6px 0}",
    ".toggle summary{font-weight:600}",
    "hr{border:0;border-top:1px solid #ccc;margin:18px 0}",
    // Evidence labels keep their colors on paper (no tokens on this page): the light success/warning/info tones.
    ".ev{--fs-11:8pt;--radius-pill:999px;--space-2:6px;--color-success-bg:#edf3ec;--color-success-fg:#346538;--color-warning-bg:#fbf3db;--color-warning-fg:#956400;--color-info-bg:#e1f3fe;--color-info-fg:#1f6c9f;-webkit-print-color-adjust:exact;print-color-adjust:exact}",
    // Footnote numbers (block-html.js FOOTNOTE_CSS) get their small size here too; the page has no tokens.
    ".fnref{--fs-12:8pt;--accent:#1f6c9f}",
    ".backlinks{margin-top:26px;padding-top:10px;border-top:1px solid #ddd;font-size:9.5pt;color:#666}",
    ".bar{position:sticky;top:0;display:flex;gap:10px;align-items:center;justify-content:flex-end;padding:8px 12px;background:#fff;border-bottom:1px solid #eee}",
    ".bar a,.bar button{font:inherit;font-size:10pt;color:#333;background:#f4f4f4;border:1px solid #ddd;border-radius:999px;padding:5px 12px;cursor:pointer;text-decoration:none}",
    "@page{margin:16mm}",
    "@media print{.bar{display:none}.sheet{padding:0;max-width:none}a{color:inherit;text-decoration:none}.toggle[open] summary{list-style:none}.toggle:not([open])>*:not(summary){display:block}}",
    "</style>",
    "</head>",
    "<body>",
    '<div class="bar"><button type="button" id="do-print">인쇄 · PDF로 저장</button><a href="/' + (page.slug === "index" ? "" : encodeURIComponent(page.slug) + "/") + '">읽기 화면으로</a></div>',
    '<main class="sheet">',
    "<h1>" + escapeHtml(page.title) + "</h1>",
    '<p class="meta">__SITE_NAME__ · ' + escapeHtml(page.slug) + "</p>",
    renderBlocks(blocks),
    "</main>",
    "<script>document.getElementById('do-print').addEventListener('click',function(){window.print()});</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------- 라우팅 ----------

const API = "/api";

//__FEATURES__

export default {
  async fetch(request, env) {
    // acard-home-first: on notes.example.com "/" is the landing for everyone, so the workspace home also lives at /home/. Every
    // edition reads /home/ exactly as "/" (same asset, same row), so in-app links can name /home/ everywhere.
    if ((request.method === "GET" || request.method === "HEAD") && /^\/home\/?$/.test(new URL(request.url).pathname)) {
      const home = new URL(request.url);
      home.pathname = "/";
      request = new Request(home, request);
    }
    const url = new URL(request.url);
    const password = env.GATE_PASSWORD;
    const secret = env.GATE_SECRET;
    const trusted = TRUSTED_ENVS.has(env);

    if (!trusted && (!password || !secret)) {
      return new Response("준비 중이에요.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-dori-gate": "1" },
      });
    }

    if (url.pathname === "/__gate") {
      if (request.method !== "POST") return challenge("", "/", 405);
      const form = await request.formData().catch(() => null);
      const next = safeNext(form ? String(form.get("next") ?? "/") : "/");
      const given = form ? String(form.get("pw") ?? "") : "";
      if (!constantTimeEqual(given, password)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return challenge("비밀번호가 달라요.", next, 401);
      }
      const expires = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
      const ticket = expires + "." + (await sign(secret, String(expires)));
      return new Response(null, {
        status: 303,
        headers: {
          Location: next,
          "cache-control": "no-store",
          "Set-Cookie": COOKIE_NAME + "=" + ticket + "; Path=/; Max-Age=" + MAX_AGE_SECONDS + "; HttpOnly; Secure; SameSite=Lax",
        },
      });
    }

    if (url.pathname === "/__logout") {
      if (request.method !== "POST") return challenge("", "/", 405);
      return new Response(null, { status: 303, headers: { Location: "/", "cache-control": "no-store", "Set-Cookie": COOKIE_NAME + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
    }

    if (url.pathname === AGENT_API || url.pathname.startsWith(AGENT_API + "/")) {
      return await serveAgentApi(request, env, url);
    }

    const changing = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
    const given = request.headers.get("origin");
    if (changing && given && given !== url.origin && (url.pathname.startsWith(API + "/") || url.pathname.startsWith("/s/") || url.pathname.startsWith("/form/"))) {
      return json({ error: "다른 사이트에서 온 요청은 받지 않아요." }, 403);
    }

    // Guests (verified invited emails) never reach the routes below directly: the share resolver checks the route
    // table first and continues with a view env whose DB only reveals the pages it may read.
    if (trusted && env.ACARD_GUEST_TOKEN !== undefined) {
      if (!ACARD_FEATURES.services.guestFetch) return json({ error: "권한이 없어요." }, 401);
      return await ACARD_FEATURES.services.guestFetch(request, env, url, (inner, view) => this.fetch(inner, view));
    }

    if ((url.pathname.startsWith("/p/") || url.pathname.startsWith("/s/")) && ACARD_FEATURES.publicRoutes.length) {
      const db = env[DB_BINDING];
      if (db) await ensureSchema(db);
      const ctx = featureContext(request, env, db, url);
      // #57: a dropped or busy database socket on a public page is a short wait (503 + Retry-After), not a 500/1101.
      try {
        for (const hook of ACARD_FEATURES.publicRoutes) {
          const response = await hook(ctx);
          if (response !== null) return response;
        }
      } catch (error) {
        if (!DB_TRANSIENT.test(String(error && error.message ? error.message : error))) throw error;
        return url.pathname.startsWith("/p/") && request.method === "GET" && /text\/html/.test(request.headers.get("accept") ?? "") ? busyPageResponse(error) : serverError(error);
      }
    }

    // The visual kit's static pictures (/kit/: icon sprite, header and empty-state art, patterns, covers) are part of
    // the build, never note data; shared pages show them to signed-out readers.
    if (url.pathname.startsWith("/kit/") && (request.method === "GET" || request.method === "HEAD") && /^\/kit\/[a-z0-9/_-]+\.(?:svg|webp|json)$/.test(url.pathname)) {
      return env.ASSETS.fetch(request);
    }
    // Service-worker update requests can omit the gate cookie. This generated
    // script contains policy and asset hashes only, never note data.
    if (url.pathname === "/sw.js" && request.method === "GET") {
      const asset = await env.ASSETS.fetch(request);
      return new Response(asset.body, { status: asset.status, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    }

    if (!trusted && !(await hasValidTicket(request, secret))) {
      return challenge("", safeNext(url.pathname + url.search), 401);
    }

    const db = env[DB_BINDING];
    const isApi = url.pathname === API || url.pathname.startsWith(API + "/");
    const isEditor = url.pathname === "/edit" || url.pathname.startsWith("/edit/");

    if ((isApi || isEditor) && !db) {
      return json({ error: "저장소가 연결되지 않았어요." }, 503);
    }

    if (isApi) {
      try {
        await ensureSchema(db);
        await syncIfStale(db, env, request);
        return await handleApi(request, env, db, url);
      } catch (error) {
        if (error instanceof AgentError) return json({ error: error.message }, error.status);
        // A path segment with a well-formed but non-UTF-8 escape (/api/page/%E0%A4%A) is the caller's input, not a fault.
        if (error instanceof URIError) return json({ error: "주소를 읽지 못했어요." }, 400);
        return serverError(error);
      }
    }

    for (const hook of ACARD_FEATURES.authenticatedRoutes) {
      const response = await hook(featureContext(request, env, db, url));
      if (response !== null) return response;
    }

    const printMatch = /^\/print\/(.+?)\/?$/.exec(url.pathname);
    if (printMatch && db) {
      let slug;
      try { slug = decodeURIComponent(printMatch[1]); }
      catch { return json({ error: "bad_path" }, 400); }
      await ensureSchema(db);
      const found = await readPage(db, slug);
      if (!found) return new Response("없는 페이지예요.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
      const blocks = materializeSyncedBlocks(found.blocks, await resolveSyncedBlocks(db, slug, found.blocks, syncedReadOptions(db, env, true)));
      return new Response(printShell(found.page, blocks), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
      });
    }

    if (isEditor) {
      const [, asset] = await Promise.all([ensureSchema(db), env.ASSETS.fetch(new Request(new URL("/editor.html", request.url)))]);
      if (!asset.ok) return new Response("에디터를 찾을 수 없어요.", { status: 500 });
      if (!isGuest(env)) return new Response((await asset.text()).replace("</body>", FOLDERS_TAG + "</body>"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
      return new Response((await asset.text()).replace("</body>", LIVE_TAG + "</body>"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
    }

    const mediaMatch = /^\/media\/([^/]+)\/?$/.exec(url.pathname);
    if (mediaMatch || url.pathname === "/media" || url.pathname.startsWith("/media/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "없는 API예요." }, 405);
      return await serveMedia(env, mediaMatch ? mediaMatch[1] : "", request);
    }

    const readerStarted = performance.now();
    const stages = [];
    let stageStarted = readerStarted;
    const stage = (name) => { const now = performance.now(); stages.push(name + ";dur=" + (now - stageStarted).toFixed(2)); stageStarted = now; };
    const readerResponse = (response) => {
      response.headers.set("server-timing", ["reader;dur=" + (performance.now() - readerStarted).toFixed(2), ...stages].join(", "));
      return response;
    };
    const pageMatch = /^\/([^/]+)\/?$/.exec(url.pathname) || (url.pathname === "/" ? ["/", "index"] : null);
    // Schema setup (memoised per isolate) runs while the asset is fetched for a page-shaped path (not /style.css and the
    // like); a failure is thrown inside the try below as before.
    const schemaReady = db && pageMatch && !/\.[a-z0-9]{1,8}$/i.test(url.pathname) ? ensureSchema(db).then(() => null, (error) => error || new Error("schema")) : null;
    const asset = await env.ASSETS.fetch(request);
    stage("assets");
    const isHtml = asset.ok && /^text\/html/.test(asset.headers.get("content-type") ?? "");
    if (db && pageMatch && (asset.status === 404 || isHtml)) {
      try {
        const schemaError = await (schemaReady ?? ensureSchema(db).then(() => null));
        if (schemaError) throw schemaError;
        const slug = resolveSlug(decodeURIComponent(pageMatch[1]));
        // #39: a copied or agent-made address (NFD Hangul, encoded twice) goes to the page it names.
        const canonical = pageRef(pageMatch[1]);
        if (canonical !== slug && request.method === "GET" && await db.prepare("SELECT slug FROM pages WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = pages.slug)").bind(canonical).first()) {
          return new Response(null, { status: 301, headers: { location: "/" + encodeURIComponent(canonical) + "/" + url.search, "cache-control": "no-store" } });
        }
        const welcome = slug === "index" && isHtml && ACARD_FEATURES.services.homeWelcome ? await ACARD_FEATURES.services.homeWelcome(db) : "";
        if (welcome) return new Response((await asset.text()).replace('<article id="article">', '<article id="article">' + welcome).replace("</body>", (isGuest(env) ? "" : FOLDERS_TAG + (isMember(env) ? HOME_TAG : "")) + "</body>"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
        // A page with no build asset can only come from the DB, so its blocks travel with the row and meta (one round trip
        // on a member store, one statement on Postgres); an owner build page reads blocks only once it knows it needs them.
        const pageRead = async () => {
          if (isHtml) return [...await Promise.all([db.prepare("SELECT slug, title, parent, ord, kind, updated, source FROM pages WHERE slug = ?").bind(slug).first(), readEditorPageMeta(db, slug)]), null];
          if (db.dialect === "pg") { const [page, rows, meta] = await readPageOnce(db, slug); return [page, meta, rows]; }
          return Promise.all([db.prepare("SELECT slug, title, parent, ord, kind, updated, source FROM pages WHERE slug = ?").bind(slug).first(), readEditorPageMeta(db, slug), db.prepare(PAGE_BLOCKS_READ).bind(slug).all()]);
        };
        let [row, appearance, blockRows] = await pageRead();
        // The member home is only re-made (a round trip plus quota-counted writes) when it is missing or in the trash.
        if (isMember(env) && slug === "index" && (!row || appearance.trashed)) { await ensureMemberHome(db, env); [row, appearance, blockRows] = await pageRead(); }
        stage("metadata");
        if (appearance.trashed) return readerResponse(new Response(missingPageHtml(slug, true), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } }));
        const liveDatabase = row && slug === "board" && row.kind === "db" && await db.prepare("SELECT id FROM databases WHERE slug = ?").bind(slug).first();
        if (row && (slug === "board" && row.kind === "db" && !isGuest(env) ? liveDatabase : (isGuest(env) || row.source === "editor" || appearance.settings.icon || appearance.settings.cover || appearance.settings.font !== "default" || appearance.settings.width !== "default" || appearance.settings.small === true))) {
          const found = await readPage(db, slug, { page: row, meta: appearance, rows: blockRows });
          stage("blocks");
          if (found) {
            found.blocks = materializeSyncedBlocks(found.blocks, await resolveSyncedBlocks(db, slug, found.blocks, syncedReadOptions(db, env)), true);
            if (isMember(env)) found.page.ws = "member";
            if (isGuest(env)) Object.assign(found.page, { ws: "guest", guest: env.ACARD_GUEST_EMAIL, guestWs: env.ACARD_WORKSPACE && env.ACARD_WORKSPACE !== "owner" ? env.ACARD_WORKSPACE : "o", readOnly: !canWriteSlug(db, slug) });
            const [extras, agent, tree, folderHtml] = await Promise.all([
              pageExtras(db, found.page, found.blocks, url.searchParams.get("view")), latestAgentAuthor(db, found.page), readTree(db),
              ACARD_FEATURES.services.folderView && found.page.kind === "note" && slug !== "index" && url.searchParams.get("as") !== "article"
                ? ACARD_FEATURES.services.folderView(db, found.page, found.blocks, isGuest(env)).catch(() => null) : null,
            ]);
            stage("extras");
            if (agent) found.page.agent = agent;
            if (ACARD_FEATURES.services.folderView && found.page.kind === "note" && slug !== "index") {
              extras.folderHtml = folderHtml;
              extras.viewMode = extras.folderHtml ? "folder" : "article";
            }
            const html = pageShell(found.page, found.blocks, tree, extras, found.settings);
            stage("render");
            return readerResponse(new Response(html, {
              headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
            }));
          }
        }
        if (asset.status === 404 && request.method === "GET" && /text\/html/.test(request.headers.get("accept") ?? "")) {
          return readerResponse(new Response(missingPageHtml(slug, appearance.trashed), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } }));
        }
      } catch (error) {
        // #44: a database error (pooler out of connections, network) is not a missing page.
        if (request.method === "GET" && (asset.status === 404 || isHtml)) return busyPageResponse(error);
        return asset;
      }
      if (isHtml && !isGuest(env)) return readerResponse(new Response((await asset.text()).replace("</body>", FOLDERS_TAG + "</body>"), { status: asset.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } }));
    }
    return asset;
  },
};

function busyPageResponse(error) {
  console.error("acard page read failed", error && error.message ? error.message : String(error));
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>잠시만요 · __SITE_NAME__</title><link rel="stylesheet" href="/style.css"></head><body><main id="main" class="missing busy" data-retry="1" role="status" aria-live="polite"><h1>잠시 연결이 몰렸어요, 다시 시도 중…</h1><p>페이지는 그대로 있어요. 곧 다시 불러올게요. <span id="busy-left"></span></p><p><button type="button" id="busy-retry">지금 다시 시도</button> · <a href="/">홈으로</a></p></main>' + BUSY_RETRY_SCRIPT + "</body></html>";
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "2", "x-robots-tag": "noindex, nofollow" } });
}
// Retries 2, 4, 8, 15, 15 ... seconds apart (the count lives in sessionStorage per address so a reload keeps it).
const BUSY_RETRY_SCRIPT = '<script>(function(){var k="acard-busy:"+location.pathname,n=0;try{n=+sessionStorage.getItem(k)||0}catch(e){}var w=Math.min(15,2<<Math.min(n,3)),left=document.getElementById("busy-left"),go=function(){try{sessionStorage.setItem(k,String(n+1))}catch(e){}location.reload()};document.getElementById("busy-retry").onclick=go;var t=w;(function tick(){if(left)left.textContent=t+"초 뒤 다시 시도해요.";if(t--<=0)return go();setTimeout(tick,1e3)})()})()</script>';

// #39: the reader's 404 for a signed-in person. The usual cause is a link from an agent that writes to another workspace
// (personal vs team), so the page says that and how to get back, instead of a bare "Not Found".
function missingPageHtml(slug, trashed) {
  const body = trashed
    ? "<p>'" + escapeHtml(slug) + "' 페이지는 휴지통에 있어요. 휴지통에서 복원할 수 있어요.</p>"
    : "<p>'" + escapeHtml(slug) + "' 페이지가 지금 로그인한 워크스페이스에 없어요.</p><p>에이전트가 다른 워크스페이스(개인/팀)에 쓴 페이지일 수 있어요. 그 계정으로 로그인하거나, 에이전트 연결을 이 워크스페이스로 다시 맺어 주세요.</p>";
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>없는 페이지예요 · __SITE_NAME__</title><link rel="stylesheet" href="/style.css"></head><body><main id="main" class="missing" data-missing="' + escapeHtml(slug) + '"><h1>없는 페이지예요</h1>' + body + '<p><a href="/home/">홈으로</a> · <a href="/settings/agents/">에이전트 연결</a></p></main></body></html>';
}

const AGENT_API = "/api/v1";
const HOME_TAG = '<link rel="stylesheet" href="/lazy/ui-kit-css.css?v=__UI_KIT_CSS__"><link rel="stylesheet" href="/lazy/ui-home-css.css?v=__HOME_CSS__"><script src="/lazy/ui-home-js.js?v=__HOME_JS__" defer></script>';
// Before first paint (#35): keeps the server tree rows hidden until lazy/folders.js marks .side-ws as fd-host and swaps in
// its tree (3 s fallback), so no menu row ever moves.
const PJ_SIDE_PH = '<style>.fd-wait .side-ws:not(.fd-host)>*{visibility:hidden}</style><script>var R=document.documentElement;R.classList.add("fd-wait");setTimeout(function(){R.classList.remove("fd-wait")},3e3)</script>';
const LIVE_TAG = '<script src="/lazy/live.js?v=__LIVE_JS__" defer></script>';
const FOLDERS_TAG = '<link rel="stylesheet" href="/lazy/folders.css?v=__FOLDERS_CSS__"><script src="/lazy/folders.js?v=__FOLDERS_JS__" defer></script>' + LIVE_TAG;

// Per-page agent rules (features/share.js) only narrow the token's scopes. A token narrowed to nothing on the page
// it names gets 403, never a widened scope.
async function narrowAgent(db, principal, slug) {
  const service = ACARD_FEATURES.services.agentScopes;
  if (!service || !slug) return principal;
  const scopes = await service(db, principal, slug);
  if (!scopes.length) throw new AgentError("이 페이지에는 이 에이전트의 권한이 없어요.", 403);
  return scopes.length === principal.scopes.length ? principal : { ...principal, scopes };
}

// 에이전트가 마지막으로 쓴 뒤 사람이 다시 고쳤다면(페이지 updated 가 더 늦으면) 사람 표시를 그대로 둔다.
async function latestAgentAuthor(db, page) {
  try {
    await ensureAgentSchema(db);
    const row = await db.prepare("SELECT agent, created FROM agent_activity WHERE page = ? ORDER BY created DESC LIMIT 1").bind(page.slug).first();
    return row && Number(row.created) >= Number(page.updated) ? String(row.agent) : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function agentHelpers(env) {
  return {
    json, slugify, resolveSlug, readTree, readPage, normaliseBlocks, saveBlocks, saveAgentBlocks, captureEditorVersion, syncPageTitleToRow,
    markdownToBlocks, blocksToMarkdown, readDatabase, dbRowRequest, services: ACARD_FEATURES.services, guardAgentButtons,
    ingestImages: (db, page, blocks) => ingestImages(env, db, page, blocks),
  };
}

async function ingestImages(env, db, page, blocks) {
  if (!env || !env[MEDIA_BINDING] || !ACARD_FEATURES.services.ingestImages) return [];
  return ACARD_FEATURES.services.ingestImages(db, page, blocks, (p, name, mime, bytes, source) => storeAgentImage(env, db, p, name, mime, bytes, source));
}

// 기존 데이터베이스 행 API 를 그대로 불러 검증·제목 동기화 규칙을 한 곳에만 둔다.
async function rowProperties(db, database) {
  const propRows = await db.prepare("SELECT id, name, type, config, ord, width, hidden FROM db_properties WHERE database_id = ? ORDER BY ord, name").bind(database.id).all();
  return (propRows.results ?? []).map((row, index) => normaliseProperty({ id: row.id, name: row.name, type: row.type, config: parseJson(row.config, {}), ord: row.ord, width: row.width, hidden: row.hidden === 1 }, index));
}

// 행 만들기(행 POST 와 버튼 create_row 가 같이 쓴다): 템플릿 값, ID 번호, 규칙, 사람 검사, 양방향 관계, 행 페이지.
// prepare 는 읽기와 검사만 한다(권한 검사는 applyRowProps -> relationChangeDenied). build 는 검사가 모두 끝난 뒤 ID 번호를 받고
// 행·행 페이지·관계 문장을 돌려준다. 쓰기는 호출하는 쪽이 한 batch 로 한다(#86: 권한·검사가 실패하면 아무것도 쓰이지 않는다.
// ID 번호 카운터만은 검사를 모두 통과한 뒤 batch 전에 올리므로, batch 가 실패하면 번호 하나가 비어 남을 수 있다).
async function prepareCreateRow(db, env, database, body) {
  const props = body.props && typeof body.props === "object" ? body.props : {};
  let template = null;
  if (body.template) {
    const found = await db.prepare("SELECT id, name, icon, props, blocks FROM db_templates WHERE id = ? AND database_id = ?").bind(String(body.template), database.id).first();
    if (found) template = { id: String(found.id), props: parseJson(found.props, {}), blocks: parseJson(found.blocks, []), name: found.name };
  }
  const properties = await rowProperties(db, database);
  // #86: 템플릿 값은 속성 id 키로만 쓴다(runDueTemplates 와 같다). 요청 body.props 는 이름 키도 된다.
  const templateProps = {};
  if (template) for (const prop of properties) if (template.props[prop.id] !== undefined) templateProps[prop.id] = template.props[prop.id];
  const merged = Object.assign({}, templateProps, props);
  if (!validBoardProgress(database, properties, merged)) return { error: "진행률은 0부터 100까지의 숫자로 입력해 주세요.", status: 400 };
  const titleProp = properties.find((prop) => prop.type === "title");
  const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM db_rows WHERE database_id = ?").bind(database.id).first();
  const id = scopedId(database.id, dbId("r"));
  const normalised = {};
  properties.forEach((prop) => {
    const incoming = merged[prop.id] !== undefined ? merged[prop.id] : merged[prop.name];
    normalised[prop.id] = incoming === undefined ? emptyValue(prop) : normaliseCellValue(prop, incoming);
  });
  for (const prop of properties) if (prop.type === "unique_id") normalised[prop.id] = null;
  if (template) {
    // #86: 템플릿에서 온 관계 값은 그 템플릿을 저장한 사람 권한으로 본다(runDueTemplates 와 같은 판정).
    const fromTemplate = {};
    for (const prop of properties) if (templateProps[prop.id] !== undefined && props[prop.id] === undefined && props[prop.name] === undefined) fromTemplate[prop.id] = normalised[prop.id];
    if (await templateSaverDenied(db, database, properties, template.id, fromTemplate)) return { error: TEMPLATE_STOPPED, status: 403 };
  }
  for (const hook of ACARD_FEATURES.beforeRowWrite) await hook({ db, database, properties, before: null, props: normalised });
  const personError = await personGuard(db, env, database, properties, null, normalised);
  if (personError) return { error: personError, status: 400 };
  const relations = await applyRowProps(db, database, properties, id, normalised, { lenient: !!template });
  if (relations.error) return { error: relations.error, status: relations.status };
  const title = (titleProp ? String(normalised[titleProp.id] || "") : "") || "새 행";
  const baseOrd = Number(maxRow && maxRow.m ? maxRow.m : 0) + 10;
  // offset: 같은 batch 에서 같은 DB 에 만드는 앞선 행 수. taken: 같은 batch 에서 이미 고른 페이지 주소.
  // ID 번호는 한 번만 받는다: 같은 순간 같은 페이지 주소를 골라 batch 를 다시 만들 때도 번호를 새로 쓰지 않는다.
  let numbered = false;
  const build = async (offset = 0, taken = new Set()) => {
    if (!numbered) for (const prop of properties) if (prop.type === "unique_id") normalised[prop.id] = await nextUniqueId(db, database.id, prop.id);
    numbered = true;
    let slug = slugify(title);
    if (taken.has(slug) || await db.prepare("SELECT slug FROM pages WHERE slug = ?").bind(slug).first()) slug = slugify(title) + "-" + Math.random().toString(36).slice(2, 8);
    taken.add(slug);
    const now = Date.now();
    const ord = baseOrd + offset * 10;
    const blocks = normaliseBlocks(template && template.blocks.length ? template.blocks : [{ id: "b1", type: "paragraph", text: "", checked: false, indent: 0, meta: null }]);
    const row = { id, page: slug, ord, props: normalised, created: now, updated: now };
    return {
      row, slug, blocks,
      statements: [
        ...relations.locks,
        db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, 'db_row', ?, 'editor', NULL)").bind(slug, title.slice(0, 200), database.slug, now % 100000, now),
        ...blockStatements(db, slug, blocks),
        db.prepare("INSERT INTO db_rows (id, database_id, page, props, ord, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, database.id, slug, JSON.stringify(normalised), ord, now, now),
        ...relations.statements,
      ],
    };
  };
  return { build };
}

// 한 batch 로 쓰고, 순환 가드는 400 으로, 같은 순간 같은 페이지 주소를 고른 경쟁은 다시 준비해서(최대 3번) 푼다.
async function commitRowWrites(db, prepareAll) {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await prepareAll();
    if (ready.error) return ready;
    try {
      if (ready.statements.length) await db.batch(ready.statements);
      return ready;
    } catch (error) {
      if (isCycleError(error)) return { error: CYCLE_ERROR, status: 400 };
      if (attempt >= 2 || !/unique|duplicate/i.test(String(error && error.message))) throw error;
    }
  }
}

async function createRow(db, env, database, body) {
  const prepared = await prepareCreateRow(db, env, database, body);
  if (prepared.error) return prepared;
  const done = await commitRowWrites(db, () => prepared.build());
  if (done.error) return { error: done.error, status: done.status };
  await afterBlockSave(db, done.slug, done.blocks);
  const saved = await db.prepare("SELECT props FROM db_rows WHERE id = ?").bind(done.row.id).first();
  return { row: { ...done.row, props: parseJson(saved && saved.props, done.row.props) } };
}

// 행 값 바꾸기(행 PATCH 와 버튼 update_row/update_related 가 같이 쓴다): 소속 확인, 행 쓰기 권한, 보드 진행률, 사람 검사,
// 관계 동기화(상대 행 권한 포함), 제목 동기화. 읽기와 검사만 하고 문장을 돌려준다. 쓰기는 호출하는 쪽이 한 batch 로 한다.
// chain: 같은 행에 앞 단계가 있으면 그 결과({ props, touched })에서 이어 간다(규칙은 단계마다 돌고, 쓰는 것은 마지막 상태 하나).
async function preparePatchRow(db, env, database, rowId, incoming, chain = null) {
  const row = await db.prepare("SELECT id, page, props FROM db_rows WHERE id = ? AND database_id = ?").bind(rowId, database.id).first();
  if (!row) return { error: "없는 행이에요.", status: 404 };
  if (!canWriteRow(db, row, database.slug)) return { error: "이 행을 편집할 권한이 없어요.", status: 401 };
  if (!incoming) return { statements: [] };
  const properties = await rowProperties(db, database);
  if (!validBoardProgress(database, properties, incoming)) return { error: "진행률은 0부터 100까지의 숫자로 입력해 주세요.", status: 400 };
  const { before, props: merged } = await updatedRowProps(db, rowId, incoming, properties, database, chain ? chain.props : null);
  const personError = await personGuard(db, env, database, properties, before, merged);
  if (personError) return { error: personError, status: 400 };
  const touched = new Set([...(chain ? chain.touched : []), ...properties.filter((prop) => incomingValue(incoming, prop) !== undefined).map((prop) => prop.id)]);
  const relations = await applyRowProps(db, database, properties, rowId, merged, { touched });
  if (relations.error) return { error: relations.error, status: relations.status };
  const now = Date.now();
  const statements = [
    ...relations.locks,
    db.prepare("UPDATE db_rows SET props = ?, updated = ? WHERE id = ?").bind(JSON.stringify(merged), now, rowId),
    ...relations.statements,
  ];
  const titleProp = properties.find((prop) => prop.type === "title");
  const touchesTitle = titleProp && (hasKey(incoming, titleProp.id) || hasKey(incoming, titleProp.name) || merged[titleProp.id] !== parseJson(row.props, {})[titleProp.id]);
  if (touchesTitle && row.page) statements.push(db.prepare("UPDATE pages SET title = ?, updated = ? WHERE slug = ?").bind(String(merged[titleProp.id] || "제목 없음").slice(0, 200), now, row.page));
  return { statements, props: merged, touched };
}

async function patchRow(db, env, database, rowId, incoming) {
  const done = await commitRowWrites(db, () => preparePatchRow(db, env, database, rowId, incoming));
  return done.error ? { error: done.error, status: done.status } : { ok: true };
}

// ---------- 동작형 버튼(notion-parity C3 블록, C4 속성)의 공용 실행기 ----------
// 동작은 데이터(JSON 목록)로 저장되고 여기서만 실행된다. 외부 네트워크 호출·예약·수식 값 계산은 없다.
const BUTTON_ACTION_MAX = 10;
const BUTTON_ROWS_MAX = 500;
const BUTTON_ACTION_TYPES = ["confirm", "create_row", "open", "update_row", "update_related"];

function validButtonValues(values) {
  if (values === undefined) return true;
  if (!values || typeof values !== "object" || Array.isArray(values)) return false;
  const keys = Object.keys(values);
  return keys.length <= 100 && keys.every((key) => typeof key === "string" && key.length <= 80);
}

// 동작 목록 모양 검사. 틀린 동작은 null(저장 경로는 버리고, 실행은 400).
function normaliseButtonActions(input) {
  if (!Array.isArray(input) || input.length > BUTTON_ACTION_MAX) return null;
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || BUTTON_ACTION_TYPES.indexOf(raw.type) < 0) return null;
    if (raw.type === "confirm") out.push({ type: "confirm", message: String(raw.message ?? "").slice(0, 300) });
    else if (raw.type === "open") {
      if (raw.target === "url") {
        const url = String(raw.url ?? "").trim().slice(0, 2000);
        if (!/^(https?:\/\/|\/)/.test(url) || /^\/\//.test(url)) return null;
        out.push({ type: "open", target: "url", url });
      } else out.push({ type: "open", target: "created" });
    } else if (raw.type === "create_row") {
      if (typeof raw.database !== "string" || !raw.database || raw.database.length > 200 || !validButtonValues(raw.values)) return null;
      out.push({ type: "create_row", database: raw.database, ...(typeof raw.template === "string" && raw.template ? { template: raw.template.slice(0, 80) } : {}), values: raw.values || {} });
    } else if (raw.type === "update_row") {
      if (!validButtonValues(raw.values)) return null;
      out.push({ type: "update_row", values: raw.values || {} });
    } else {
      if (typeof raw.relation !== "string" || !raw.relation || raw.relation.length > 80 || !validButtonValues(raw.values)) return null;
      out.push({ type: "update_related", relation: raw.relation, values: raw.values || {} });
    }
  }
  return out;
}

// 값 해석: 고정값 그대로, {relative:"today"} 오늘 날짜, {relative:"now"} 지금 날짜+시각, {ref:"row"} 누른 행 id(관계 칸).
function resolveButtonValues(values, ctx, now) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (value.relative === "today") { out[key] = { start: new Date(now).toISOString().slice(0, 10), end: null }; continue; }
      if (value.relative === "now") { out[key] = { start: new Date(now).toISOString().slice(0, 16), end: null }; continue; }
      if (value.ref === "row") { out[key] = ctx.row ? [ctx.row] : []; continue; }
    }
    out[key] = value;
  }
  return out;
}

// ---------- #107: 버튼은 누른 사람과 동작을 저장한 사람 권한의 교집합으로만 쓴다 ----------
// 손님이 저장한 동작을 소유자가 눌러도 소유자 권한을 빌려 주지 않는다. 저장한 손님을 다시 확인할 수 없으면(세션이 끝남·기록을 못 읽음)
// 아무것도 쓰지 않는다. 기록이 없는 버튼(이 수정 전에 저장됨, 에이전트·가져오기로 만듦)은 예전처럼 누른 사람 권한으로 돈다.
const BUTTON_STOPPED = "권한을 확인할 수 없는 손님이 만든 버튼이에요. 버튼 동작을 다시 저장해 주세요.";

function propButtonKey(propId) { return "prop:" + propId; }
function blockButtonKey(slug, blockId) { return "block:" + slug + ":" + blockId; }

// guard: { sql, binds } - 같은 batch 의 저장이 성공할 때만 기록한다(페이지 저장의 editor_history 조건).
function buttonSaverStatement(db, key, guard) {
  const roles = {};
  if (db.acardRoles) for (const [slug, role] of db.acardRoles) if (WRITE_ROLES.includes(role)) roles[slug] = role;
  const who = db.acardSaver || {};
  return db.prepare("INSERT INTO db_button_savers (button, kind, session, email, roles, saved) SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS BIGINT) WHERE " + (guard ? guard.sql : "1 = 1") + " ON CONFLICT (button) DO UPDATE SET kind = excluded.kind, session = excluded.session, email = excluded.email, roles = excluded.roles, saved = excluded.saved")
    .bind(key, db.acardRoles ? "guest" : "owner", db.acardRoles ? who.session || null : null, db.acardRoles ? who.email || null : null, JSON.stringify(roles), Date.now(), ...(guard ? guard.binds : []));
}

// 페이지 내용을 통째로 되돌리는 경로(기록 복원·템플릿 적용): 동작이 있는 버튼 블록마다 되돌린 사람을 저장한 사람으로 적는다.
// 손님이 되돌리면 바뀐 동작 목록은 그 손님이 저장한 것이다. 소유자가 되돌리거나 복제하면 원래 블록(source 페이지의 같은 id)의 손님
// 기록을 그대로 잇는다(소유자가 되돌렸다고 손님 동작이 소유자 권한을 얻지 않는다). blocks/current 는 blocks 표 줄(meta 는 JSON 문자열일 수 있다).
async function buttonSavers(db, slug, blocks, current, source = slug, guard) {
  const actionsOf = (block) => {
    const meta = block && block.type === "button" ? (typeof block.meta === "string" ? parseJson(block.meta, null) : block.meta) : null;
    return meta && Array.isArray(meta.actions) && meta.actions.length ? JSON.stringify(meta.actions) : null;
  };
  const before = new Map((current || []).map((block) => [String(block.id), actionsOf(block)]));
  const out = [];
  for (const block of blocks || []) {
    if (!actionsOf(block)) continue;
    const key = blockButtonKey(slug, String(block.id));
    if (db.acardRoles) {
      if (actionsOf(block) !== before.get(String(block.id))) out.push(buttonSaverStatement(db, key, guard));
      continue;
    }
    if (source === slug) continue;
    const saver = await db.prepare("SELECT kind, session, email, roles, saved FROM db_button_savers WHERE button = ?").bind(blockButtonKey(source, String(block.id))).first();
    if (saver && saver.kind === "guest") {
      out.push(db.prepare("INSERT INTO db_button_savers (button, kind, session, email, roles, saved) SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS BIGINT) WHERE " + (guard ? guard.sql : "1 = 1") + " ON CONFLICT (button) DO UPDATE SET kind = excluded.kind, session = excluded.session, email = excluded.email, roles = excluded.roles, saved = excluded.saved")
        .bind(key, saver.kind, saver.session, saver.email, saver.roles, saver.saved, ...(guard ? guard.binds : [])));
    }
  }
  return out;
}

// 버튼을 누를 때 쓸 db: 저장한 사람이 손님이면 권한 맵 = 누른 사람(소유자면 제한 없음)과 저장한 손님 권한의 교집합.
async function buttonPressDb(db, key) {
  const saver = await db.prepare("SELECT kind, session, email, roles FROM db_button_savers WHERE button = ?").bind(key).first();
  if (!saver || saver.kind !== "guest") return { db };
  // 저장한 손님이 직접 누르면 지금 그 손님의 권한이 그대로 기준이다.
  if (db.acardRoles && db.acardSaver && db.acardSaver.session && String(db.acardSaver.session) === String(saver.session)) return { db };
  const resolved = await guestSaverRoles(db, saver);
  if (resolved.reason) {
    console.warn("acard button stopped", key, resolved.reason);
    return { error: BUTTON_STOPPED, status: 403 };
  }
  const roles = new Map();
  for (const [slug, role] of resolved.roles) {
    const mine = db.acardRoles ? db.acardRoles.get(slug) || "none" : "full";
    if (!WRITE_ROLES.includes(mine)) continue;
    roles.set(slug, WRITE_ROLES.indexOf(mine) < WRITE_ROLES.indexOf(role) ? mine : role);
  }
  return { db: rolesView(db, roles) };
}

// db 에 다른 권한 맵을 씌운 같은 저장소(손님 viewDb 와 같은 모양). visible 을 주지 않으면 db 의 것을 그대로 쓴다.
function rolesView(db, roles) {
  const view = { prepare: (sql) => db.prepare(sql), batch: (list) => db.batch(list), dialect: db.dialect, acardKey: db.acardKey, acardVisible: db.acardVisible, acardRoles: roles, acardSaver: db.acardSaver };
  if (typeof db.script === "function") view.script = (list) => db.script(list);
  return view;
}

async function buttonActionsAllowed(db, actions, principal) {
  const list = normaliseButtonActions(actions);
  if (!list) return null;
  for (const action of list) {
    if (action.type !== "create_row") continue;
    const database = await databaseBySlug(db, action.database);
    if (!database || !canEditDatabase(db, database.slug)) return null;
    if (principal && !(await narrowAgent(db, principal, database.slug)).scopes.includes("write")) return null;
  }
  return list;
}

// Agent writes (MCP create_page/update_page): a button whose target database the token may not write keeps no actions.
async function guardAgentButtons(db, principal, oldBlocks, blocks) {
  const before = new Map((oldBlocks || []).map((block) => [block.id, JSON.stringify(block.meta && block.meta.actions ? block.meta.actions : null)]));
  let dropped = 0;
  for (const block of blocks) {
    if (block.type !== "button" || !block.meta || block.meta.actions === undefined) continue;
    if (before.get(block.id) === JSON.stringify(block.meta.actions)) continue;
    const allowed = await buttonActionsAllowed(db, block.meta.actions, principal);
    const meta = Object.assign({}, block.meta);
    if (allowed && allowed.length) meta.actions = allowed; else { delete meta.actions; dropped += 1; }
    block.meta = meta;
  }
  return dropped;
}

// 저장 경로의 버튼 블록 검사: 바뀐 동작 목록만 본다(편집 손님이 페이지를 저장해도 오너가 만든 버튼은 그대로 남는다).
// 저장하는 사람이 대상 DB 를 편집할 수 없거나 모양이 틀린 동작 목록은 저장하지 않는다.
// changed(Set, 선택): 동작을 새로 저장하는 버튼 블록 id. 호출하는 저장 batch 가 저장한 사람을 기록한다(#107).
async function guardButtonBlocks(db, oldBlocks, blocks, changed) {
  const before = new Map((oldBlocks || []).map((block) => [block.id, JSON.stringify(block.meta && block.meta.actions ? block.meta.actions : null)]));
  for (const block of blocks) {
    if (block.type !== "button" || !block.meta || block.meta.actions === undefined) continue;
    if (before.get(block.id) === JSON.stringify(block.meta.actions)) continue;
    const allowed = await buttonActionsAllowed(db, block.meta.actions);
    const meta = Object.assign({}, block.meta);
    if (allowed && allowed.length) { meta.actions = allowed; if (changed) changed.add(block.id); } else delete meta.actions;
    block.meta = meta;
  }
  return blocks;
}

async function databaseBySlug(db, slug) {
  return slug ? await db.prepare("SELECT id, slug, title, icon, parent, ord, created, updated, config FROM databases WHERE slug = ?").bind(String(slug)).first() : null;
}

// ctx: { database, row } - 버튼 속성이면 그 행의 DB 와 행 id, 버튼 블록이면 둘 다 없다.
// 권한(#86): 1) 동작마다 대상 DB(관계는 상대 DB 까지) 편집 권한을 본다(없으면 403). 2) 모든 단계를 쓰기 전에 준비한다 -
// 같은 행에 대한 update_row/update_related 값은 단계 순서대로 합치고(뒤 단계가 이긴다), 행마다 preparePatchRow/prepareCreateRow
// 가 그 행과 그 행이 설정하는 관계 값이 바꿀 상대 행(끊기는 행 포함)의 쓰기 권한을 본다(없으면 401). 3) 하나라도 실패하면
// 아무것도 쓰지 않고, 모두 통과하면 모든 단계를 한 batch 로 쓴다. 그래서 일부 단계만 저장되는 일이 없다.
async function runActions(db, env, ctx, input) {
  if (!Array.isArray(input) || input.length > BUTTON_ACTION_MAX) return { error: "버튼 동작은 10개까지예요.", status: 400 };
  const actions = normaliseButtonActions(input);
  if (!actions) return { error: "버튼 동작을 읽지 못했어요.", status: 400 };
  const plan = [];
  for (const action of actions) {
    if (action.type === "confirm" || action.type === "open") { plan.push({ action }); continue; }
    if (action.type === "create_row") {
      const database = await databaseBySlug(db, action.database);
      if (!database) return { error: "없는 데이터베이스예요.", status: 404 };
      if (!canEditDatabase(db, database.slug)) return { error: "이 데이터베이스를 편집할 권한이 없어요.", status: 403 };
      plan.push({ action, database });
      continue;
    }
    if (!ctx.database || !ctx.row) return { error: "이 동작은 데이터베이스 행의 버튼에서만 쓸 수 있어요.", status: 400 };
    if (!canEditDatabase(db, ctx.database.slug)) return { error: "이 데이터베이스를 편집할 권한이 없어요.", status: 403 };
    const rowDenied = await assertCanWriteRows(db, [ctx.row], "이 행을 편집할 권한이 없어요.");
    if (rowDenied) return rowDenied;
    if (action.type === "update_row") { plan.push({ action, database: ctx.database }); continue; }
    const properties = await rowProperties(db, ctx.database);
    const relation = properties.find((prop) => prop.id === action.relation && prop.type === "relation");
    if (!relation) return { error: "없는 관계 속성이에요.", status: 400 };
    const target = await databaseBySlug(db, relation.config.database);
    if (!target) return { error: "없는 데이터베이스예요.", status: 404 };
    if (!canEditDatabase(db, target.slug)) return { error: "이 데이터베이스를 편집할 권한이 없어요.", status: 403 };
    const current = await db.prepare("SELECT props FROM db_rows WHERE id = ? AND database_id = ?").bind(ctx.row, ctx.database.id).first();
    if (!current) return { error: "없는 행이에요.", status: 404 };
    const ids = normaliseCellValue(relation, parseJson(current.props, {})[relation.id]);
    const linkedDenied = await assertCanWriteRows(db, ids);
    if (linkedDenied) return linkedDenied;
    plan.push({ action, database: target, rows: ids });
  }
  const total = plan.reduce((sum, step) => sum + (step.action.type === "update_related" ? step.rows.length : step.action.type === "update_row" || step.action.type === "create_row" ? 1 : 0), 0);
  if (total > BUTTON_ROWS_MAX) return { error: "버튼 한 번으로는 500행까지 바꿀 수 있어요.", status: 400 };
  const now = Date.now();
  const empty = { created: [], updated: 0, open: null };
  let counted = null;
  const done = await commitRowWrites(db, async () => {
    // 행마다 단계를 순서대로 모은다. 단계마다 앞 단계 결과에서 이어 준비하므로(규칙·사람 검사·관계 권한은 단계마다 본다)
    // 예전처럼 단계별로 저장했을 때와 같은 최종 상태가 되고, 쓰는 것은 그 최종 상태 하나다.
    const patches = new Map();
    const creates = [];
    let updated = 0;
    for (let index = 0; index < plan.length; index += 1) {
      const { action, database, rows } = plan[index];
      if (action.type === "create_row") { creates.push({ index, database, action }); continue; }
      if (action.type !== "update_row" && action.type !== "update_related") continue;
      const values = resolveButtonValues(action.values, ctx, now);
      for (const rowId of action.type === "update_row" ? [ctx.row] : rows) {
        const key = database.id + "\n" + rowId;
        if (!patches.has(key)) patches.set(key, { database, rowId, steps: [] });
        patches.get(key).steps.push({ index, type: action.type, values });
      }
    }
    const statements = [];
    for (const patch of patches.values()) {
      let chain = null, prepared = null, skipped = false;
      for (const step of patch.steps) {
        prepared = await preparePatchRow(db, env, patch.database, patch.rowId, step.values, chain);
        // update_related 의 지워진 상대 행은 건너뛴다(예전과 같다). 이 행 자체가 없으면 실패다.
        if (prepared.status === 404 && !patch.steps.some((entry) => entry.type === "update_row")) { skipped = true; break; }
        if (prepared.error) return { ...prepared, step: step.index };
        chain = { props: prepared.props, touched: prepared.touched };
      }
      if (skipped) continue;
      statements.push(...prepared.statements);
      updated += patch.steps.length;
    }
    const built = [];
    for (const create of creates) {
      const prepared = await prepareCreateRow(db, env, create.database, { template: create.action.template, props: resolveButtonValues(create.action.values, ctx, now) });
      if (prepared.error) return { ...prepared, step: create.index };
      built.push({ create, prepared });
    }
    // 여기까지 모든 검사를 통과했다. 이제 ID 번호를 받고 문장을 만든다.
    const offsets = new Map(), taken = new Set(), created = [];
    for (const { create, prepared } of built) {
      const offset = offsets.get(create.database.id) || 0;
      offsets.set(create.database.id, offset + 1);
      const made = await prepared.build(offset, taken);
      statements.push(...made.statements);
      created.push({ slug: create.database.slug, row: made.row.id, page: made.slug, blocks: made.blocks });
    }
    counted = { created, updated };
    return { statements };
  });
  if (done.error) return { ...empty, error: done.error, status: done.status, ...(done.step !== undefined ? { step: done.step } : {}) };
  for (const made of counted.created) await afterBlockSave(db, made.page, made.blocks);
  const result = { created: counted.created.map(({ slug, row, page }) => ({ slug, row, page })), updated: counted.updated, open: null };
  let createdSoFar = 0;
  for (const { action } of plan) {
    if (action.type === "create_row") createdSoFar += 1;
    if (action.type !== "open") continue;
    if (action.target === "url") result.open = action.url;
    else {
      const last = result.created[createdSoFar - 1];
      if (last && last.page) result.open = "/" + encodeURIComponent(last.page) + "/";
    }
  }
  return result;
}

// principal(에이전트, 선택): 페이지별 에이전트 규칙이 있으면 손님과 같은 권한 맵으로 행 페이지와 관계로 바뀌는 행까지 본다(#106).
// 그 거부는 에이전트에게 403 이다(토큰은 있고 권한이 없다).
async function dbRowRequest(db, slug, method, row, body, principal) {
  const roles = principal && ACARD_FEATURES.services.agentRoles ? await ACARD_FEATURES.services.agentRoles(db, principal) : null;
  const target = new URL("https://acard.internal" + API + "/db/" + encodeURIComponent(slug) + "/rows" + (row ? "/" + encodeURIComponent(row) : ""));
  const response = await handleApi(new Request(target, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {}, roles ? rolesView(db, roles) : db, target, false);
  const data = await response.json();
  if (!response.ok) throw new AgentError(data && data.error ? data.error : "데이터베이스를 고치지 못했어요.", roles && response.status === 401 ? 403 : response.status);
  return data;
}

function agentChallenge(request) {
  const origin = new URL(request.url).origin;
  return new Response(JSON.stringify({ error: "에이전트 토큰이 필요해요. Acard 설정 > 에이전트 연결에서 만들 수 있어요." }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource"',
    },
  });
}

async function serveAgentApi(request, env, url, givenPrincipal) {
  const db = env[DB_BINDING];
  if (!db) return json({ error: "저장소가 연결되지 않았어요." }, 503);
  try {
    await ensureSchema(db);
    await ensureAgentSchema(db);
    const found = givenPrincipal || await principalFromToken(db, bearerToken(request));
    if (!found) return agentChallenge(request);
    const target = /^\/api\/v1\/(?:pages|databases)\/([^/]+)/.exec(url.pathname);
    let targetSlug = null;
    if (target) { try { targetSlug = resolveSlug(decodeURIComponent(target[1])); } catch { targetSlug = null; } }
    const principal = await narrowAgent(db, found, targetSlug);
    await syncIfStale(db, env, request);
    for (const hook of ACARD_FEATURES.agentApi) {
      const response = await hook({ ...featureContext(request, env, db, url), principal, storeImage: (page, name, mime, bytes, source) => storeAgentImage(env, db, page, name, mime, bytes, source),
        storeVideo: (page, name, bytes) => storeAgentVideo(env, db, page, name, bytes),
        run: (operation, input) => acardHost.run(env, principal, operation, input) });
      if (response instanceof Response) return response;
    }
    return await handleAgentV1(request, db, url.pathname.slice(AGENT_API.length) || "/", principal, { ...agentHelpers(env), resolveSlug: pageRef });
  } catch (error) {
    if (error instanceof AgentError) return json({ error: error.message }, error.status);
    return serverError(error);
  }
}

// #44/#57: a busy pooler or a dropped database socket is a short wait, not a failure: 503 + Retry-After so the app and
// agents try again.
const DB_TRANSIENT = /EMAXCONN|max clients reached|too many clients|remaining connection slots|Network connection lost|CONNECTION_CLOSED|CONNECTION_ENDED|connection terminated/i;
function serverError(error) {
  const message = String(error && error.message ? error.message : error);
  if (DB_TRANSIENT.test(message)) {
    return new Response(JSON.stringify({ error: "잠시 연결이 몰렸어요. 곧 다시 시도해 주세요.", retry: true }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "2" } });
  }
  return json({ error: message }, 500);
}

// 번들 입구(gate/agent-entry.ts)가 쓰는 작은 접점. 인증은 입구가 끝낸 뒤에만 불린다.
export const acardHost = {
  get mcpTools() { return ACARD_FEATURES.services.mcpTools || []; },
  async prepare(env) {
    const db = env[DB_BINDING];
    if (!db) throw new AgentError("저장소가 연결되지 않았어요.", 503);
    await ensureSchema(db);
    await ensureAgentSchema(db);
    return db;
  },
  async principalFromToken(env, token) {
    return principalFromToken(await this.prepare(env), token);
  },
  async run(env, given, operation, input) {
    const db = await this.prepare(env);
    input = pageRefs(input);
    const value = input && (input.slug ?? input.page ?? input.database ?? input.parent);
    let slug = null;
    if (typeof value === "string" && value) { try { slug = resolveSlug(value); } catch { slug = null; } }
    const principal = await narrowAgent(db, given, slug);
    const core = Object.hasOwn(agentOps, operation);
    const op = core ? agentOps[operation] : ACARD_FEATURES.agentOps[operation];
    if (typeof op !== "function") throw new AgentError("없는 동작이에요.", 404);
    if (!core) {
      const tools = this.mcpTools.filter((tool) => tool.operation === operation);
      const scope = !tools.length || tools.some((tool) => tool.scope === "write") ? "write" : "read";
      if (!principal.scopes.includes(scope)) throw new AgentError("이 동작에 필요한 권한이 없어요.", 403);
    }
    try {
      return await op(db, principal, { ...agentHelpers(env), env, storeImage: (page, name, mime, bytes) => storeAgentImage(env, db, page, name, mime, bytes), storeVideo: (page, name, bytes) => storeAgentVideo(env, db, page, name, bytes) }, input || {});
    } catch (error) {
      throw await missingPageHint(db, error, slug);
    }
  },
  serveV1(request, env, principal) {
    return serveAgentApi(request, env, new URL(request.url), principal);
  },
  // /__recurring/tick (gate/agent-entry.ts): runs due repeating templates in the workspace this env is scoped to.
  async recurringTick(env, now) {
    const db = await this.prepare(env);
    return await runDueTemplates(db, Number.isFinite(now) ? now : Date.now());
  },
  // /__templates/migrate (gate/agent-entry.ts, #86 B10): this workspace's stored templates to the checked shape.
  async templateMigrate(env) {
    const db = await this.prepare(env);
    return await migrateTemplates(db);
  },
  async agentStep(env, session) {
    const db = await this.prepare(env);
    if (!ACARD_FEATURES.services.agentStep) return { status: 404, done: true };
    return await ACARD_FEATURES.services.agentStep(env, db, session);
  },
  async hasHumanTicket(request, env) {
    return Boolean(env.GATE_SECRET) && await hasValidTicket(request, env.GATE_SECRET);
  },
  trust(env) {
    TRUSTED_ENVS.add(env);
    return env;
  },
  async tokenAdmin(env) {
    const db = await this.prepare(env);
    return {
      list: () => listAgentTokens(db),
      create: (input) => createAgentToken(db, input),
      revoke: (id) => revokeAgentToken(db, id),
      recordGrant: (grant) => recordAgentGrant(db, grant),
      listGrants: () => listAgentGrants(db),
      markGrantRevoked: (id) => markAgentGrantRevoked(db, id),
      grantRevoked: (id) => agentGrantRevoked(db, id),
    };
  },
  isAgentError(error) {
    return error instanceof AgentError;
  },
  // Admin console test of the storage mail (gate/admin.ts POST /storage-alert-test): the real mail with "[테스트]" in the
  // subject and today's usage from the global ledger, sent once to OWNER_ALERT_EMAIL. The ledger and its alert flags are
  // only read, so the real step mails (GLOBAL_MEDIA_ALERTS) and the stop mail still go out when those are reached.
  async storageAlertTest(env) {
    const ledger = mediaLedger(env);
    const used = ledger && typeof ledger.mediaUsage === "function" ? Number((await ledger.mediaUsage(0, Infinity)).used) || 0 : 0;
    return { used, to: env.OWNER_ALERT_EMAIL || null, ...(await mailOwnerAboutStorage(env, used, false, true)) };
  },
  // Admin console 저장 공간 tab: the global ledger read without changing it, with the cap and the alert steps.
  async storageUsage(env) {
    const ledger = mediaLedger(env);
    const row = ledger && typeof ledger.mediaUsage === "function" ? await ledger.mediaUsage(0, Infinity) : { used: 0, alerted: 0 };
    // Uploads still streaming (or left by a closed tab until the sweep): their bytes are already inside `used`.
    const leases = ledger && typeof ledger.mediaSweep === "function" ? await ledger.mediaSweep().catch(() => null) : null;
    return { used: Number(row.used) || 0, alerted: Number(row.alerted) || 0, cap: GLOBAL_MEDIA_CAP, alerts: GLOBAL_MEDIA_ALERTS, uploading: leases ? { count: leases.open, bytes: leases.openBytes } : null };
  },
  challenge: (message, next, status) => challenge(message, next, status),
  escapeHtml: (text) => escapeHtml(text),
};

// Plan the whole trash group before writing: owned row pages follow their database even if moved out of its tree.
// The editor commits these statements together with every page tombstone/content deletion; KV cleanup follows commit.
async function permanentDeletePlan(db, slug) {
  const pages = new Set([slug]), databases = new Map();
  for (const member of pages) {
    if (ACARD_FEATURES.services.trashGroup) {
      for (const child of await ACARD_FEATURES.services.trashGroup(db, member)) pages.add(child);
    }
    const database = await readDatabaseBySlug(db, member);
    if (!database) continue;
    databases.set(database.id, database);
    const rows = await db.prepare("SELECT page FROM db_rows WHERE database_id = ? AND page IS NOT NULL").bind(database.id).all();
    for (const row of rows.results ?? []) pages.add(String(row.page));
  }
  const locks = [], statements = [], media = [];
  for (const database of databases.values()) {
    const rowIds = ((await db.prepare("SELECT id FROM db_rows WHERE database_id = ?").bind(database.id).all()).results ?? []).map((row) => String(row.id));
    const relations = await rowDeleteRelationStatements(db, database, rowIds);
    locks.push(...relations.locks);
    statements.push(...relations.statements);
    for (const prop of twoWayRelations(await readProperties(db, database.id))) {
      statements.push(...await disableRelationPairStatements(db, prop, false));
    }
    statements.push(
      db.prepare("DELETE FROM db_relation_links WHERE prop_id IN (SELECT id FROM db_properties WHERE database_id = ?) OR src_row IN (SELECT id FROM db_rows WHERE database_id = ?) OR dst_row IN (SELECT id FROM db_rows WHERE database_id = ?)").bind(database.id, database.id, database.id),
      db.prepare("DELETE FROM db_counters WHERE property_id IN (SELECT id FROM db_properties WHERE database_id = ?)").bind(database.id),
      db.prepare("DELETE FROM db_template_runs WHERE template_id IN (SELECT id FROM db_templates WHERE database_id = ?) OR row_id IN (SELECT id FROM db_rows WHERE database_id = ?)").bind(database.id, database.id),
      db.prepare("DELETE FROM db_template_savers WHERE template_id IN (SELECT id FROM db_templates WHERE database_id = ?)").bind(database.id),
      ...["db_rows", "db_properties", "db_views", "db_templates", "db_rules", "db_forms", "db_value_backups"].map((table) => db.prepare("DELETE FROM " + table + " WHERE database_id = ?").bind(database.id)),
      db.prepare("DELETE FROM databases WHERE id = ?").bind(database.id),
    );
  }
  for (const member of pages) {
    // A row page can also be permanently deleted on its own, without deleting the rest of its database.
    const rows = await db.prepare("SELECT id, database_id FROM db_rows WHERE page = ?").bind(member).all();
    for (const row of rows.results ?? []) {
      if (databases.has(row.database_id)) continue;
      const relations = await rowDeleteRelationStatements(db, { id: row.database_id }, [String(row.id)]);
      locks.push(...relations.locks);
      statements.push(...relations.statements,
        db.prepare("DELETE FROM db_relation_links WHERE src_row = ? OR dst_row = ?").bind(row.id, row.id),
        db.prepare("DELETE FROM db_template_runs WHERE row_id = ?").bind(row.id),
        db.prepare("DELETE FROM db_rows WHERE id = ?").bind(row.id));
    }
    media.push(...((await db.prepare("SELECT id, bytes FROM media WHERE page = ?").bind(member).all()).results ?? []));
    statements.push(
      db.prepare("DELETE FROM share_invites WHERE rule IN (SELECT id FROM share_rules WHERE page = ? AND principal != 'publish')").bind(member),
      db.prepare("DELETE FROM share_rules WHERE page = ? AND principal != 'publish'").bind(member),
      db.prepare("UPDATE share_rules SET revoked = ? WHERE page = ? AND principal = 'publish' AND revoked IS NULL").bind(Date.now(), member),
      db.prepare("DELETE FROM share_requests WHERE page = ?").bind(member),
      db.prepare("DELETE FROM share_pages WHERE page = ?").bind(member),
      db.prepare("DELETE FROM media WHERE page = ?").bind(member),
    );
  }
  return { pages: [...pages], statements: [...locks, ...statements], media, databases: databases.size };
}

async function handleApi(request, env, db, url, dispatchFeatures = true) {
  const path = url.pathname.slice(API.length) || "/";
  const method = request.method.toUpperCase();
  const permanent = method === "DELETE" && /^\/page\/([^/]+)\/permanent\/?$/.exec(path);
  // Permanent sharing cleanup belongs to the deletion batch, not the feature hook's pre-delete write.
  if (dispatchFeatures && !permanent && ACARD_FEATURES.api.length) {
    const ctx = featureContext(request, env, db, url);
    for (const hook of ACARD_FEATURES.api) {
      const response = await hook(ctx);
      if (response !== null) return response;
    }
  }
  // 휴지통 비우기 (#12): every page still in the trash goes through the same permanent delete (media, sharing included).
  if (path === "/editor/trash/empty" && method === "POST") {
    await ensureEditorSchema(db);
    const rows = await db.prepare("SELECT page FROM editor_trash WHERE permanent = 0").all();
    let deleted = 0;
    for (const row of rows.results ?? []) {
      if (!(await db.prepare("SELECT page FROM editor_trash WHERE page = ? AND permanent = 0").bind(row.page).first())) continue;
      const target = new URL(API + "/page/" + encodeURIComponent(row.page) + "/permanent", url);
      const res = await handleApi(new Request(target, { method: "DELETE" }), env, db, target, dispatchFeatures);
      if (res.ok) deleted += 1;
    }
    return json({ ok: true, deleted });
  }
  let cleanup;
  const lifecycle = await handleEditorApi(request, db, url, { json, readPage, saveBlocks, normaliseBlocks, slugify, buttonSavers, guardSyncedWrite,
    permanentDeletePlan: async (db, slug) => (cleanup = await permanentDeletePlan(db, slug)) });
  if (lifecycle && permanent && lifecycle.ok && env[MEDIA_BINDING]) {
    for (const row of cleanup.media) await env[MEDIA_BINDING].delete("media/" + row.id).then(() => releaseMedia(env, Number(row.bytes))).catch(() => {});
  }
  if (lifecycle && permanent && lifecycle.ok && cleanup.databases) await armRecurring(env, db);
  if (lifecycle) return lifecycle;

  if (path === "/sync" && method === "POST") {
    if (isMember(env)) return json({ imported: 0, updated: 0, skipped: 0, databases: { imported: 0, rows: 0, skipped: 0 } });
    const notes = await syncSeed(db, env, request);
    return json(Object.assign({}, notes, { databases: await syncDbSeed(db, env, request) }));
  }

  if (path === "/upload" && method === "POST") {
    const kind = url.searchParams.get("kind");
    if (kind === "icon" || kind === "cover") return await uploadLookImage(request, env, db, kind);
    if (url.searchParams.get("stream") === "1") return await uploadStream(request, env, db, url);
    return await uploadMedia(request, env, db);
  }

  if (path === "/media-usage" && method === "GET") {
    return await mediaUsage(env, db);
  }

  const mediaMeta = /^\/media\/([^/]+)\/meta\/?$/.exec(path);
  if (mediaMeta && method === "GET") {
    const found = await readMedia(env, mediaMeta[1]);
    if (found instanceof Response) return found;
    const size = imageDimensions(found.value);
    return json({ width: size.width, height: size.height, mime: found.metadata?.mime || "application/octet-stream" });
  }

  const mediaDelete = /^\/media\/([^/]+)\/?$/.exec(path);
  if (mediaDelete && method === "DELETE") {
    const store = env[MEDIA_BINDING];
    if (!store) return json({ error: "미디어 저장소가 연결되지 않았어요." }, 503);
    const id = mediaDelete[1];
    if (MEDIA_ID.test(id)) {
      const row = await db.prepare("SELECT bytes FROM media WHERE id = ?").bind(id).first();
      await store.delete("media/" + id);
      if (row) await releaseMedia(env, Number(row.bytes));
      await Promise.all([400, 800, 1600].map(width => store.delete("media/" + id + "@w" + width)));
      await db.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
    }
    return json({ ok: true });
  }

  const attachments = /^\/page\/([^/]+)\/attachments\/?$/.exec(path);
  if (attachments && method === "GET") {
    let slug;
    try { slug = resolveSlug(decodeURIComponent(attachments[1])); } catch { return json({ error: "주소를 읽지 못했어요." }, 400); }
    const rows = await db.prepare("SELECT id, name, mime, bytes, created FROM media WHERE page = ? ORDER BY created DESC LIMIT 500").bind(slug).all();
    return json({ attachments: (rows.results ?? []).map((r) => ({ ...r, url: "/media/" + r.id })) });
  }

  if (path === "/media/import" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const src = String(body.url || "");
    if (!/^https?:\/\//i.test(src)) return json({ error: "http(s) 이미지 주소가 필요해요." }, 400);
    const probe = [{ type: "image", text: "", meta: { src } }];
    const page = body.page ? String(body.page).slice(0, 120) : null;
    const warnings = await ingestImages(env, db, page, probe);
    if (!/^\/media\//.test(probe[0].meta.src)) return json({ error: warnings[0] ? warnings[0].error : "이미지를 가져오지 못했어요." }, 422);
    return json({ ok: true, url: probe[0].meta.src });
  }

  if (path === "/link-preview" && method === "GET") {
    return await linkPreview(db, url.searchParams.get("url"));
  }

  // 노션 "Markdown & CSV" 내보내기 zip 을 그대로 받아 페이지와 데이터베이스로 만든다.
  if (path === "/import" && method === "POST") {
    if (ACARD_FEATURES.services.importZipRequest) return await ACARD_FEATURES.services.importZipRequest(request, env, db);
    return await importZip(request, db);
  }

  // 마크다운 파일 한 장(또는 여러 장)을 페이지로 만든다. 노션 zip 이 아닌 일반 마크다운도 받는다.
  if (path === "/import/md" && method === "POST") {
    return await importMarkdown(request, db);
  }

  // 페이지 하나 또는 워크스페이스 전체를 마크다운·HTML·zip 으로 내보낸다.
  if (path === "/export" && method === "GET") {
    return await exportPage(db, url, env);
  }

  if (path === "/tree" && method === "GET") {
    return json({ pages: await readTree(db) });
  }

  if (path === "/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return json({ results: [] });
    if (ACARD_FEATURES.services.search) return json({ results: visibleOnly(db, await ACARD_FEATURES.services.search(db, q, db.acardVisible ? 400 : 40, true)).slice(0, 40) });
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    const rows = await db
      .prepare("SELECT p.slug, p.title, (SELECT text FROM blocks b WHERE b.page = p.slug AND b.text LIKE ? LIMIT 1) AS hit FROM pages p WHERE NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page=p.slug) AND (p.title LIKE ? OR EXISTS (SELECT 1 FROM blocks b WHERE b.page = p.slug AND b.text LIKE ?)) ORDER BY p.ord LIMIT 40")
      .bind(like, like, like)
      .all();
    return json({ results: visibleOnly(db, rows.results ?? []) });
  }

  if (path === "/backlinks" && method === "GET") {
    const slug = url.searchParams.get("slug") ?? "";
    const rows = await db.prepare("SELECT l.src AS slug, p.title FROM links l JOIN pages p ON p.slug = l.src WHERE l.dst = ? AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page=p.slug) ORDER BY l.src").bind(slug).all();
    return json({ backlinks: visibleOnly(db, rows.results ?? []) });
  }

  if (path === "/pages" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const title = String(body.title ?? "").trim() || "새 페이지";
    const parent = body.parent ? String(body.parent) : null;
    const kind = body.kind === "db" ? "db" : "note";
    let slug = slugify(body.slug ?? title);
    const taken = await db.prepare("SELECT slug FROM pages WHERE slug = ? UNION ALL SELECT page AS slug FROM editor_trash WHERE page = ?").bind(slug, slug).first();
    if (taken) slug = slug + "-" + Math.random().toString(36).slice(2, 6);
    const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS ?").bind(parent).first();
    const ord = Number(maxRow?.m ?? 0) + 10;
    const now = Date.now();
    await db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, ?, ?, 'editor', NULL)")
      .bind(slug, title, parent, ord, kind, now).run();
    const initial = kind === "db"
      ? []
      : [{ id: "b1", type: "paragraph", text: "", checked: false, indent: 0, meta: null }];
    await saveBlocks(db, slug, normaliseBlocks(initial));
    if (kind === "db") {
      await createDatabase(db, {
        slug,
        title,
        parent,
        icon: typeof body.icon === "string" ? body.icon : "",
        properties: Array.isArray(body.properties) && body.properties.length ? body.properties : undefined,
      });
    }
    if (db.acardVisible) db.acardVisible.add(slug);
    if (db.acardRoles) db.acardRoles.set(slug, db.acardRoles.get(parent) || "none");
    const created = await handleApi(new Request(new URL("/api/page/" + encodeURIComponent(slug), url)), env, db, new URL("/api/page/" + encodeURIComponent(slug), url), false);
    const page = await created.json();
    return json({ slug, title, parent, kind, ord, updated: page.page.updated, page });
  }

  const pageMatch = /^\/page\/(.+)$/.exec(path);
  if (pageMatch) {
    const slug = resolveSlug(decodeURIComponent(pageMatch[1]));

    if (method === "GET") {
      const [found, backlinks] = await Promise.all([readPage(db, slug), db.prepare("SELECT l.src AS slug, p.title FROM links l JOIN pages p ON p.slug = l.src WHERE l.dst = ? AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page=p.slug) ORDER BY l.src").bind(slug).all()]);
      if (!found) return json({ error: "없는 페이지예요." }, 404);
      const payload = { page: found.page, blocks: found.blocks, settings: found.settings, backlinks: visibleOnly(db, backlinks.results ?? []) };
      if (db.acardRoles) payload.access = db.acardRoles.get(slug) || "none";
      if (found.page.kind === "db") {
        const database = await db.prepare("SELECT id, slug, title, icon, parent, ord, created, updated, config FROM databases WHERE slug = ?").bind(slug).first();
        if (database) {
          const dbFound = await readDatabaseById(db, database, 0);
          payload.database = dbFound;
        }
      }
      if (found.page.kind === "db_row") {
        const row = await db.prepare("SELECT id, database_id FROM db_rows WHERE page = ?").bind(slug).first();
        if (row) {
          const database = await db.prepare("SELECT id, slug, title, icon, parent, ord, created, updated, config FROM databases WHERE id = ?").bind(row.database_id).first();
          if (database && (!db.acardVisible || db.acardVisible.has(String(database.slug)))) {
            const dbFound = await readDatabaseById(db, database, 0);
            payload.database = dbFound;
            payload.dbRow = row.id;
          }
        }
      }
      return json(payload);
    }

    if (method === "PUT") {
      if (env.ACARD_SAVE_PRINCIPAL && !(await narrowAgent(db, env.ACARD_SAVE_PRINCIPAL, slug)).scopes.includes("write")) return json({ error: "write_required" }, 403);
      if (await db.prepare("SELECT page FROM editor_trash WHERE page = ?").bind(slug).first()) return json({ error: "휴지통에 있는 페이지예요." }, 404);
      const existing = await db.prepare("SELECT slug, updated FROM pages WHERE slug = ?").bind(slug).first();
      if (!existing) return json({ error: "없는 페이지예요." }, 404);
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.blocks)) return json({ error: "블록 목록이 필요해요." }, 400);
      if (body.base_updated === undefined) {
        const raw = bearerToken(request);
        const principal = raw ? (env.ACARD_SAVE_PRINCIPAL || await principalFromToken(db, raw)) : null;
        const allowed = principal && await narrowAgent(db, principal, slug);
        if (!allowed?.scopes.includes("write")) return json({ error: "base_updated_required" }, 428);
      }
      if (body.base_updated !== undefined && (!Number.isSafeInteger(body.base_updated) || body.base_updated < 0)) return json({ error: "invalid_base_updated" }, 400);
      const conflict = async () => json({ error: "conflict", updated: (await db.prepare("SELECT updated FROM pages WHERE slug = ?").bind(slug).first())?.updated ?? null }, 409);
      if (body.base_updated !== undefined && existing.updated !== body.base_updated) return conflict();
      const now = Math.max(Date.now(), existing.updated + 1);
      const [stored, agentPage] = await Promise.all([readPage(db, slug), humanAgentPage(db, slug)]);
      guardSyncedWrite(body.blocks, slug, stored?.blocks ?? []);
      const buttons = new Set();
      const blocks = await guardButtonBlocks(db, stored ? stored.blocks : [], humanMarkSaves(stored ? stored.blocks : [], normaliseBlocks(pageStructure(body.blocks.slice(0, 2000))), now, agentPage), buttons);
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;
      const snapshot = await snapshotPage(db, slug);
      if (!snapshot || (body.base_updated !== undefined && snapshot.page.updated !== body.base_updated)) return conflict();
      const version = crypto.randomUUID();
      const guard = "EXISTS (SELECT 1 FROM editor_history WHERE id = ?)";
      const conditional = body.base_updated !== undefined;
      const statements = [db.prepare("INSERT INTO editor_history (id, page, title, created, snapshot) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE slug = ?" + (conditional ? " AND updated = ? AND hash IS ?" : "") + ") AND NOT EXISTS (SELECT 1 FROM editor_trash WHERE page = ?)")
        .bind(version, slug, snapshot.page.title, now, JSON.stringify(snapshot), slug, ...(conditional ? [body.base_updated, snapshot.page.hash] : []), slug),
        db.prepare("DELETE FROM blocks WHERE page = ? AND " + guard).bind(slug, version),
        ...blocks.map((block, index) => db.prepare("INSERT INTO blocks (page, id, ord, type, text, checked, indent, meta) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE " + guard)
          .bind(slug, block.id, index, block.type, block.text, block.checked ? 1 : 0, block.indent, block.meta ? JSON.stringify(block.meta) : null, version)),
        db.prepare("DELETE FROM links WHERE src = ? AND " + guard).bind(slug, version),
        ...linksOf(blocks).map(dst => db.prepare("INSERT OR IGNORE INTO links (src, dst) SELECT ?, ? WHERE " + guard).bind(slug, dst, version)),
        db.prepare("UPDATE pages SET title = ?, updated = ?, source = 'editor', hash = NULL WHERE slug = ? AND " + guard).bind(title || snapshot.page.title, now, slug, version),
        ...[...buttons].map((id) => buttonSaverStatement(db, blockButtonKey(slug, id), { sql: guard, binds: [version] })),
      ];
      const saved = await db.batch(statements);
      if (!Number(saved[0]?.meta?.changes)) return conflict();
      const page = { ...snapshot.page, title: title || snapshot.page.title, updated: now, source: "editor", hash: null };
      for (const hook of ACARD_FEATURES.afterSave) {
        try { await hook(db, slug, blocks, page); }
        catch (error) { console.error("Feature afterSave failed", error); }
      }
      if (title) await syncPageTitleToRow(db, slug, title);
      return json({ ok: true, updated: now, blocks: blocks.length });
    }

    if (method === "DELETE") {
      const trashUrl = new URL("/api/page/" + encodeURIComponent(slug) + "/trash", url);
      return handleEditorApi(new Request(trashUrl, { method: "POST" }), db, trashUrl, { json, slugify });
    }

    const action = /^\/page\/(.+?)\/(rename|move)$/.exec(path);
    if (action && method === "POST") {
      const target = resolveSlug(decodeURIComponent(action[1]));
      if (!(await readPage(db, target))) return json({ error: "없는 페이지예요." }, 404);
      const body = await request.json().catch(() => ({}));
      if (action[2] === "rename") {
        const title = String(body.title ?? "").trim();
        if (!title) return json({ error: "제목이 비었어요." }, 400);
        await captureEditorVersion(db, target);
        await db.prepare("UPDATE pages SET title = ?, updated = ?, source = 'editor' WHERE slug = ?").bind(title.slice(0, 200), Date.now(), target).run();
        await syncPageTitleToRow(db, target, title);
        return json({ ok: true });
      }
      const parent = body.parent ? String(body.parent) : null;
      if (parent === target) return json({ error: "자기 아래로는 옮길 수 없어요." }, 400);
      for (let up = parent, seen = new Set(); up; ) {
        if (up === target || seen.has(up)) return json({ error: "자기 하위 페이지 안으로는 옮길 수 없어요." }, 400);
        seen.add(up);
        up = (await db.prepare("SELECT parent FROM pages WHERE slug = ?").bind(up).first())?.parent ?? null;
      }
      if (ACARD_FEATURES.services.shareMoveCheck) {
        const warning = await ACARD_FEATURES.services.shareMoveCheck(db, target, parent, body.confirmShare === true);
        if (warning) return warning;
      }
      const ord = Number.isFinite(body.ord) ? Math.trunc(body.ord) : Date.now() % 100000;
      await captureEditorVersion(db, target);
      await db.prepare("UPDATE pages SET parent = ?, ord = ?, updated = ?, source = 'editor' WHERE slug = ?").bind(parent, ord, Date.now(), target).run();
      return json({ ok: true });
    }
  }

  if (path === "/db" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const created = await createDatabase(db, body);
    if (body.page) {
      const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS ?").bind(body.parent ? String(body.parent) : null).first();
      const now = Date.now();
      await db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, 'db', ?, 'editor', NULL) ON CONFLICT(slug) DO NOTHING")
        .bind(created.slug, created.title, created.parent, Number(maxRow && maxRow.m ? maxRow.m : 0) + 10, now).run();
    }
    return json(created);
  }

  if (path === "/db/list" && method === "GET") {
    const rows = await db.prepare("SELECT slug, title, icon FROM databases ORDER BY title").all();
    return json({ databases: visibleOnly(db, rows.results ?? []) });
  }

  const dbMatch = /^\/db\/([^/]+)(?:\/.*)?$/.exec(path);
  if (dbMatch) {
    const slug = decodeURIComponent(dbMatch[1]);
    const database = await db.prepare("SELECT id, slug, title, icon, parent, ord, created, updated, config FROM databases WHERE slug = ?").bind(slug).first();
    if (!database) return json({ error: "없는 데이터베이스예요." }, 404);

    if (method === "GET" && path === "/db/" + dbMatch[1]) {
      const found = await readDatabaseById(db, database, 0);
      return json(databasePayload(found));
    }

    if (method === "PATCH" && path === "/db/" + dbMatch[1]) {
      const body = await request.json().catch(() => ({}));
      const fields = [];
      const binds = [];
      if (typeof body.title === "string") { fields.push("title = ?"); binds.push(body.title.trim().slice(0, 200) || "제목 없음"); }
      if (typeof body.icon === "string") { fields.push("icon = ?"); binds.push(body.icon.slice(0, 8)); }
      if (body.parent !== undefined) { fields.push("parent = ?"); binds.push(body.parent ? String(body.parent) : null); }
      if (body.subitems === true || body.subitems === false) {
        const switched = await switchSubitems(db, database, body.subitems);
        if (switched.error) return json({ error: switched.error }, switched.status);
        if (!fields.length) return json({ ok: true, config: switched.config });
      }
      if (body.config !== undefined && body.subitems === undefined) { fields.push("config = ?"); binds.push(JSON.stringify(normaliseDatabaseConfig(body.config))); }
      if (!fields.length) return json({ error: "바꿀 것이 없어요." }, 400);
      fields.push("updated = ?");
      binds.push(Date.now(), database.id);
      await db.prepare("UPDATE databases SET " + fields.join(", ") + " WHERE id = ?").bind(...binds).run();
      if (typeof body.title === "string") await db.prepare("UPDATE pages SET title = ?, updated = ? WHERE slug = ? AND kind = 'db'").bind(body.title.trim().slice(0, 200) || "제목 없음", Date.now(), database.slug).run();
      return json({ ok: true });
    }

    if (method === "DELETE" && path === "/db/" + dbMatch[1]) {
      const allRows = ((await db.prepare("SELECT id FROM db_rows WHERE database_id = ?").bind(database.id).all()).results ?? []).map((row) => String(row.id));
      // #86: 편집할 수 없는 행(이 DB 의 비공개 행, 양방향으로 이어진 다른 DB 의 행)이 있으면 데이터베이스를 지우지 않는다.
      if (db.acardRoles && allRows.length) {
        const message = "편집할 수 없는 행이 있어서 데이터베이스를 지울 수 없어요.";
        const linked = [];
        for (const part of idChunks(allRows, 45)) {
          const marks = part.map(() => "?").join(", ");
          linked.push(...((await db.prepare("SELECT dst_row AS id FROM db_relation_links WHERE src_row IN (" + marks + ") UNION SELECT src_row AS id FROM db_relation_links WHERE dst_row IN (" + marks + ")").bind(...part, ...part).all()).results ?? []).map((row) => String(row.id)));
        }
        const denied = await assertCanWriteAllRows(db, database.id, message) || await assertCanWriteRows(db, linked, message);
        if (denied) return json({ error: denied.error }, denied.status);
      }
      const relations = await rowDeleteRelationStatements(db, database, allRows);
      const ownPairs = await relationPairs(db, await readProperties(db, database.id));
      await db.batch([
        ...relations.locks,
        ...relations.statements,
        ...ownPairs.filter((pair) => pair.target.id !== database.id).map((pair) => db.prepare("UPDATE db_properties SET config = ? WHERE id = ?")
          .bind(JSON.stringify(Object.assign({}, normaliseConfig("relation", { database: database.slug }), { synced: false, pair: "" })), pair.pairId)),
        db.prepare("DELETE FROM db_relation_links WHERE prop_id IN (SELECT id FROM db_properties WHERE database_id = ?)").bind(database.id),
        db.prepare("DELETE FROM blocks WHERE page IN (SELECT page FROM db_rows WHERE database_id = ? AND page IS NOT NULL)").bind(database.id),
        db.prepare("DELETE FROM links WHERE src IN (SELECT page FROM db_rows WHERE database_id = ? AND page IS NOT NULL)").bind(database.id),
        db.prepare("DELETE FROM pages WHERE kind = 'db_row' AND slug IN (SELECT page FROM db_rows WHERE database_id = ? AND page IS NOT NULL)").bind(database.id),
        db.prepare("DELETE FROM db_rows WHERE database_id = ?").bind(database.id),
        db.prepare("DELETE FROM db_counters WHERE property_id IN (SELECT id FROM db_properties WHERE database_id = ?)").bind(database.id),
        db.prepare("DELETE FROM db_properties WHERE database_id = ?").bind(database.id),
        db.prepare("DELETE FROM db_views WHERE database_id = ?").bind(database.id),
        db.prepare("DELETE FROM db_template_savers WHERE template_id IN (SELECT id FROM db_templates WHERE database_id = ?)").bind(database.id),
        db.prepare("DELETE FROM db_templates WHERE database_id = ?").bind(database.id),
        db.prepare("DELETE FROM db_value_backups WHERE database_id = ?").bind(database.id),
        db.prepare("DELETE FROM databases WHERE id = ?").bind(database.id),
      ]);
      await armRecurring(env, db);
      return json({ ok: true });
    }

    const rest = path.slice(("/db/" + dbMatch[1]).length);
    if (method === "GET" && rest === "/people") return json(await personCandidates(db, env, database));
    const sub = /^\/(properties|rows|views|templates)(?:\/([^/]+))?$/.exec(rest);
    if (!sub) return json({ error: "없는 API예요." }, 404);
    const kind = sub[1];
    const target = sub[2] ? decodeURIComponent(sub[2]) : null;
    const ordering = target === "order" && method === "POST";
    const body = method === "GET" ? {} : await request.json().catch(() => ({}));

    if (kind === "properties") {
      const propRows = await db.prepare("SELECT id, name, type, config, ord, width, hidden FROM db_properties WHERE database_id = ? ORDER BY ord, name").bind(database.id).all();
      const properties = (propRows.results ?? []).map((row, index) => normaliseProperty({
        id: row.id, name: row.name, type: row.type, config: parseJson(row.config, {}), ord: row.ord, width: row.width, hidden: row.hidden === 1,
      }, index));

      if (!target && method === "POST") {
        const prop = normaliseProperty(Object.assign({}, body, { id: scopedId(database.id, typeof body.id === "string" && body.id ? body.id : dbId("p")) }), properties.length);
        if (prop.type === "button" && prop.config.actions.length) {
          const allowed = await buttonActionsAllowed(db, prop.config.actions);
          if (!allowed) return json({ error: "버튼 동작을 저장할 수 없어요. 대상 데이터베이스를 편집할 권한을 확인해 주세요." }, 403);
          prop.config.actions = allowed;
        }
        const numberDenied = prop.type === "unique_id" ? await assertCanWriteAllRows(db, database.id, "편집할 수 없는 행이 있어서 번호를 붙일 수 없어요.") : null;
        if (numberDenied) return json({ error: numberDenied.error }, numberDenied.status);
        prop.ord = Number.isFinite(body.ord) ? Math.trunc(body.ord) : (properties.length ? Math.max(...properties.map((entry) => entry.ord)) + 10 : 10);
        if (await db.prepare("SELECT 1 AS x FROM db_properties WHERE id = ?").bind(prop.id).first()) prop.id = scopedId(database.id, dbId("p"));
        // #86 B11: 행이나 템플릿에 이 id 의 값이 아직 남아 있으면(예전 빌드에서 지운 속성) 그 값을 이어받지 않게 새 id 를 쓴다.
        const leftover = '%"' + prop.id + '":%';
        if (await db.prepare("SELECT 1 AS x FROM db_rows WHERE database_id = ? AND props LIKE ? UNION ALL SELECT 1 AS x FROM db_templates WHERE database_id = ? AND props LIKE ?").bind(database.id, leftover, database.id, leftover).first()) prop.id = scopedId(database.id, dbId("p"));
        if (prop.type === "relation") prop.config = Object.assign({}, prop.config, { pair: "" });
        if (prop.type === "relation" && prop.config.synced) {
          const pairTarget = await readDatabaseBySlug(db, prop.config.database);
          if (!pairTarget) return json({ error: "연결할 데이터베이스를 찾지 못했어요." }, 400);
          // #86: 양방향 속성은 두 DB 의 모든 행 값을 다시 쓴다. 속성을 넣기 전에 본다(enableRelationPair 도 다시 본다).
          if (!canWriteSlug(db, pairTarget.slug)) return json({ error: "상대 데이터베이스를 편집할 권한이 없어요." }, 401);
          const message = "편집할 수 없는 행이 있어서 양방향으로 바꿀 수 없어요.";
          const pairDenied = await assertCanWriteAllRows(db, database.id, message) || await assertCanWriteAllRows(db, pairTarget.id, message);
          if (pairDenied) return json({ error: pairDenied.error }, pairDenied.status);
        }
        await db.batch([
          db.prepare("INSERT INTO db_properties (id, database_id, name, type, config, ord, width, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(prop.id, database.id, prop.name, prop.type, JSON.stringify(prop.config), prop.ord, prop.width, prop.hidden ? 1 : 0),
          // #107: 누가 이 버튼 동작을 저장했는지(누를 때 그 사람 권한을 넘지 않는다).
          ...(prop.type === "button" && prop.config.actions.length ? [buttonSaverStatement(db, propButtonKey(prop.id))] : []),
        ]);
        if (prop.type === "unique_id") await ensureUniqueIds(db, database.id, prop.id, false);
        if (prop.type === "relation" && prop.config.synced) {
          const draft = Object.assign({}, prop, { config: Object.assign({}, prop.config, { synced: false, pair: "" }) });
          const enabled = await enableRelationPair(db, database, draft, Object.assign({}, prop), { pairName: body.pairName, pairLimit: body.pairLimit });
          if (enabled.error) {
            await db.prepare("DELETE FROM db_properties WHERE id = ?").bind(prop.id).run();
            return json({ error: enabled.error }, enabled.status);
          }
          return json({ property: enabled.property, pair: enabled.pair });
        }
        return json({ property: prop });
      }

      if (target && method === "PATCH") {
        const current = properties.find((entry) => entry.id === target);
        if (!current) return json({ error: "없는 속성이에요." }, 404);
        const next = normaliseProperty({
          id: current.id,
          name: typeof body.name === "string" ? body.name : current.name,
          type: typeof body.type === "string" ? body.type : current.type,
          config: body.config !== undefined ? body.config : current.config,
          ord: Number.isFinite(body.ord) ? body.ord : current.ord,
          width: Number.isFinite(body.width) ? body.width : current.width,
          hidden: body.hidden !== undefined ? body.hidden === true : current.hidden,
        }, 0);
        const newActions = next.type === "button" && next.config.actions.length && JSON.stringify(next.config.actions) !== JSON.stringify(current.type === "button" ? current.config.actions : []);
        if (newActions) {
          const allowed = await buttonActionsAllowed(db, next.config.actions);
          if (!allowed) return json({ error: "버튼 동작을 저장할 수 없어요. 대상 데이터베이스를 편집할 권한을 확인해 주세요." }, 403);
          next.config.actions = allowed;
        }
        const wasSynced = current.type === "relation" && current.config.synced && !!current.config.pair;
        // #86: 관계가 아니던 값은 링크로 바꾸지 않고 따로 남긴다(relationConversionStatements). unlinked = 그렇게 남긴 값 수.
        const conversion = next.type === "relation" && current.type !== "relation" ? await relationConversionStatements(db, database, current) : { statements: [], count: 0 };
        if (next.type === "relation") {
          // pair 는 서버가 정한다: 켜 둔 동안은 지금 짝을 유지하고, 꺼져 있으면 비운다.
          next.config = Object.assign({}, next.config, { pair: wasSynced ? current.config.pair : "" });
          if (wasSynced && next.config.synced && next.config.database !== current.config.database) {
            return json({ error: "양방향 관계는 연결 데이터베이스를 바꿀 수 없어요. 상대 DB 표시를 끄고 바꿔 주세요." }, 400);
          }
          if (!wasSynced && next.config.synced) {
            const enabled = await enableRelationPair(db, database, current, next, { pairName: body.pairName, pairLimit: body.pairLimit, before: conversion.statements, fresh: current.type !== "relation" });
            if (enabled.error) return json({ error: enabled.error }, enabled.status);
            return json({ property: enabled.property, pair: enabled.pair, unlinked: conversion.count });
          }
        }
        const turnsOff = wasSynced && (next.type !== "relation" || !next.config.synced);
        // #86: 양방향 끄기는 상대 DB 의 짝 속성을 바꾸고, 타입 바꾸기는 이 DB 의 모든 행을 다시 쓴다.
        if (turnsOff && !canEditDatabase(db, current.config.database)) return json({ error: "상대 데이터베이스를 편집할 권한이 없어요." }, 401);
        // #107: 양방향을 끄면 양쪽 행의 연결이 모두 끊긴다. 연결된 행을 모두 편집할 수 있어야 한다.
        const unlinkDenied = turnsOff ? await assertCanWriteLinkedRows(db, current, "편집할 수 없는 행이 연결돼 있어서 양방향을 끌 수 없어요.") : null;
        if (unlinkDenied) return json({ error: unlinkDenied.error }, unlinkDenied.status);
        // #86: dropPair 는 상대 DB 의 짝 속성을 지워 그 DB 모든 행에서 값이 사라진다.
        if (turnsOff && body.dropPair === true) {
          const pairDb = await readDatabaseBySlug(db, current.config.database);
          const dropDenied = pairDb ? await assertCanWriteAllRows(db, pairDb.id, "편집할 수 없는 행이 있어서 속성을 지울 수 없어요.") : null;
          if (dropDenied) return json({ error: dropDenied.error }, dropDenied.status);
        }
        const typeDenied = next.type !== current.type ? await assertCanWriteAllRows(db, database.id, "편집할 수 없는 행이 있어서 속성 타입을 바꿀 수 없어요.") : null;
        if (typeDenied) return json({ error: typeDenied.error }, typeDenied.status);
        if (turnsOff && next.type === "relation") next.config = Object.assign({}, next.config, { synced: false, pair: "" });
        await db.batch([
          ...(turnsOff ? await disableRelationPairStatements(db, current, body.dropPair === true) : []),
          ...conversion.statements,
          db.prepare("UPDATE db_properties SET name = ?, type = ?, config = ?, ord = ?, width = ?, hidden = ? WHERE id = ?")
            .bind(next.name, next.type, JSON.stringify(next.config), next.ord, next.width, next.hidden ? 1 : 0, current.id),
          ...(newActions ? [buttonSaverStatement(db, propButtonKey(current.id))] : []),
        ]);
        if (next.type !== current.type) {
          const rows = await db.prepare("SELECT id, props FROM db_rows WHERE database_id = ?").bind(database.id).all();
          const list = properties.map((entry) => (entry.id === current.id ? next : entry));
          const statements = [];
          for (const row of rows.results ?? []) {
            const parsed = normaliseRow({ id: row.id, props: parseJson(row.props, {}) }, list, 0);
            statements.push(db.prepare("UPDATE db_rows SET props = ?, updated = ? WHERE id = ?").bind(JSON.stringify(parsed.props), Date.now(), row.id));
          }
          if (statements.length) await db.batch(statements);
          if (current.type === "unique_id") await db.prepare("DELETE FROM db_counters WHERE property_id = ?").bind(current.id).run();
          if (next.type === "unique_id") {
            await db.prepare("DELETE FROM db_counters WHERE property_id = ?").bind(current.id).run();
            await ensureUniqueIds(db, database.id, current.id, true);
          }
        }
        return json(next.type === "relation" && current.type !== "relation" ? { property: next, unlinked: conversion.count } : { property: next });
      }

      if (target && method === "DELETE") {
        if (properties.length <= 1) return json({ error: "마지막 속성은 지울 수 없어요." }, 400);
        const removing = properties.find((entry) => entry.id === target);
        const pairedRemoval = removing && removing.type === "relation" && removing.config.synced && removing.config.pair;
        if (pairedRemoval && !canEditDatabase(db, removing.config.database)) return json({ error: "상대 데이터베이스를 편집할 권한이 없어요." }, 401);
        // #107: 양방향 속성을 지우면 상대 DB 행의 연결도 끊긴다.
        const pairedDenied = pairedRemoval ? await assertCanWriteLinkedRows(db, removing, "편집할 수 없는 행이 연결돼 있어서 속성을 지울 수 없어요.") : null;
        if (pairedDenied) return json({ error: pairedDenied.error }, pairedDenied.status);
        // #86: 속성을 지우면 모든 행에서 그 값이 사라진다(양방향이면 상대 DB 행의 연결도).
        const removeDenied = removing ? await assertCanWriteAllRows(db, database.id, "편집할 수 없는 행이 있어서 속성을 지울 수 없어요.") : null;
        if (removeDenied) return json({ error: removeDenied.error }, removeDenied.status);
        const pairStatements = pairedRemoval ? await disableRelationPairStatements(db, removing, false) : [];
        // #86 B11: 지운 속성의 행 셀·템플릿 값은 db_value_backups 로 옮기고 비운다(같은 id 로 다시 만들어도 값이 따라오지 않는다).
        const leftovers = removing ? await relationConversionStatements(db, database, removing, "delete") : { statements: [] };
        await db.batch([
          ...pairStatements,
          ...leftovers.statements,
          db.prepare("DELETE FROM db_counters WHERE property_id IN (SELECT id FROM db_properties WHERE id = ? AND database_id = ?)").bind(target, database.id),
          db.prepare("DELETE FROM db_properties WHERE id = ? AND database_id = ?").bind(target, database.id),
        ]);
        return json({ ok: true });
      }

      if (ordering) {
        const order = Array.isArray(body.order) ? body.order : [];
        const statements = order.map((id, index) => db.prepare("UPDATE db_properties SET ord = ? WHERE id = ? AND database_id = ?").bind((index + 1) * 10, String(id), database.id));
        if (statements.length) await db.batch(statements);
        return json({ ok: true });
      }
      return json({ error: "없는 API예요." }, 404);
    }

    if (kind === "rows") {
      if (!target && method === "POST") {
        const made = await createRow(db, env, database, body);
        return made.error ? json({ error: made.error }, made.status) : json({ row: made.row });
      }

      if (target && method === "PATCH") {
        const patched = await patchRow(db, env, database, target, body.props && typeof body.props === "object" ? body.props : null);
        if (patched.error) return json({ error: patched.error }, patched.status);
        if (Number.isFinite(body.ord)) await db.prepare("UPDATE db_rows SET ord = ? WHERE id = ?").bind(Math.trunc(body.ord), target).run();
        return json({ ok: true });
      }

      if (target && method === "DELETE") {
        const deleted = await deleteRowsWithRelations(db, database, [target]);
        if (deleted?.error) return json({ error: deleted.error }, deleted.status);
        return json({ ok: true });
      }
      return json({ error: "없는 API예요." }, 404);
    }

    if (kind === "views") {
      if (!target && method === "POST") {
        const view = normaliseView(Object.assign({}, body, { id: scopedId(database.id, typeof body.id === "string" && body.id ? body.id : dbId("v")) }), 0);
        if (await db.prepare("SELECT 1 AS x FROM db_views WHERE id = ?").bind(view.id).first()) view.id = scopedId(database.id, dbId("v"));
        const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM db_views WHERE database_id = ?").bind(database.id).first();
        view.ord = Number(maxRow && maxRow.m ? maxRow.m : 0) + 10;
        await db.prepare("INSERT INTO db_views (id, database_id, name, type, config, ord) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(view.id, database.id, view.name, view.type, JSON.stringify(view.config), view.ord).run();
        return json({ view });
      }
      if (target && method === "PATCH") {
        const current = await db.prepare("SELECT id, name, type, config, ord FROM db_views WHERE id = ? AND database_id = ?").bind(target, database.id).first();
        if (!current) return json({ error: "없는 뷰예요." }, 404);
        const next = normaliseView({
          id: current.id,
          name: typeof body.name === "string" ? body.name : current.name,
          type: typeof body.type === "string" ? body.type : current.type,
          config: body.config !== undefined ? body.config : parseJson(current.config, {}),
          ord: Number.isFinite(body.ord) ? body.ord : current.ord,
        }, 0);
        await db.prepare("UPDATE db_views SET name = ?, type = ?, config = ?, ord = ? WHERE id = ?")
          .bind(next.name, next.type, JSON.stringify(next.config), next.ord, current.id).run();
        return json({ view: next });
      }
      if (target && method === "DELETE") {
        const count = await db.prepare("SELECT COUNT(*) AS c FROM db_views WHERE database_id = ?").bind(database.id).first();
        if (count && Number(count.c) <= 1) return json({ error: "마지막 뷰는 지울 수 없어요." }, 400);
        await db.prepare("DELETE FROM db_views WHERE id = ? AND database_id = ?").bind(target, database.id).run();
        return json({ ok: true });
      }
      return json({ error: "없는 API예요." }, 404);
    }

    if (kind === "templates") {
      if (!target && method === "POST") {
        const template = normaliseTemplate(Object.assign({}, body, { id: scopedId(database.id, typeof body.id === "string" && body.id ? body.id : dbId("t")) }), 0);
        const canonical = await canonicalTemplateProps(db, database, template.props);
        if (canonical.error) return json({ error: canonical.error }, canonical.status);
        template.props = canonical.props;
        const templateDenied = await templateRelationsDenied(db, database, template.props);
        if (templateDenied) return json({ error: templateDenied.error }, templateDenied.status);
        if (await db.prepare("SELECT 1 AS x FROM db_templates WHERE id = ?").bind(template.id).first()) template.id = scopedId(database.id, dbId("t"));
        const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM db_templates WHERE database_id = ?").bind(database.id).first();
        template.ord = Number(maxRow && maxRow.m ? maxRow.m : 0) + 10;
        await db.batch([
          db.prepare("INSERT INTO db_templates (id, database_id, name, icon, props, blocks, ord) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(template.id, database.id, template.name, template.icon, JSON.stringify(template.props), JSON.stringify(template.blocks), template.ord),
          // #86: 이 값을 검사받은 사람이 저장한 사람이다(나중에 링크를 만들 때 이 사람 권한으로 다시 본다).
          templateSaverStatement(db, template.id),
        ]);
        return json({ template: Object.assign(template, { blocked: null }) });
      }
      if (target && method === "PATCH") {
        const current = await db.prepare("SELECT id, name, icon, props, blocks, ord, recurrence FROM db_templates WHERE id = ? AND database_id = ?").bind(target, database.id).first();
        if (!current) return json({ error: "없는 템플릿이에요." }, 404);
        const now = Date.now();
        let recurrence = parseJson(current.recurrence, null);
        if (body.recurrence !== undefined) {
          recurrence = normaliseRecurrence(body.recurrence);
          if (recurrence) {
            recurrence.anchor = recurrence.anchor ?? now;
            recurrence.next_run = nextRun(recurrence, now);
          }
        }
        const next = normaliseTemplate({
          id: current.id,
          name: typeof body.name === "string" ? body.name : current.name,
          icon: typeof body.icon === "string" ? body.icon : current.icon,
          props: body.props && typeof body.props === "object" ? body.props : parseJson(current.props, {}),
          blocks: Array.isArray(body.blocks) ? body.blocks : parseJson(current.blocks, []),
          ord: current.ord,
          recurrence,
        }, 0);
        // #86: 반복이 있는 템플릿은 나중에 소유자 권한(runDueTemplates)으로 이 값을 쓴다. 저장될 템플릿에 반복이 있으면
        // 무엇을 바꾸든(반복만 켜도) 저장될 값 그대로 지금 이 요청의 권한으로 본다.
        // 새 값(body.props)은 엄격하게, 이미 저장된 값(예전 이름 키 템플릿 포함)은 맞는 속성·행만 남겨 같은 형태로 바꾼다.
        const canonical = await canonicalTemplateProps(db, database, next.props, { lenient: !(body.props && typeof body.props === "object") });
        if (canonical.error) return json({ error: canonical.error }, canonical.status);
        next.props = canonical.props;
        const wrote = !!(body.props && typeof body.props === "object");
        const templateDenied = wrote || next.recurrence ? await templateRelationsDenied(db, database, next.props) : null;
        if (templateDenied) return json({ error: templateDenied.error }, templateDenied.status);
        // #86: 값을 쓴 요청만 저장한 사람이 된다. 반복만 바꾸면 저장한 사람은 그대로이고 멈춤만 풀려, 다음 실행 때 그 사람 권한으로
        // 다시 본다(여전히 안 되면 다시 멈춘다). 그래서 소유자가 반복을 켜도 손님이 넣은 값이 소유자 권한을 얻지 않는다.
        await db.batch([
          db.prepare("UPDATE db_templates SET name = ?, icon = ?, props = ?, blocks = ?, recurrence = ? WHERE id = ?")
            .bind(next.name, next.icon, JSON.stringify(next.props), JSON.stringify(next.blocks), next.recurrence ? JSON.stringify(next.recurrence) : null, current.id),
          wrote ? templateSaverStatement(db, current.id) : db.prepare("UPDATE db_template_savers SET blocked = NULL, blocked_at = NULL WHERE template_id = ?").bind(current.id),
        ]);
        await armRecurring(env, db);
        const saver = await db.prepare("SELECT blocked FROM db_template_savers WHERE template_id = ?").bind(current.id).first();
        return json({ template: Object.assign(next, { blocked: saver && saver.blocked ? String(saver.blocked) : null }) });
      }
      if (target && method === "DELETE") {
        await db.batch([
          db.prepare("DELETE FROM db_template_savers WHERE template_id IN (SELECT id FROM db_templates WHERE id = ? AND database_id = ?)").bind(target, database.id),
          db.prepare("DELETE FROM db_templates WHERE id = ? AND database_id = ?").bind(target, database.id),
        ]);
        await armRecurring(env, db);
        return json({ ok: true });
      }
      return json({ error: "없는 API예요." }, 404);
    }
  }

  return json({ error: "없는 API예요." }, 404);
}
