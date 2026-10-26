// issue 165: the one place that decides which bucket holds media originals, plugin files, backups and sync files.
// Today that is Cloudflare R2 (binding MEDIA_R2). A Korean S3-compatible bucket (Naver Cloud, NHN Cloud, KT Cloud or
// Supabase Storage in Seoul) can take its place without touching the callers: s3Bucket() speaks the same R2 shape
// (get/head/put/delete/list) over the S3 REST API with AWS Signature V4, and mediaBucket() picks one from the env:
//   MEDIA_STORE = "r2" (default) | "s3"
//   MEDIA_S3_ENDPOINT (https://kr.object.ncloudstorage.com), MEDIA_S3_REGION, MEDIA_S3_BUCKET,
//   MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY (secrets)
//   MEDIA_WRITES = "paused" refuses every put/delete (the short write stop while the last changes are copied).
// The move itself is scripts/kr-migrate.ts; the runbook and the way back are in docs/kr-storage-migration.md.

import type { R2Like } from "./media-store";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
};

const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (data: ArrayBuffer | Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", (typeof data === "string" ? enc.encode(data) : data) as BufferSource));
const hmac = async (key: ArrayBuffer | Uint8Array, text: string) =>
  crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(text));
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// RFC 3986 encoding as SigV4 wants it (path keeps "/").
const uriEncode = (value: string, keepSlash: boolean) =>
  Array.from(enc.encode(value), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/") ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }).join("");

// AWS Signature Version 4 for one request. Returns the headers to send (Authorization, x-amz-date, x-amz-content-sha256
// and the given ones). Exported for the test that checks it against AWS's published example.
export async function signV4(input: { method: string; url: string; headers?: Record<string, string>; payloadHash: string; region: string; accessKeyId: string; secretAccessKey: string; now: Date; service?: string }) {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const service = input.service ?? "s3";
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = String(value).trim();
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = input.payloadHash;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams.entries()].map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => k + "=" + v).join("&");
  const path = uriEncode(decodeURIComponent(url.pathname), true);
  const canonical = [input.method, path, query, names.map((n) => n + ":" + headers[n] + "\n").join(""), names.join(";"), input.payloadHash].join("\n");
  const scope = day + "/" + input.region + "/" + service + "/aws4_request";
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  let key = await hmac(enc.encode("AWS4" + input.secretAccessKey), day);
  for (const part of [input.region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  const { host: _host, ...send } = headers;
  return { ...send, authorization: "AWS4-HMAC-SHA256 Credential=" + input.accessKeyId + "/" + scope + ", SignedHeaders=" + names.join(";") + ", Signature=" + signature };
}

type Meta = Record<string, string>;
type S3Object = {
  key: string; size: number; httpEtag?: string; uploaded?: Date;
  customMetadata: Meta; httpMetadata: { contentType?: string };
  range?: { offset: number; length?: number };
  body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>;
};

const META_PREFIX = "x-amz-meta-";
// S3 header values must be ASCII; custom metadata (JSON with Korean file names) is carried percent-encoded.
const metaOut = (meta: Meta | undefined) => Object.fromEntries(Object.entries(meta ?? {}).map(([k, v]) => [META_PREFIX + k.toLowerCase(), encodeURIComponent(v)]));
function metaIn(headers: Headers): Meta {
  const out: Meta = {};
  headers.forEach((value, name) => { if (name.startsWith(META_PREFIX)) { try { out[name.slice(META_PREFIX.length)] = decodeURIComponent(value); } catch { out[name.slice(META_PREFIX.length)] = value; } } });
  return out;
}

function rangeHeader(range: unknown): string | null {
  if (!range || typeof range !== "object") return null;
  const r = range as { offset?: number; length?: number; suffix?: number };
  if (typeof r.suffix === "number") return "bytes=-" + r.suffix;
  if (typeof r.offset === "number") return "bytes=" + r.offset + "-" + (typeof r.length === "number" ? r.offset + r.length - 1 : "");
  return null;
}

const xmlText = (xml: string, tag: string) => [...xml.matchAll(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g"))].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));

export function s3Bucket(config: S3Config): R2Like & { readonly kind: "s3" } {
  const doFetch = config.fetch ?? fetch;
  const base = config.endpoint.replace(/\/+$/, "") + "/" + encodeURIComponent(config.bucket);
  const objectUrl = (key: string) => base + "/" + key.split("/").map(encodeURIComponent).join("/");
  const send = async (method: string, url: string, headers: Record<string, string> = {}, body?: ArrayBuffer | Uint8Array) => {
    const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
    const signed = await signV4({ method, url, headers, payloadHash, region: config.region, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now: new Date() });
    return doFetch(url, { method, headers: signed, body: body as BodyInit | undefined });
  };
  const fail = async (what: string, res: Response) => { throw new Error("s3 " + what + " " + res.status + " " + (await res.text().catch(() => "")).slice(0, 200)); };
  const toObject = (key: string, res: Response, range?: { offset: number; length?: number }): S3Object => {
    const meta = metaIn(res.headers);
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    const body = res.body ?? new ReadableStream({ start(c) { c.close(); } });
    let used = false;
    const take = () => { if (used) throw new Error("body already read"); used = true; return res; };
    return {
      key, size: Number(total ?? res.headers.get("content-length") ?? 0), httpEtag: res.headers.get("etag") ?? undefined,
      uploaded: res.headers.get("last-modified") ? new Date(res.headers.get("last-modified")!) : undefined,
      customMetadata: meta, httpMetadata: { contentType: res.headers.get("content-type") ?? undefined }, range,
      get body() { return take().body ?? body; },
      arrayBuffer: () => take().arrayBuffer(),
      text: () => take().text(),
    };
  };
  return {
    kind: "s3",
    async get(key, options) {
      const range = rangeHeader((options as { range?: unknown } | undefined)?.range);
      const res = await send("GET", objectUrl(key), range ? { range } : {});
      if (res.status === 404) { await res.body?.cancel(); return null; }
      if (!res.ok) return fail("get", res);
      return toObject(key, res, (options as { range?: { offset: number; length?: number } } | undefined)?.range) as never;
    },
    async head(key) {
      const res = await send("HEAD", objectUrl(key));
      if (res.status === 404) return null;
      if (!res.ok) return fail("head", res);
      return { key, size: Number(res.headers.get("content-length") ?? 0), customMetadata: metaIn(res.headers), httpEtag: res.headers.get("etag") ?? undefined } as never;
    },
    async put(key, value, options) {
      const opts = (options ?? {}) as { httpMetadata?: { contentType?: string }; customMetadata?: Meta };
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : typeof value === "string" ? enc.encode(value) : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      const res = await send("PUT", objectUrl(key), { "content-type": opts.httpMetadata?.contentType ?? "application/octet-stream", ...metaOut(opts.customMetadata) }, bytes);
      if (!res.ok) return fail("put", res);
      return { key, size: bytes.byteLength, httpEtag: res.headers.get("etag") ?? undefined };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const res = await send("DELETE", objectUrl(key));
        if (!res.ok && res.status !== 404) await fail("delete", res);
      }
    },
    async list(options = {}) {
      const url = new URL(base);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("max-keys", String(Math.min(options.limit ?? 1000, 1000)));
      if (options.prefix) url.searchParams.set("prefix", options.prefix);
      if (options.cursor) url.searchParams.set("continuation-token", options.cursor);
      const res = await send("GET", url.toString());
      if (!res.ok) return fail("list", res);
      const xml = await res.text();
      const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({ key: xmlText(m[1], "Key")[0], size: Number(xmlText(m[1], "Size")[0] ?? 0), uploaded: xmlText(m[1], "LastModified")[0] ? new Date(xmlText(m[1], "LastModified")[0]) : undefined, etag: xmlText(m[1], "ETag")[0] }));
      const truncated = xmlText(xml, "IsTruncated")[0] === "true";
      return { objects, truncated, cursor: truncated ? xmlText(xml, "NextContinuationToken")[0] : undefined };
    },
  };
}

// While MEDIA_WRITES = "paused", reads go on and every write answers with this error (the app shows its usual
// "could not save" message and nothing is lost, because nothing was written).
export const WRITES_PAUSED = "acard storage writes are paused for a move (MEDIA_WRITES=paused)";
export function readOnly(bucket: R2Like): R2Like {
  const stop = async () => { throw new Error(WRITES_PAUSED); };
  return { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), list: bucket.list.bind(bucket), put: stop, delete: stop };
}

