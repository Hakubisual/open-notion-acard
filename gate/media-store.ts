// Media originals live in R2 (bucket acard-media, binding MEDIA_R2) from 2026-10-20; the KV namespace MEDIA keeps
// everything else (imginfo/<id>, resized @w copies) and the originals written before the move, which stay as a fallback
// so an image that was not copied yet still opens. App code keeps calling env.MEDIA with the KV shape it always used:
// this wrapper sends original keys (…media/<16 hex>) to R2 and the rest to KV. The /media/<id> addresses do not change.

type KvLike = {
  // Only the R2-backed store has these: a streamed original (never held whole in memory) and a raw R2 read (Range).
  putStream?(key: string, body: ReadableStream, metadata: Record<string, unknown>): Promise<{ httpEtag?: string; size?: number } | null>;
  r2Object?(key: string, options?: { range?: { offset: number; length?: number } | { suffix: number } }): Promise<R2Body | null>;
  r2Head?(key: string): Promise<{ size: number; meta: Record<string, unknown> } | null>;
  get(key: string, options?: unknown): Promise<unknown>;
  getWithMetadata(key: string, options?: unknown): Promise<{ value: unknown; metadata: unknown }>;
  put(key: string, value: unknown, options?: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
};

type R2Object = { key: string; size: number; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> };
export type R2Body = R2Object & { body: ReadableStream; httpEtag?: string; range?: { offset?: number; length?: number; suffix?: number }; meta: Record<string, unknown> };
export type R2Like = {
  get(key: string, options?: unknown): Promise<R2Object | null>;
  head(key: string): Promise<{ key: string; size: number; customMetadata?: Record<string, string> } | null>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; include?: string[] }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
};

export const ORIGINAL_KEY = /(?:^|\/)media\/[0-9a-f]{16}$/;

function typeOf(options: unknown): string {
  return options && typeof options === "object" && typeof (options as { type?: unknown }).type === "string" ? (options as { type: string }).type : "text";
}

async function decode(object: R2Object, type: string): Promise<unknown> {
  if (type === "arrayBuffer") return object.arrayBuffer();
  if (type === "stream") return (object as unknown as { body: unknown }).body;
  const text = await object.text();
  return type === "json" ? JSON.parse(text) : text;
}

function readMeta(object: { customMetadata?: Record<string, string> }): Record<string, unknown> {
  try { return JSON.parse(object.customMetadata?.meta ?? "{}"); } catch { return {}; }
}

export function r2Put(r2: R2Like, key: string, value: unknown, options?: unknown) {
  const metadata = options && typeof options === "object" ? (options as { metadata?: Record<string, unknown> }).metadata : undefined;
  const mime = typeof metadata?.mime === "string" ? metadata.mime : "application/octet-stream";
  return r2.put(key, value, { httpMetadata: { contentType: mime }, customMetadata: { meta: JSON.stringify(metadata ?? {}) } });
}

// acard-storage-cost 2: an original that no page, trash, history, share, backup, template, comment, journal or setting
// refers to is moved to quarantine/<its key> (copied, checked, then removed from its place) instead of being deleted. A
// read that misses the original still finds the quarantined copy, so a wrong call never breaks an image; it is logged
// so the file can be put back (scripts/media-quarantine.ts restore).
export const QUARANTINE = "quarantine/";

async function quarantined(r2: R2Like, key: string) {
  const object = await r2.get(QUARANTINE + key);
  if (object) console.warn("acard media served from quarantine", key);
  return object;
}

