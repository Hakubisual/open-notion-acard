// 에이전트 연결 (acard-agents 레인).
// 사람은 게이트 쿠키로, 에이전트는 이 파일의 토큰(또는 OAuth 토큰)으로 들어온다. 두 길은 섞이지 않는다.
// 워커가 인증을 끝낸 뒤 principal 을 넘긴다. 이 모듈은 저장소 일만 하고, 블록 변환 같은 공용 코드는 helpers 로 받는다.

const AGENT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'read', created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER)",
  "CREATE TABLE IF NOT EXISTS agent_activity (id TEXT PRIMARY KEY, page TEXT NOT NULL, agent TEXT NOT NULL, via TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS agent_activity_page ON agent_activity(page, created)",
  "CREATE TABLE IF NOT EXISTS page_tags (page TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (page, tag))",
  "CREATE TABLE IF NOT EXISTS agent_grants (id TEXT PRIMARY KEY, client_name TEXT NOT NULL, scopes TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER)",
];

// OAuth 연결 목록은 D1 에 둔다. KV 목록은 늦게 보여서 방금 연결한 앱을 설정에서 끊을 수 없었다.
export async function recordAgentGrant(db, grant) {
  await db.prepare("INSERT OR REPLACE INTO agent_grants (id, client_name, scopes, created, revoked) VALUES (?, ?, ?, ?, NULL)")
    .bind(String(grant.id), String(grant.clientName).slice(0, 60), grant.scopes.join(" "), Date.now()).run();
}

export async function listAgentGrants(db) {
  const rows = await db.prepare("SELECT id, client_name, scopes, created FROM agent_grants WHERE revoked IS NULL ORDER BY created DESC").all();
  return (rows.results ?? []).map((row) => ({ id: row.id, clientName: row.client_name, scopes: String(row.scopes).split(" ").filter(Boolean), created: row.created }));
}

export async function agentGrantRevoked(db, id) {
  const row = await db.prepare("SELECT revoked FROM agent_grants WHERE id = ?").bind(String(id)).first();
  return Boolean(row && row.revoked);
}

export async function markAgentGrantRevoked(db, id) {
  await db.prepare("UPDATE agent_grants SET revoked = ? WHERE id = ? AND revoked IS NULL").bind(Date.now(), String(id)).run();
}

export const AGENT_SCOPES = ["read", "write"];
const TOKEN_PREFIX = "acard_";
const NAME_MAX = 60;
const MARKDOWN_MAX = 400_000;
const LONG_BODY = "본문이 너무 길어요. 한 번에 400,000자까지 쓸 수 있어요. 첫 섹션들로 페이지를 만들고 나머지는 append_to_page 로 ## 제목 단위 30~50KB씩 나눠 붙이거나, 큰 섹션은 하위 페이지(create_page 에 parent)로 쓰세요.";

// Remembered per store key: every reader page load and every live re-read of an open page asks for this, and a
// member workspace's store answers one request at a time, so re-sending the CREATE list each time delayed them (#17).
const agentSchemaReady = new Set();
export async function ensureAgentSchema(db) {
  if (db.acardKey && agentSchemaReady.has(db.acardKey)) return;
  await db.batch(AGENT_SCHEMA.map((sql) => db.prepare(sql)));
  if (db.acardKey) agentSchemaReady.add(db.acardKey);
}

export class AgentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return TOKEN_PREFIX + btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseScopes(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  const scopes = [...new Set(list.filter((scope) => AGENT_SCOPES.includes(scope)))];
  if (scopes.includes("write") && !scopes.includes("read")) scopes.unshift("read");
  return scopes;
}

export async function createAgentToken(db, input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > NAME_MAX) throw new AgentError("이름을 1~60자로 적어 주세요.");
  const scopes = parseScopes(input?.scopes ?? "read");
  if (!scopes.length) throw new AgentError("권한을 골라 주세요.");
  const token = randomToken();
  const row = { id: crypto.randomUUID(), name, prefix: token.slice(0, 12), hash: await sha256Hex(token), scopes: scopes.join(" "), created: Date.now() };
  await db.prepare("INSERT INTO agent_tokens (id, name, prefix, hash, scopes, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.name, row.prefix, row.hash, row.scopes, row.created).run();
  // 원문 토큰은 이 응답에서 한 번만 돌려준다. 저장소에는 해시만 남는다.
  return { token, record: publicToken(row) };
}

