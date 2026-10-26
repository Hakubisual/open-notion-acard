// One archive file for backup, restore, the beta cloud export and publishing (docs/local-first.md 3장).
// zip: manifest.json + data/<table>.json (rows) + media/<id> (originals) + markdown/<slug>.md (a readable copy).
// Runs in Bun (local server) and in Workers (notes.example.com): no node APIs, only Compression/DecompressionStream.
// Interface fixed regardless of the storage decision: exportArchive(db, readMedia) -> zip, readArchive(zip) -> parts,
// applyArchive(db, parts, writeMedia) -> restore. Layout version 1; a .md-vault layout would be version 2.
import { acardMarkdown, type Block } from "../markdown-blocks";

export const ARCHIVE_FORMAT = "acard-archive";
export const ARCHIVE_VERSION = 1;
// Temporary values (docs/local-first.md 3장).
export const ARCHIVE_LIMITS = { maxBytes: 300 * 1024 * 1024, maxEntries: 100_000, cloudBackupBytes: 90 * 1024 * 1024 };

// Tables that hold the user's own content and settings. Order matters only for readability; restore clears and refills
// each one in a single batch.
export const ARCHIVE_TABLES = [
  "pages", "blocks", "links", "meta", "media",
  "databases", "db_properties", "db_rows", "db_views", "db_templates", "db_relation_links", "db_counters", "db_forms", "db_rules", "db_template_runs", "db_value_backups",
  "editor_page_settings", "editor_trash", "editor_history", "editor_templates", "editor_comments",
  "tags", "page_tags", "page_view", "page_imports", "parts", "part_themes", "share_pages",
  "projects", "memo_items", "journal_sessions", "journal_events", "journal_digests", "agent_memory", "agent_chat",
  "auto_notes_settings", "organize_settings", "first_run", "feature_templates_state",
] as const;
// Never exported: secrets (token hashes, OAuth grants, share/guest tokens, invite codes), caches and indexes rebuilt on
// demand, undo logs and usage counters. A backup handed to someone else therefore revives none of the owner's access.
export const ARCHIVE_SKIPPED = [
  "agent_tokens", "agent_grants", "share_rules", "share_links", "share_invites", "share_sessions", "share_requests", "share_rate",
  "link_cache", "page_fts", "page_fts_ko", "page_fts_dirty", "page_fts_state", "agent_usage", "agent_latency", "agent_activity",
  "agent_sessions", "agent_activities", "agent_suggestions", "agent_undo", "db_relation_locks", "page_view_moves",
  "memo_drafts", "memo_apply_batches", "project_backfill", "folder_activity",
];
// A publish archive carries only these tables, filtered to the chosen pages (column that names the page).
const PAGE_SCOPED: Record<string, string> = { pages: "slug", blocks: "page", links: "src", editor_page_settings: "page", page_view: "page", page_tags: "page" };

export type Row = Record<string, unknown>;
export type MediaFile = { id: string; bytes: Uint8Array; mime: string; name: string };
export type Manifest = {
  format: string; version: number; created: number; source: string; app: string;
  tables: Record<string, number>; media: { id: string; name: string; mime: string; bytes: number }[]; skipped: string[]; pages?: string[];
};
export type ArchiveParts = { manifest: Manifest; tables: Map<string, Row[]>; media: Map<string, MediaFile> };
type Stmt = { bind(...values: unknown[]): Stmt; all(): Promise<{ results?: Row[] }>; run(): Promise<unknown> };
export type ArchiveDb = { prepare(sql: string): Stmt; batch(list: Stmt[]): Promise<unknown> };
export type ReadMedia = (id: string) => Promise<MediaFile | null>;
export type WriteMedia = (file: MediaFile) => Promise<void>;

export class ArchiveError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const MEDIA_REF = /\/media\/([0-9a-f]{16})/g;
const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

export type ZipEntry = { name: string; data: Uint8Array };