export function hybridMedia(kv: KvLike, r2: R2Like): KvLike & { readonly r2: R2Like; readonly kv: KvLike } {
  return {
    r2,
    kv,
    // body must be a stream of known length (FixedLengthStream); a stream that errors or ends short stores nothing.
    async putStream(key, body, metadata) {
      if (!ORIGINAL_KEY.test(key)) throw new Error("putStream is for media originals only");
      return (await r2Put(r2, key, body, { metadata })) as { httpEtag?: string; size?: number } | null;
    },
    async r2Object(key, options) {
      if (!ORIGINAL_KEY.test(key)) return null;
      const object = (await r2.get(key, options)) ?? (await r2.get(QUARANTINE + key, options));
      return object ? Object.assign(object as R2Body, { meta: readMeta(object) }) : null;
    },
    async r2Head(key) {
      if (!ORIGINAL_KEY.test(key)) return null;
      const object = (await r2.head(key)) ?? (await r2.head(QUARANTINE + key));
      return object ? { size: object.size, meta: readMeta(object) } : null;
    },
    async get(key, options) {
      if (!ORIGINAL_KEY.test(key)) return kv.get(key, options);
      const object = (await r2.get(key)) ?? (await quarantined(r2, key));
      return object ? decode(object, typeOf(options)) : kv.get(key, options);
    },
    async getWithMetadata(key, options) {
      if (!ORIGINAL_KEY.test(key)) return kv.getWithMetadata(key, options);
      const object = await r2.get(key);
      if (object) return { value: await decode(object, typeOf(options)), metadata: { ...readMeta(object), store: "r2" } };
      const held = await quarantined(r2, key);
      if (held) return { value: await decode(held, typeOf(options)), metadata: { ...readMeta(held), store: "r2", quarantined: true } };
      return kv.getWithMetadata(key, options);
    },
    async put(key, value, options) {
      if (!ORIGINAL_KEY.test(key)) return kv.put(key, value, options);
      await r2Put(r2, key, value, options);
    },
    async delete(key) {
      if (ORIGINAL_KEY.test(key)) await r2.delete(key);
      await kv.delete(key);
    },
    // Used when a workspace is deleted (gate/tenancy.ts wipeWorkspace): every key under the prefix in either store.
    async list(options = {}) {
      const found = await kv.list(options);
      if (found.list_complete === false) return found;
      const names = new Set(found.keys.map((entry) => entry.name));
      const extra: { name: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await r2.list({ prefix: options.prefix, cursor, limit: 1000 });
        for (const object of page.objects) if (!names.has(object.key)) extra.push({ name: object.key });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return { ...found, keys: found.keys.concat(extra), list_complete: true };
    },
  };
}

export function withR2Media<E extends { MEDIA?: unknown; MEDIA_R2?: unknown }>(env: E): E {
  if (!env.MEDIA || !env.MEDIA_R2) return env;
  return { ...env, MEDIA: hybridMedia(env.MEDIA as KvLike, env.MEDIA_R2 as R2Like) };
}

// One-off move (2026-10-20): copy KV originals into R2 under the same key. Idempotent (an object already in R2 with the
// same size is skipped), never deletes KV. Called page by page by scripts/media-to-r2.ts through POST /__media/migrate.
export async function migrateMediaPage(kv: KvLike, r2: R2Like, cursor: string | undefined, limit: number) {
  const page = await kv.list({ cursor, limit });
  const out = { scanned: page.keys.length, copied: 0, skipped: 0, failed: [] as string[], bytes: 0, cursor: page.list_complete ? null : page.cursor ?? null };
  for (const entry of page.keys) {
    if (!ORIGINAL_KEY.test(entry.name)) continue;
    const found = await kv.getWithMetadata(entry.name, { type: "arrayBuffer" });
    const value = found.value as ArrayBuffer | null;
    if (!value) { out.failed.push(entry.name + ": empty in KV"); continue; }
    const there = await r2.head(entry.name);
    if (there && there.size === value.byteLength) { out.skipped += 1; out.bytes += value.byteLength; continue; }
    await r2Put(r2, entry.name, value, { metadata: (found.metadata ?? {}) as Record<string, unknown> });
    const check = await r2.head(entry.name);
    if (!check || check.size !== value.byteLength) { out.failed.push(entry.name + ": size mismatch after copy"); continue; }
    out.copied += 1;
    out.bytes += value.byteLength;
  }
  return out;
}

type R2Full = R2Like;

// Move one original into quarantine: copy with its metadata, read the copy back and compare size and bytes' hash, and only
// then remove the original. Any failure leaves the original where it was. Idempotent: already quarantined is ok.
export async function quarantineOriginal(r2: R2Full, key: string): Promise<{ ok: boolean; bytes?: number; error?: string }> {
  if (!ORIGINAL_KEY.test(key)) return { ok: false, error: "not an original key" };
  const object = await r2.get(key);
  if (!object) return (await r2.head(QUARANTINE + key)) ? { ok: true, bytes: 0 } : { ok: false, error: "missing" };
  const bytes = await object.arrayBuffer();
  await r2.put(QUARANTINE + key, bytes, { httpMetadata: { contentType: object.httpMetadata?.contentType ?? "application/octet-stream" }, customMetadata: { ...(object.customMetadata ?? {}), quarantinedAt: new Date().toISOString() } });
  const copy = await r2.get(QUARANTINE + key);
  if (!copy) return { ok: false, error: "copy not found" };
  const back = await copy.arrayBuffer();
  if (back.byteLength !== bytes.byteLength || (await digest(back)) !== (await digest(bytes))) return { ok: false, error: "copy differs" };
  await r2.delete(key);
  return { ok: true, bytes: bytes.byteLength };
}

// The way back: copy quarantine/<key> to <key>, check it, then remove the quarantined copy.
export async function restoreOriginal(r2: R2Full, key: string): Promise<{ ok: boolean; bytes?: number; error?: string }> {
  if (!ORIGINAL_KEY.test(key)) return { ok: false, error: "not an original key" };
  const held = await r2.get(QUARANTINE + key);
  if (!held) return (await r2.head(key)) ? { ok: true, bytes: 0 } : { ok: false, error: "not in quarantine" };
  const bytes = await held.arrayBuffer();
  const { quarantinedAt: _at, ...meta } = held.customMetadata ?? {};
  await r2.put(key, bytes, { httpMetadata: { contentType: held.httpMetadata?.contentType ?? "application/octet-stream" }, customMetadata: meta });
  const copy = await r2.get(key);
  if (!copy) return { ok: false, error: "restore not found" };
  const back = await copy.arrayBuffer();
  if (back.byteLength !== bytes.byteLength || (await digest(back)) !== (await digest(bytes))) return { ok: false, error: "restore differs" };
  await r2.delete(QUARANTINE + key);
  return { ok: true, bytes: bytes.byteLength };
}

async function digest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function r2Usage(r2: R2Like) {
  let bytes = 0, objects = 0;
  let cursor: string | undefined;
  do {
    const page = await r2.list({ cursor, limit: 1000 });
    for (const object of page.objects) { bytes += object.size; objects += 1; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { bytes, objects };
}