function publicToken(row) {
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: String(row.scopes).split(" "), created: row.created, lastUsed: row.last_used ?? null, revoked: row.revoked ?? null };
}

export async function listAgentTokens(db) {
  const rows = await db.prepare("SELECT id, name, prefix, scopes, created, last_used, revoked FROM agent_tokens ORDER BY created DESC").all();
  return (rows.results ?? []).map(publicToken);
}

export async function revokeAgentToken(db, id) {
  const result = await db.prepare("UPDATE agent_tokens SET revoked = ? WHERE id = ? AND revoked IS NULL").bind(Date.now(), String(id)).run();
  return Number(result?.meta?.changes ?? 0) > 0;
}

// Authorization: Bearer acard_… 를 확인한다. 아니면 null (워커가 401 을 낸다).
export async function principalFromToken(db, raw) {
  if (typeof raw !== "string" || !raw.startsWith(TOKEN_PREFIX) || raw.length > 200) return null;
  const hash = await sha256Hex(raw);
  // Started together so a member workspace store gets both in one round trip.
  const [row] = await Promise.all([
    // agent_rules saves features/share.js a second round trip when the token has no per-page rules (the usual case).
    db.prepare("SELECT id, name, scopes, revoked, EXISTS (SELECT 1 FROM share_rules r WHERE r.principal = 'agent:token:' || agent_tokens.id AND r.revoked IS NULL) AS agent_rules FROM agent_tokens WHERE hash = ?").bind(hash).first(),
    // At most once a minute: under load every request of one token wrote and locked the same row.
    db.prepare("UPDATE agent_tokens SET last_used = ? WHERE hash = ? AND revoked IS NULL AND (last_used IS NULL OR last_used < ?)").bind(Date.now(), hash, Date.now() - 60_000).run(),
  ]);
  if (!row || row.revoked) return null;
  return { name: row.name, via: "token", scopes: String(row.scopes).split(" "), tokenId: row.id, agentRules: Boolean(Number(row.agent_rules)) };
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { meta: {}, body: markdown };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    else value = value.replace(/^["']|["']$/g, "");
    meta[key] = value;
  }
  return { meta, body: markdown.slice(match[0].length) };
}

// notion-parity: block meta comment lines are read only from documents whose front matter says acard_meta: 1.
function metaFlag(meta) {
  return String(meta && meta.acard_meta).trim() === "1";
}

function frontmatterText(page, icon, tags, authors, font) {
  const quote = (value) => (/[:#\[\]"']/.test(value) ? JSON.stringify(value) : value);
  const lines = ["---", "title: " + quote(page.title), "slug: " + page.slug];
  if (page.parent) lines.push("parent: " + page.parent);
  if (icon) lines.push("icon: " + quote(icon));
  if (font === "report") lines.push("style: report");
  if (tags.length) lines.push("tags: [" + tags.map(quote).join(", ") + "]");
  lines.push("updated: " + new Date(page.updated).toISOString());
  if (authors.length) lines.push("last_author: " + quote(authors[0].agent));
  // The body below carries block meta comment lines (color, icon, embed height, toggle heading); send it back with this flag.
  lines.push("acard_meta: 1");
  lines.push("---", "");
  return lines.join("\n");
}

function tagList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean).map((tag) => tag.slice(0, 40)))].slice(0, 20);
}

function requireScope(principal, scope) {
  if (!principal.scopes.includes(scope)) throw new AgentError("이 토큰에는 " + (scope === "write" ? "쓰기" : "읽기") + " 권한이 없어요.", 403);
}