export type BucketEnv = {
  MEDIA_R2?: unknown;
  MEDIA_STORE?: string;
  MEDIA_WRITES?: string;
  MEDIA_S3_ENDPOINT?: string;
  MEDIA_S3_REGION?: string;
  MEDIA_S3_BUCKET?: string;
  MEDIA_S3_ACCESS_KEY_ID?: string;
  MEDIA_S3_SECRET_ACCESS_KEY?: string;
};

export function mediaBucket(env: BucketEnv): R2Like | undefined {
  let bucket: R2Like | undefined;
  if (env.MEDIA_STORE === "s3") {
    const { MEDIA_S3_ENDPOINT: endpoint, MEDIA_S3_REGION: region, MEDIA_S3_BUCKET: name, MEDIA_S3_ACCESS_KEY_ID: id, MEDIA_S3_SECRET_ACCESS_KEY: secret } = env;
    // A half-set switch must not fall back to R2 silently: the app would write to the old store after the move.
    if (!endpoint || !region || !name || !id || !secret) throw new Error("MEDIA_STORE=s3 needs MEDIA_S3_ENDPOINT, _REGION, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY");
    bucket = s3Bucket({ endpoint, region, bucket: name, accessKeyId: id, secretAccessKey: secret });
  } else bucket = env.MEDIA_R2 as R2Like | undefined;
  return bucket && env.MEDIA_WRITES === "paused" ? readOnly(bucket) : bucket;
}

// Every request starts here (gate/agent-entry.ts fetchResponse), so MEDIA_R2 below this point is whichever bucket the
// env chose. With nothing set it returns the same env object, unchanged.
export function withMediaBucket<E extends BucketEnv>(env: E): E {
  if ((env.MEDIA_STORE ?? "r2") === "r2" && env.MEDIA_WRITES !== "paused") return env;
  return { ...env, MEDIA_R2: mediaBucket(env) };
}