// Text entries are deflated, media is stored as is (images are already compressed).
export async function writeZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const prepared: { name: Uint8Array; body: Uint8Array; method: number; crc: number; size: number; offset: number }[] = [];
  for (const entry of entries) {
    const deflate = !entry.name.startsWith("media/") && entry.data.length > 64;
    const body = deflate ? await pipe(entry.data, new CompressionStream("deflate-raw")) : entry.data;
    prepared.push({ name: enc.encode(entry.name), body, method: deflate ? 8 : 0, crc: crc32(entry.data), size: entry.data.length, offset: 0 });
  }
  let total = 22;
  for (const p of prepared) total += 30 + p.name.length + p.body.length + 46 + p.name.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  let pos = 0;
  const header = (sig: number, central: boolean, p: (typeof prepared)[number]) => {
    view.setUint32(pos, sig, true); pos += 4;
    if (central) { view.setUint16(pos, 20, true); pos += 2; }
    view.setUint16(pos, 20, true); view.setUint16(pos + 2, 0x0800, true); view.setUint16(pos + 4, p.method, true);
    view.setUint16(pos + 6, 0, true); view.setUint16(pos + 8, dosDate, true); view.setUint32(pos + 10, p.crc, true);
    view.setUint32(pos + 14, p.body.length, true); view.setUint32(pos + 18, p.size, true); view.setUint16(pos + 22, p.name.length, true);
    view.setUint16(pos + 24, 0, true); pos += 26;
    if (central) { view.setUint16(pos, 0, true); view.setUint16(pos + 2, 0, true); view.setUint16(pos + 4, 0, true); view.setUint32(pos + 6, 0, true); view.setUint32(pos + 10, p.offset, true); pos += 14; }
    out.set(p.name, pos); pos += p.name.length;
  };
  for (const p of prepared) { p.offset = pos; header(0x04034b50, false, p); out.set(p.body, pos); pos += p.body.length; }
  const cd = pos;
  for (const p of prepared) header(0x02014b50, true, p);
  view.setUint32(pos, 0x06054b50, true); view.setUint16(pos + 4, 0, true); view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true); view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, pos - cd, true); view.setUint32(pos + 16, cd, true); view.setUint16(pos + 20, 0, true);
  return out;
}

export async function readZip(bytes: Uint8Array, limits = ARCHIVE_LIMITS): Promise<Map<string, Uint8Array>> {
  if (bytes.length > limits.maxBytes) throw new ArchiveError("백업 파일이 너무 커요.", 413);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveError("zip 파일이 아니에요.");
  const count = view.getUint16(eocd + 10, true);
  if (count > limits.maxEntries) throw new ArchiveError("파일이 너무 많이 들어 있어요.", 413);
  let pos = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) throw new ArchiveError("zip 목차가 깨졌어요.");
    const method = view.getUint16(pos + 10, true), crc = view.getUint32(pos + 16, true), csize = view.getUint32(pos + 20, true), usize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true), offset = view.getUint32(pos + 42, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extra + comment;
    if (name.endsWith("/")) continue;
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) throw new ArchiveError("zip 안의 경로가 올바르지 않아요.");
    unpacked += usize;
    if (unpacked > limits.maxBytes * 4) throw new ArchiveError("압축을 푼 크기가 너무 커요.", 413);
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new ArchiveError("zip 항목이 깨졌어요: " + name);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const raw = bytes.subarray(start, start + csize);
    if (raw.length !== csize) throw new ArchiveError("zip 항목이 잘렸어요: " + name);
    if (method !== 0 && method !== 8) throw new ArchiveError("지원하지 않는 압축 방식이에요: " + name);
    let data: Uint8Array;
    try { data = method === 0 ? raw : await pipe(raw, new DecompressionStream("deflate-raw")); }
    catch { throw new ArchiveError("zip 항목이 손상됐어요: " + name); }
    if (data.length !== usize || crc32(data) !== crc) throw new ArchiveError("zip 항목이 손상됐어요: " + name);
    out.set(name, data);
  }
  return out;
}

async function tableRows(db: ArchiveDb, table: string, where?: { column: string; values: string[] }): Promise<Row[] | null> {
  try {
    if (!where) return (await db.prepare("SELECT * FROM " + table).all()).results ?? [];
    if (!where.values.length) return [];
    const rows: Row[] = [];
    for (let i = 0; i < where.values.length; i += 200) {
      const chunk = where.values.slice(i, i + 200);
      rows.push(...((await db.prepare("SELECT * FROM " + table + " WHERE " + where.column + " IN (" + chunk.map(() => "?").join(", ") + ")").bind(...chunk).all()).results ?? []));
    }
    return rows;
  } catch {
    return null;
  }
}