function activityStatement(db, slug, principal, action, id = crypto.randomUUID()) {
  return db.prepare("INSERT INTO agent_activity (id, page, agent, via, action, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, slug, principal.name, principal.via, action, Date.now());
}

async function recordActivity(db, slug, principal, action) {
  await activityStatement(db, slug, principal, action).run();
}

// Retries of a create or an append (a client that timed out and sends the same call again) must not make a second
// page or a second copy of the text. The write's agent_activity row gets an id derived from the Idempotency-Key (or,
// without one, from the same agent sending the same content within 10 minutes) and is inserted in the same transaction
// as the blocks: a second identical call finds it and answers with the first result, and two racing calls cannot both
// commit because the id is the primary key.
const IDEM_WINDOW = 10 * 60 * 1000;
const IDEM_KEY_MAX = 200;
const AUTO_IDEM_MIN = 2000;
function idempotencyKey(input) {
  const key = input.idempotencyKey;
  if (key === undefined || key === null || key === "") return null;
  if (typeof key !== "string" || key.length > IDEM_KEY_MAX) throw new AgentError("idempotencyKey(Idempotency-Key) 는 200자 이하 문자열이어야 해요.");
  return key;
}
async function idemIds(kind, principal, key, content) {
  const who = principal.tokenId || principal.name;
  if (key) return ["idem:" + (await sha256Hex([kind, who, "key", key].join("\u0000"))).slice(0, 40)];
  const bucket = Math.floor(Date.now() / IDEM_WINDOW);
  return Promise.all([bucket, bucket - 1].map(async (b) => "idem:" + (await sha256Hex([kind, who, "auto", b, ...content].join("\u0000"))).slice(0, 40)));
}
async function idemSeen(db, ids) {
  const rows = await db.prepare("SELECT page FROM agent_activity WHERE id IN (" + ids.map(() => "?").join(", ") + ")").bind(...ids).all();
  return (rows.results ?? [])[0]?.page ?? null;
}
const duplicateKey = (error) => /unique|primary key|duplicate key|constraint/i.test(String(error && error.message || error));

const PAGE_BLOCK_MAX = 2000;
function blockLimit(count, existing = 0) {
  if (existing + count <= PAGE_BLOCK_MAX) return;
  throw new AgentError("한 페이지에는 블록을 " + PAGE_BLOCK_MAX + "개까지 넣을 수 있어요 (이번 요청 " + (existing ? "기존 " + existing + "개 + " : "") + count + "개). 긴 문서는 ## 섹션 단위로 나눠 하위 페이지(create_page 에 parent)로 쓰세요. 한 번의 쓰기는 50KB(블록 1000개) 안팎이 가장 빨라요.", 413);
}

export async function pageAuthors(db, slug, limit = 20) {
  const rows = await db.prepare("SELECT agent, via, action, created FROM agent_activity WHERE page = ? ORDER BY created DESC LIMIT ?").bind(slug, limit).all();
  return rows.results ?? [];
}

async function pageTags(db, slug) {
  const rows = await db.prepare("SELECT tag FROM page_tags WHERE page = ? ORDER BY tag").bind(slug).all();
  return (rows.results ?? []).map((row) => row.tag);
}

async function setTags(db, slug, tags) {
  await db.batch([
    db.prepare("DELETE FROM page_tags WHERE page = ?").bind(slug),
    ...tags.map((tag) => db.prepare("INSERT OR IGNORE INTO page_tags (page, tag) VALUES (?, ?)").bind(slug, tag)),
  ]);
}

async function setIcon(db, slug, icon) {
  if (typeof icon !== "string") return;
  const value = icon.trim().slice(0, 100) || null;
  await db.prepare("INSERT INTO editor_page_settings (page, icon) VALUES (?, ?) ON CONFLICT(page) DO UPDATE SET icon = excluded.icon").bind(slug, value).run();
}

// Front matter style: report | default sets the research-report page style (editor_page_settings.font); anything else is ignored.
async function setStyle(db, slug, style) {
  if (style !== "report" && style !== "default") return;
  await db.prepare("INSERT INTO editor_page_settings (page, font) VALUES (?, ?) ON CONFLICT(page) DO UPDATE SET font = excluded.font").bind(slug, style).run();
}

function buttonNote(dropped) {
  return dropped ? { buttons: "버튼 " + dropped + "개의 동작은 저장하지 않았어요. 대상 데이터베이스에 쓸 권한이 없거나 동작 모양이 맞지 않아요." } : {};
}

async function parentExists(db, parent) {
  return Boolean(await db.prepare("SELECT slug FROM pages WHERE slug = ?").bind(parent).first());
}

function markdownInput(text) {
  if (typeof text !== "string") throw new AgentError("마크다운 본문이 필요해요.");
  if (text.length > MARKDOWN_MAX) throw new AgentError(LONG_BODY, 413);
  return text;
}

// Pages that per-page agent rules hide from this token drop out of every list.
async function agentVisible(db, principal, helpers, rows) {
  const readable = helpers?.services?.agentReadable ? await helpers.services.agentReadable(db, principal, rows.map((row) => String(row.slug))) : null;
  return readable ? rows.filter((row) => readable.has(String(row.slug))) : rows;
}

async function ingest(db, helpers, slug, blocks) {
  return helpers.ingestImages ? helpers.ingestImages(db, slug, blocks) : [];
}

function plainComputed(computed) {
  const out = {};
  for (const [id, value] of Object.entries(computed || {})) {
    out[id] = value && typeof value === "object" && Array.isArray(value.__rich) ? value.__rich.map((seg) => String(seg.text ?? "")).join("") : value;
  }
  return out;
}

export function withWarnings(result, imageWarnings, written) {
  const out = imageWarnings && imageWarnings.length ? { ...result, imageWarnings } : result;
  // #58: HTML blocks that paint fixed white/black boxes or a stacked card flow get a pointer to the part to use.
  const html = written && typeof htmlBlockWarnings === "function" ? htmlBlockWarnings(written) : [];
  return html.length ? { ...out, htmlWarnings: html } : out;
}

export const agentOps = {
  async listPages(db, principal, helpers, input = {}) {
    requireScope(principal, "read");
    const q = typeof input.query === "string" ? input.query.trim() : "";
    if (q) {
      if (helpers.services?.search) return { pages: await agentVisible(db, principal, helpers, await helpers.services.search(db, q, 50)) };
      const like = "%" + q.replace(/[%_]/g, "") + "%";
      const rows = await db.prepare("SELECT p.slug, p.title, p.parent, p.updated, (SELECT text FROM blocks b WHERE b.page = p.slug AND b.text LIKE ? LIMIT 1) AS hit FROM pages p WHERE p.kind != 'db_row' AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = p.slug) AND (p.title LIKE ? OR EXISTS (SELECT 1 FROM blocks b WHERE b.page = p.slug AND b.text LIKE ?)) ORDER BY p.updated DESC LIMIT 50")
        .bind(like, like, like).all();
      return { pages: await agentVisible(db, principal, helpers, rows.results ?? []) };
    }
    const tree = await agentVisible(db, principal, helpers, await helpers.readTree(db));
    return { pages: tree.map((page) => ({ slug: page.slug, title: page.title, parent: page.parent, kind: page.kind, icon: page.icon ?? null, updated: page.updated })) };
  },

  async readPage(db, principal, helpers, input) {
    requireScope(principal, "read");
    const slug = String(input.slug ?? "");
    // One wave of queries instead of two: each wave is a ~125 ms round trip through Hyperdrive.
    const [found, tags, authors] = await Promise.all([helpers.readPage(db, slug), pageTags(db, slug), pageAuthors(db, slug, 5)]);
    if (!found) throw new AgentError("없는 페이지예요.", 404);
    const body = helpers.blocksToMarkdown(found.blocks, { meta: true });
    return {
      slug, title: found.page.title, parent: found.page.parent, icon: found.settings?.icon ?? null, tags,
      updated: found.page.updated, authors,
      markdown: frontmatterText(found.page, found.settings?.icon ?? null, tags, authors, found.settings?.font) + body + "\n",
    };
  },

  async createPage(db, principal, helpers, input) {
    requireScope(principal, "write");
    const key = idempotencyKey(input);
    const { meta, body } = parseFrontmatter(markdownInput(input.markdown));
    const folder = (input.view ?? meta.view) === "folder";
    const parsed = helpers.markdownToBlocks(body, { meta: metaFlag(meta) });
    blockLimit(parsed.length);
    let blocks = helpers.normaliseBlocks(parsed);
    if (folder && blocks.length) {
      if (!input.description && !meta.description) input.description = String(blocks.find((b) => b.text)?.text || "").replace(/\s+/g, " ").slice(0, 200);
      blocks = [];
    }
    const title = String(input.title ?? meta.title ?? "").trim().slice(0, 200) || "새 페이지";
    const parent = String(input.parent ?? meta.parent ?? "").trim() || null;
    if (parent && helpers.services?.agentScopes) requireScope({ ...principal, scopes: await helpers.services.agentScopes(db, principal, parent) }, "write");
    const ids = await idemIds("create", principal, key, [parent ?? "", title, String(input.markdown)]);
    const again = async () => {
      const prior = await idemSeen(db, ids);
      const found = prior ? await helpers.readPage(db, prior) : null;
      return found ? { slug: prior, title: found.page.title, parent: found.page.parent, url: "/" + encodeURIComponent(prior) + "/", created: found.page.updated, blocks: found.blocks.length, duplicate: true, note: "같은 요청을 이미 받아 만든 페이지예요. 새로 만들지 않았어요." } : null;
    };
    const earlier = await again();
    if (earlier) return earlier;
    if (parent && !(await parentExists(db, parent))) throw new AgentError("상위 페이지 '" + parent + "' 가 없어요.", 404);
    let slug = helpers.slugify(String(input.slug ?? meta.slug ?? title));
    const taken = await db.prepare("SELECT slug FROM pages WHERE slug = ? UNION ALL SELECT page AS slug FROM editor_trash WHERE page = ?").bind(slug, slug).first();
    if (taken) slug = slug + "-" + Math.random().toString(36).slice(2, 6);
    const maxRow = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM pages WHERE parent IS ?").bind(parent).first();
    const now = Date.now();
    const imageWarnings = await ingest(db, helpers, slug, blocks);
    const buttonsDropped = helpers.guardAgentButtons ? await helpers.guardAgentButtons(db, principal, [], blocks) : 0;
    // The page row, its blocks and the create record commit together: a write that fails or times out leaves no empty page.
    const marker = (await idemSeen(db, ids)) === null ? ids[0] : crypto.randomUUID();
    try {
      await helpers.saveBlocks(db, slug, blocks, {
        before: [db.prepare("INSERT INTO pages (slug, title, parent, ord, kind, updated, source, hash) VALUES (?, ?, ?, ?, 'note', ?, 'editor', NULL)").bind(slug, title, parent, Number(maxRow?.m ?? 0) + 10, now)],
        after: [activityStatement(db, slug, principal, "create", marker)],
      });
    } catch (error) {
      const raced = duplicateKey(error) ? await again() : null;
      if (raced) return raced;
      throw error;
    }
    await setIcon(db, slug, input.icon ?? meta.icon);
    await setStyle(db, slug, input.style ?? meta.style);
    const tags = tagList(input.tags ?? meta.tags);
    if (tags.length) await setTags(db, slug, tags);
    if (folder) await markFolder(db, slug, input.description ?? meta.description, "agent");
    return withWarnings({ slug, title, parent, url: "/" + encodeURIComponent(slug) + "/", created: now, blocks: blocks.length, ...(folder && body.trim() ? { note: "폴더에는 본문을 쓰지 않아요. 한 줄 설명만 남기고, 본문은 parent 로 이 폴더를 준 하위 페이지에 쓰세요." } : {}), ...buttonNote(buttonsDropped) }, imageWarnings, blocks);
  },

  async updatePage(db, principal, helpers, input) {
    requireScope(principal, "write");
    const slug = String(input.slug ?? "");
    const found = await helpers.readPage(db, slug);
    if (!found) throw new AgentError("없는 페이지예요.", 404);
    await folderGuard(db, slug);
    const { meta, body } = parseFrontmatter(markdownInput(input.markdown));
    const parentRaw = input.parent ?? meta.parent;
    const parent = parentRaw === undefined ? found.page.parent : (String(parentRaw).trim() || null);
    if (parent && parent !== found.page.parent && helpers.services?.agentScopes) requireScope({ ...principal, scopes: await helpers.services.agentScopes(db, principal, parent) }, "write");
    const parsed = helpers.markdownToBlocks(body, { meta: metaFlag(meta) });
    blockLimit(parsed.length);
    const written = humanAlign(found.blocks, helpers.normaliseBlocks(parsed));
    // A retry of an update that already went through (the client timed out waiting) would now be refused with 409 because
    // updated moved; when the page already holds exactly this content, answer as done.
    const onlyBody = [input.icon, meta.icon, input.tags, meta.tags, input.parent, meta.parent, input.style, meta.style].every((value) => value === undefined);
    const sameTitle = onlyBody && ((input.title ?? meta.title) === undefined || String(input.title ?? meta.title).trim().slice(0, 200) === found.page.title);
    if (sameTitle && found.blocks.length && helpers.blocksToMarkdown(found.blocks, { meta: true }) === helpers.blocksToMarkdown(written, { meta: true })) {
      return { slug, title: found.page.title, parent: found.page.parent, updated: true, unchanged: true, note: "페이지가 이미 이 내용이라 바꾸지 않았어요." };
    }
    const imageWarnings = await ingest(db, helpers, slug, written);
    // #36: paragraphs a person edited stay as they are; a different text becomes a suggestion under them.
    const guard = humanGuard(found.blocks, written, principal.name, found.settings?.ai, true);
    const blocks = guard.blocks;
    const buttonsDropped = helpers.guardAgentButtons ? await helpers.guardAgentButtons(db, principal, found.blocks, blocks) : 0;
    const title = String(input.title ?? meta.title ?? found.page.title).trim().slice(0, 200) || found.page.title;
    if (parent && (parent === slug || !(await parentExists(db, parent)))) throw new AgentError("상위 페이지가 맞지 않아요.", 400);
    const expected = input.expectedUpdated === undefined || input.expectedUpdated === null ? null : Number(input.expectedUpdated);
    if (expected !== null && !Number.isFinite(expected)) throw new AgentError("expectedUpdated 는 숫자여야 해요.");
    const saved = await helpers.saveAgentBlocks(db, slug, blocks, { expected, title, parent, principal, activity: crypto.randomUUID() });
    if (!saved) {
      throw new AgentError(expected === null
        ? "사람이 이 페이지를 고친 뒤라 그대로 덮어쓸 수 없어요. read_page 로 다시 읽고, 고친 내용을 합친 뒤 그 updated 값을 expectedUpdated 로 보내 주세요."
        : "그사이 페이지가 바뀌었어요. 다시 읽고 합친 뒤 쓰세요.", 409);
    }
    if (title !== found.page.title) await helpers.syncPageTitleToRow(db, slug, title);
    await setIcon(db, slug, input.icon ?? meta.icon);
    await setStyle(db, slug, input.style ?? meta.style);
    const tagsRaw = input.tags ?? meta.tags;
    if (tagsRaw !== undefined) await setTags(db, slug, tagList(tagsRaw));
    return withWarnings(humanNote({ slug, title, parent, updated: true, ...buttonNote(buttonsDropped) }, guard), imageWarnings, written);
  },

  async appendToPage(db, principal, helpers, input) {
    requireScope(principal, "write");
    const slug = String(input.slug ?? "");
    const found = await helpers.readPage(db, slug);
    if (!found) throw new AgentError("없는 페이지예요.", 404);
    await folderGuard(db, slug);
    const key = idempotencyKey(input);
    const appended = parseFrontmatter(markdownInput(input.markdown));
    const parsedAdd = helpers.markdownToBlocks(appended.body, { meta: metaFlag(appended.meta) });
    if (!parsedAdd.length) throw new AgentError("붙일 내용이 비었어요.");
    // Without a key only a large piece (where a timeout retry happens) counts as a repeat; a short log line may be sent twice on purpose.
    const ids = key || String(input.markdown).length >= AUTO_IDEM_MIN ? await idemIds("append", principal, key, [slug, String(input.markdown)]) : [crypto.randomUUID()];
    const skip = { slug, appended: 0, blocks: found.blocks.length, duplicate: true, note: "같은 내용을 이미 붙였어요. 다시 붙이지 않았어요." };
    if ((await idemSeen(db, ids)) !== null) return skip;
    blockLimit(parsedAdd.length, found.blocks.length);
    const added = helpers.normaliseBlocks(parsedAdd);
    const imageWarnings = await ingest(db, helpers, slug, added);
    // Parsed IDs can collide with another append that read the same page (including an empty page).
    for (const block of added) block.id = "a" + crypto.randomUUID();
    try {
      if (!await helpers.saveAgentBlocks(db, slug, added, { append: true, principal, activity: ids[0] })) throw new AgentError("없는 페이지예요.", 404);
    } catch (error) {
      if (duplicateKey(error) && (await idemSeen(db, ids)) !== null) return skip;
      throw error;
    }
    return withWarnings({ slug, appended: added.length, blocks: found.blocks.length + added.length }, imageWarnings, added);
  },

  async listDatabases(db, principal, helpers) {
    requireScope(principal, "read");
    const rows = await db.prepare("SELECT slug, title, icon FROM databases ORDER BY title").all();
    return { databases: await agentVisible(db, principal, helpers, rows.results ?? []) };
  },

  // Formula, rollup and time values are computed on read; style() results go out as their plain text.
  async readDatabase(db, principal, helpers, input) {
    requireScope(principal, "read");
    const found = await helpers.readDatabase(db, String(input.database ?? ""));
    if (!found) throw new AgentError("없는 데이터베이스예요.", 404);
    return {
      database: { slug: found.database.slug, title: found.database.title },
      properties: found.properties.map((prop) => ({ id: prop.id, name: prop.name, type: prop.type })),
      rows: found.rows.map((row) => ({ id: row.id, page: row.page, title: row.pageTitle, props: { ...row.props, ...plainComputed(row.computed) } })),
    };
  },

  async addDatabaseRow(db, principal, helpers, input) {
    requireScope(principal, "write");
    const props = input.props && typeof input.props === "object" && !Array.isArray(input.props) ? input.props : null;
    if (!props) throw new AgentError("props 객체가 필요해요.");
    const result = await helpers.dbRowRequest(db, String(input.database ?? ""), "POST", null, { props }, principal);
    if (result.row?.page) await recordActivity(db, result.row.page, principal, "row-add");
    return result;
  },

  async updateDatabaseRow(db, principal, helpers, input) {
    requireScope(principal, "write");
    const props = input.props && typeof input.props === "object" && !Array.isArray(input.props) ? input.props : null;
    if (!props) throw new AgentError("props 객체가 필요해요.");
    const row = String(input.row ?? "");
    const result = await helpers.dbRowRequest(db, String(input.database ?? ""), "PATCH", row, { props }, principal);
    const page = await db.prepare("SELECT page FROM db_rows WHERE id = ?").bind(row).first();
    if (page?.page) await recordActivity(db, page.page, principal, "row-update");
    return result;
  },

  // "decision" 은 마크다운 `> [!decision] 질문` 콜아웃으로 적는다. 오너가 콜아웃을 지우면 목록에서 빠진다.
  async listDecisions(db, principal, helpers) {
    requireScope(principal, "read");
    const rows = await db.prepare("SELECT b.page AS slug, p.title, b.id AS block, b.text, p.updated FROM blocks b JOIN pages p ON p.slug = b.page WHERE b.type = 'callout' AND b.meta LIKE '%\"tone\":\"decision\"%' AND NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = b.page) ORDER BY p.updated DESC LIMIT 100").all();
    return { decisions: await agentVisible(db, principal, helpers, rows.results ?? []) };
  },

  async whoami(db, principal) {
    return { agent: principal.name, via: principal.via, scopes: principal.scopes };
  },
};

async function bodyOf(request) {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (text.length > MARKDOWN_MAX + 10_000) throw new AgentError(LONG_BODY, 413);
  if (/^text\/(markdown|plain)/i.test(type)) return { markdown: text };
  if (!text.trim()) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new AgentError("JSON 본문을 읽지 못했어요."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError("JSON 객체가 필요해요.");
  return value;
}

function wantsMarkdown(request, url) {
  return url.searchParams.get("format") === "markdown" || /text\/markdown/i.test(request.headers.get("accept") ?? "");
}

export async function handleAgentV1(request, db, path, principal, helpers) {
  const { json } = helpers;
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  try {
    await ensureAgentSchema(db);
    if (path === "/me" && method === "GET") return json(await agentOps.whoami(db, principal));
    if (path === "/pages" && method === "GET") return json(await agentOps.listPages(db, principal, helpers, { query: url.searchParams.get("q") ?? "" }));
    const idem = request.headers.get("idempotency-key");
    const withKey = (body) => (idem && (body.idempotencyKey === undefined || body.idempotencyKey === null) ? { ...body, idempotencyKey: idem } : body);
    if (path === "/pages" && method === "POST") {
      const result = await agentOps.createPage(db, principal, helpers, withKey(await bodyOf(request)));
      return json(result, result.duplicate ? 200 : 201);
    }
    const page = /^\/pages\/([^/]+)(\/append)?$/.exec(path);
    if (page) {
      let slug;
      try { slug = helpers.resolveSlug(decodeURIComponent(page[1])); } catch { throw new AgentError("주소를 읽지 못했어요."); }
      if (page[2] && method === "POST") return json(await agentOps.appendToPage(db, principal, helpers, { ...withKey(await bodyOf(request)), slug }));
      if (!page[2] && method === "GET") {
        const found = await agentOps.readPage(db, principal, helpers, { slug });
        const etag = '"' + found.updated + '"';
        if (wantsMarkdown(request, url)) return new Response(found.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", etag } });
        const response = json(found);
        response.headers.set("etag", etag);
        return response;
      }
      if (!page[2] && (method === "PUT" || method === "PATCH")) {
        const body = await bodyOf(request);
        // If-Match: "<updated>" (the ETag from GET) works like expectedUpdated.
        const ifMatch = /^(?:W\/)?"?(\d+)"?$/.exec((request.headers.get("if-match") ?? "").trim());
        if (ifMatch && (body.expectedUpdated === undefined || body.expectedUpdated === null)) body.expectedUpdated = Number(ifMatch[1]);
        return json(await agentOps.updatePage(db, principal, helpers, { ...body, slug }));
      }
      return json({ error: "지원하지 않는 방법이에요." }, 405);
    }
    if (path === "/databases" && method === "GET") return json(await agentOps.listDatabases(db, principal, helpers));
    const rows = /^\/databases\/([^/]+)\/rows(?:\/([^/]+))?$/.exec(path);
    if (rows) {
      const database = decodeURIComponent(rows[1]);
      if (!rows[2] && method === "GET") return json(await agentOps.readDatabase(db, principal, helpers, { database }));
      if (!rows[2] && method === "POST") return json(await agentOps.addDatabaseRow(db, principal, helpers, { ...(await bodyOf(request)), database }), 201);
      if (rows[2] && method === "PATCH") return json(await agentOps.updateDatabaseRow(db, principal, helpers, { ...(await bodyOf(request)), database, row: decodeURIComponent(rows[2]) }));
      return json({ error: "지원하지 않는 방법이에요." }, 405);
    }
    if (path === "/decisions" && method === "GET") return json(await agentOps.listDecisions(db, principal, helpers));
    return json({ error: "없는 API예요." }, 404);
  } catch (error) {
    if (error instanceof AgentError) return json({ error: error.message }, error.status);
    throw error;
  }
}