// The one page serializer for every file copy of a page (archive markdown/ now, a .md vault mirror later): lossless
// acard-md, which /api/import/md and MCP read back into the same blocks.
export function pageMarkdown(title: string, slug: string, blockRows: Row[] | undefined): string {
  return acardMarkdown(title || slug, blocksOf(blockRows, slug));
}

function blocksOf(rows: Row[] | undefined, page: string): Block[] {
  return (rows ?? []).filter((r) => r.page === page).sort((a, b) => Number(a.ord) - Number(b.ord)).map((r) => {
    let meta: Record<string, unknown> | undefined;
    try { meta = r.meta ? JSON.parse(String(r.meta)) : undefined; } catch { meta = undefined; }
    return { id: String(r.id), type: r.type as Block["type"], text: String(r.text ?? ""), checked: Number(r.checked) === 1, indent: Number(r.indent) || 0, ...(meta ? { meta } : {}) };
  });
}

// Every page under the given roots (parent chain), roots included; trashed pages left out.
export async function subtree(db: ArchiveDb, roots: string[]): Promise<string[]> {
  const rows = ((await db.prepare("SELECT slug, parent FROM pages WHERE NOT EXISTS (SELECT 1 FROM editor_trash t WHERE t.page = pages.slug)").all()).results ?? []) as { slug: string; parent: string | null }[];
  const known = new Set(rows.map((r) => String(r.slug)));
  const picked = new Set(roots.filter((s) => known.has(s)));
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) if (r.parent && picked.has(String(r.parent)) && !picked.has(String(r.slug))) { picked.add(String(r.slug)); changed = true; }
  }
  return [...picked];
}

export async function exportArchive(db: ArchiveDb, readMedia: ReadMedia, options: { source: string; app?: string; pages?: string[] } = { source: "local" }): Promise<Uint8Array> {
  const tables = new Map<string, Row[]>();
  const skipped: string[] = [...ARCHIVE_SKIPPED];
  const scope = options.pages;
  for (const table of ARCHIVE_TABLES) {
    if (scope && !PAGE_SCOPED[table] && table !== "media" && table !== "tags") continue;
    if (table === "media") continue;
    const rows = await tableRows(db, table, scope && PAGE_SCOPED[table] ? { column: PAGE_SCOPED[table], values: scope } : undefined);
    if (rows) tables.set(table, rows);
  }
  // Media follows references, so icons, covers and images pasted into another page's block all come along.
  const text = JSON.stringify([...tables.values()]);
  const referenced = new Set([...text.matchAll(MEDIA_REF)].map((m) => m[1]));
  const mediaRows = (await tableRows(db, "media")) ?? [];
  const keep = scope ? mediaRows.filter((r) => referenced.has(String(r.id))) : mediaRows;
  for (const r of keep) referenced.add(String(r.id));
  tables.set("media", keep);
  const files: MediaFile[] = [];
  const missing: string[] = [];
  for (const id of [...referenced].sort()) {
    const file = await readMedia(id).catch(() => null);
    if (file) files.push(file); else missing.push(id);
  }
  const entries: ZipEntry[] = [];
  const counts: Record<string, number> = {};
  for (const [table, rows] of tables) { counts[table] = rows.length; entries.push({ name: "data/" + table + ".json", data: enc.encode(JSON.stringify(rows)) }); }
  for (const file of files) entries.push({ name: "media/" + file.id, data: file.bytes });
  const trashed = new Set((tables.get("editor_trash") ?? []).map((r) => String(r.page)));
  for (const page of tables.get("pages") ?? []) {
    const slug = String(page.slug);
    if (trashed.has(slug) || !/^[^/\\:*?"<>|\u0000-\u001f]{1,120}$/.test(slug) || slug.startsWith(".")) continue;
    entries.push({ name: "markdown/" + slug + ".md", data: enc.encode(pageMarkdown(String(page.title ?? ""), slug, tables.get("blocks"))) });
  }
  const manifest: Manifest = {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, created: Date.now(), source: options.source, app: options.app ?? "acard",
    tables: counts, media: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes.length })),
    skipped: skipped.concat(missing.map((id) => "media:" + id)), ...(scope ? { pages: scope } : {}),
  };
  entries.unshift({ name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)) });
  return writeZip(entries);
}

export async function readArchive(bytes: Uint8Array, limits = ARCHIVE_LIMITS): Promise<ArchiveParts> {
  const files = await readZip(bytes, limits);
  const raw = files.get("manifest.json");
  if (!raw) throw new ArchiveError("Acard 백업 파일이 아니에요 (manifest.json 없음).");
  let manifest: Manifest;
  try { manifest = JSON.parse(dec.decode(raw)); } catch { throw new ArchiveError("manifest.json 을 읽지 못했어요."); }
  if (manifest.format !== ARCHIVE_FORMAT) throw new ArchiveError("Acard 백업 파일이 아니에요.");
  if (!(manifest.version >= 1) || manifest.version > ARCHIVE_VERSION) throw new ArchiveError("이 앱보다 새 버전에서 만든 백업이에요. 앱을 업데이트해 주세요.");
  const tables = new Map<string, Row[]>();
  for (const table of ARCHIVE_TABLES) {
    const data = files.get("data/" + table + ".json");
    if (!data) continue;
    let rows: unknown;
    try { rows = JSON.parse(dec.decode(data)); } catch { throw new ArchiveError(table + " 표를 읽지 못했어요."); }
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new ArchiveError(table + " 표 형식이 올바르지 않아요.");
    tables.set(table, rows as Row[]);
  }
  if (!tables.has("pages")) throw new ArchiveError("백업에 페이지가 없어요.");
  const info = new Map((manifest.media ?? []).map((m) => [m.id, m]));
  const media = new Map<string, MediaFile>();
  for (const [name, data] of files) {
    const m = /^media\/([0-9a-f]{16})$/.exec(name);
    if (!m) continue;
    const meta = info.get(m[1]);
    media.set(m[1], { id: m[1], bytes: data, mime: meta?.mime ?? "application/octet-stream", name: meta?.name ?? "file" });
  }
  return { manifest, tables, media };
}

async function columnsOf(db: ArchiveDb, table: string): Promise<string[] | null> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) return null;
  for (const sql of ["SELECT name FROM pragma_table_info('" + table + "')", "PRAGMA table_info(" + table + ")"]) {
    try {
      const rows = (await db.prepare(sql).all()).results ?? [];
      return rows.length ? rows.map((r) => String(r.name)) : null;
    } catch {
      continue;
    }
  }
  return null;
}

// Replaces the listed tables with the archive's rows in one batch (one transaction on SQLite, Durable Object and
// Postgres). Columns the target does not have are dropped, missing ones take their defaults, so an older or newer
// archive still opens. The target schema must already exist (call the app once before).
export async function applyArchive(db: ArchiveDb, parts: ArchiveParts, writeMedia: WriteMedia, options: { mode?: "replace" | "merge" } = {}) {
  if (!(await columnsOf(db, "pages"))) throw new ArchiveError("복원할 저장소가 아직 준비되지 않았어요. 앱을 한 번 연 뒤 다시 해 주세요.", 503);
  const statements: Stmt[] = [];
  const restored: Record<string, number> = {};
  for (const [table, rows] of parts.tables) {
    const columns = await columnsOf(db, table);
    if (!columns) continue;
    if (options.mode !== "merge") statements.push(db.prepare("DELETE FROM " + table));
    const allowed = new Set(columns);
    for (const row of rows) {
      const keys = Object.keys(row).filter((k) => allowed.has(k));
      if (!keys.length) continue;
      statements.push(db.prepare("INSERT OR REPLACE INTO " + table + " (" + keys.map((k) => '"' + k + '"').join(", ") + ") VALUES (" + keys.map(() => "?").join(", ") + ")")
        .bind(...keys.map((k) => { const v = row[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; })));
    }
    restored[table] = rows.length;
  }
  // Search rebuilds itself on the next query when its version stamp is gone (features/search-fts.js).
  if (parts.tables.has("pages") && (await columnsOf(db, "page_fts_state"))) statements.push(db.prepare("DELETE FROM page_fts_state"));
  for (const file of parts.media.values()) await writeMedia(file);
  await db.batch(statements);
  return { tables: restored, media: parts.media.size };
}
