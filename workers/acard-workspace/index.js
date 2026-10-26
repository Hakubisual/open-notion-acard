import { DurableObject } from "cloudflare:workers";

// One SQLite Durable Object per signed-up workspace (not the owner, who stays on D1).
// The app talks to it through a D1-shaped adapter (gate/tenancy.ts), so app SQL runs unchanged
// but can only ever see this workspace's own database.

const WRITE = /^\s*(insert|update|delete|replace)\b/i;
const DAILY_WRITES = 5000;
const RECURRING_RETRY_MS = 5 * 60 * 1000;

// Repeating row templates (notion-parity C5): the site asks the workspace's own store to wake it at the earliest next run;
// the alarm calls back POST /__recurring/tick with the shared secret and re-arms with the time the site answers.
async function recurringTick(env, ws) {
  const res = await fetch(env.SITE_URL + "/__recurring/tick", {
    method: "POST",
    headers: { "content-type": "application/json", "x-recurring-tick": env.RECURRING_TICK_SECRET || "" },
    body: JSON.stringify({ ws }),
  });
  if (!res.ok) throw new Error("recurring tick " + res.status);
  return await res.json();
}

// Outgoing webhooks (gate/webhooks.ts): the instance named "global:webhooks" is woken at the earliest send time the site
// asks for and calls POST /__webhooks/tick, which sends what is due and answers the next time; the cron is the safety net.
const WEBHOOK_RETRY_MS = 60 * 1000;
async function webhookTick(env, cron) {
  const res = await fetch(env.SITE_URL + "/__webhooks/tick", {
    method: "POST",
    headers: { "content-type": "application/json", "x-recurring-tick": env.RECURRING_TICK_SECRET || "" },
    body: JSON.stringify({ cron: Boolean(cron) }),
  });
  if (!res.ok) throw new Error("webhook tick " + res.status);
  return await res.json();
}

// consent_records purge (#170, gate/consent.ts purgeConsents): the site runs it at most once per UTC day, so asking from
// every cron run only retries a day whose first call failed.
async function consentPurge(env) {
  const res = await fetch(env.SITE_URL + "/__consent/purge", { method: "POST", headers: { "x-recurring-tick": env.RECURRING_TICK_SECRET || "" } });
  if (!res.ok) throw new Error("consent purge " + res.status);
  return await res.json();
}

function clean(params) {
  return (params || []).map((value) => (value === undefined ? null : value === true ? 1 : value === false ? 0 : value));
}

export class WorkspaceStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.day = 0;
    this.writes = 0;
    this.hits = new Map();
  }

  count(sql) {
    if (!WRITE.test(sql)) return;
    const day = Math.floor(Date.now() / 86_400_000);
    if (day !== this.day) { this.day = day; this.writes = 0; }
    this.writes += 1;
    if (this.writes > DAILY_WRITES) throw new Error("QUOTA: 오늘 저장할 수 있는 양을 다 썼어요. 내일 다시 시도해 주세요.");
  }

  run(sql, params, mode) {
    this.count(sql);
    const rows = this.sql.exec(sql, ...clean(params)).toArray();
    if (mode === "all") return { results: rows, success: true, meta: {} };
    if (mode === "first") return rows[0] ?? null;
    const changes = Number(this.sql.exec("SELECT changes() AS c").one().c);
    return { results: rows, success: true, meta: { changes } };
  }

  async exec(sql, params, mode) {
    return this.run(sql, params, mode);
  }

  async batch(list) {
    return this.ctx.storage.transactionSync(() => list.map((item) => this.run(item.sql, item.params, "run")));
  }

  // Several statements in one round trip (gate/tenancy.ts d1Adapter). Each item runs in order and reports its own result,
  // so one failing statement fails only its caller, like separate exec/batch calls did.
  async pipe(items) {
    return items.map((item) => {
      try {
        const value = item.batch
          ? this.ctx.storage.transactionSync(() => item.batch.map((s) => this.run(s.sql, s.params, "run")))
          : this.run(item.sql, item.params, item.mode);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async stats() {
    const count = (table) => {
      try { return Number(this.sql.exec("SELECT count(*) AS n FROM " + table).one().n); } catch { return 0; }
    };
    return { pages: count("pages"), blocks: count("blocks"), db_rows: count("db_rows"), media: count("media"), agent_tokens: count("agent_tokens"), share_links: count("share_links"), bytes: this.ctx.storage.sql.databaseSize };
  }

  async wipe() {
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  async scheduleRecurring(ws, nextAt) {
    if (typeof ws !== "string" || !/^[0-9a-f]{32}$/.test(ws)) throw new Error("bad workspace");
    await this.ctx.storage.put("recurringWs", ws);
    if (Number.isFinite(nextAt)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, nextAt));
    else await this.ctx.storage.deleteAlarm();
    return { armed: Number.isFinite(nextAt) ? nextAt : null };
  }

  async armWebhooks(nextAt) {
    if (!Number.isFinite(nextAt)) return { armed: null };
    await this.ctx.storage.put("webhooks", true);
    const at = Math.max(Date.now() + 500, nextAt);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    return { armed: current === null || current > at ? at : current };
  }

  async alarm() {
    if (await this.ctx.storage.get("webhooks")) {
      let next;
      try {
        next = (await webhookTick(this.env, false)).next;
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + WEBHOOK_RETRY_MS);
        return;
      }
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 500, next));
      return;
    }
    const ws = await this.ctx.storage.get("recurringWs");
    if (!ws) return;
    let next;
    try {
      next = (await recurringTick(this.env, ws)).next;
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + RECURRING_RETRY_MS);
      return;
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }

  // The instance named "global:media" is not a workspace: it holds the byte total of every media original in R2 so
  // uploads stop before the R2 free tier (10 GB) is passed. Check-and-add happens in one call, and a Durable Object runs
  // one call at a time, so two uploads can never both take the last free bytes.
  mediaLedger() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS media_ledger (id INTEGER PRIMARY KEY CHECK (id = 1), used INTEGER NOT NULL, alerted INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("INSERT OR IGNORE INTO media_ledger (id, used, alerted) VALUES (1, 0, 0)");
    return this.sql.exec("SELECT used, alerted FROM media_ledger WHERE id = 1").one();
  }

  async mediaUsage(delta, cap) {
    const row = this.mediaLedger();
    const used = Number(row.used), change = Number(delta) || 0;
    if (change > 0 && Number.isFinite(cap) && used + change > cap) return { ok: false, used, alerted: Number(row.alerted) };
    const next = Math.max(0, used + change);
    this.sql.exec("UPDATE media_ledger SET used = ? WHERE id = 1", next);
    return { ok: true, used: next, alerted: Number(row.alerted) };
  }

  // Streamed uploads (gate/_worker.js uploadStream) hold their bytes under a lease named after the upload: reserve adds
  // them once (a repeated reserve for the same lease adds nothing), then exactly one of commit (the file was stored, the
  // bytes stay counted) or release (it was not, the bytes go back) settles it. A lease nobody settled (the request died
  // with its isolate) expires and is released by mediaSweep, from the next reserve or the 15-minute cron. A commit after
  // its lease was swept counts the stored bytes again, so the total always equals what is in R2.
  mediaLeases() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS media_leases (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires INTEGER NOT NULL)");
  }

  async mediaReserve(lease, bytes, cap, ttlMs) {
    this.mediaLeases();
    await this.mediaSweep();
    const held = this.sql.exec("SELECT bytes FROM media_leases WHERE id = ?", String(lease)).toArray()[0];
    const row = this.mediaLedger();
    if (held) return { ok: true, used: Number(row.used), alerted: Number(row.alerted) };
    const result = await this.mediaUsage(bytes, cap);
    if (result.ok) this.sql.exec("INSERT INTO media_leases (id, bytes, expires) VALUES (?, ?, ?)", String(lease), Math.max(0, Number(bytes) || 0), Date.now() + Number(ttlMs));
    return result;
  }

  async mediaCommit(lease, bytes) {
    this.mediaLeases();
    const held = this.sql.exec("SELECT bytes FROM media_leases WHERE id = ?", String(lease)).toArray()[0];
    if (held) { this.sql.exec("DELETE FROM media_leases WHERE id = ?", String(lease)); return { ok: true, recounted: false }; }
    await this.mediaUsage(Math.max(0, Number(bytes) || 0), Infinity);
    return { ok: true, recounted: true };
  }

  async mediaRelease(lease) {
    this.mediaLeases();
    const held = this.sql.exec("SELECT bytes FROM media_leases WHERE id = ?", String(lease)).toArray()[0];
    if (!held) return { ok: true, released: 0 };
    this.sql.exec("DELETE FROM media_leases WHERE id = ?", String(lease));
    await this.mediaUsage(-Number(held.bytes), Infinity);
    return { ok: true, released: Number(held.bytes) };
  }

  async mediaSweep(now = Date.now()) {
    this.mediaLeases();
    const expired = this.sql.exec("SELECT id, bytes FROM media_leases WHERE expires <= ?", now).toArray();
    let released = 0;
    for (const lease of expired) {
      this.sql.exec("DELETE FROM media_leases WHERE id = ?", lease.id);
      released += Number(lease.bytes);
    }
    if (released) await this.mediaUsage(-released, Infinity);
    const open = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM media_leases").one();
    return { swept: expired.length, released, open: Number(open.n), openBytes: Number(open.bytes) };
  }

  async mediaSetUsage(bytes) {
    this.mediaLedger();
    this.sql.exec("UPDATE media_ledger SET used = ? WHERE id = 1", Math.max(0, Number(bytes) || 0));
    return this.mediaLedger();
  }

  async mediaMarkAlerted(level) {
    const row = this.mediaLedger();
    if (Number(row.alerted) >= level) return false;
    this.sql.exec("UPDATE media_ledger SET alerted = ? WHERE id = 1", level);
    return true;
  }

  // Upload compressions this calendar month (UTC), one row per month on global:media. Each is one unique Cloudflare Images
  // transformation; past the cap the app stores the original instead (gate/_worker.js compressUpload).
  async compressSlot(cap) {
    this.sql.exec("CREATE TABLE IF NOT EXISTS compress_month (month TEXT PRIMARY KEY, used INTEGER NOT NULL)");
    const month = new Date().toISOString().slice(0, 7);
    const row = this.sql.exec("SELECT used FROM compress_month WHERE month = ?", month).toArray()[0];
    const used = row ? Number(row.used) : 0;
    if (used >= Number(cap)) return false;
    this.sql.exec("INSERT INTO compress_month (month, used) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET used = used + 1", month);
    return true;
  }

  // Agent write limits (gate/agent-write-limit.ts), one instance per workspace ("agent-writes:<ws>"): per-token counters
  // for the current minute and the current day (UTC), kept in memory only so counting never adds a database write. A
  // restart forgets the counts, which only ever lets an agent write more, never less. Returns which limit was hit and when
  // the window ends.
  async agentWrite(token, perMinute, perDay) {
    const now = Date.now();
    const minute = Math.floor(now / 60_000), day = Math.floor(now / 86_400_000);
    if (!this.agentWrites || this.agentWrites.day !== day) this.agentWrites = { day, tokens: new Map() };
    let entry = this.agentWrites.tokens.get(token);
    if (!entry) { entry = { minute, inMinute: 0, inDay: 0 }; this.agentWrites.tokens.set(token, entry); }
    if (entry.minute !== minute) { entry.minute = minute; entry.inMinute = 0; }
    if (Number.isFinite(perDay) && entry.inDay >= perDay) return { ok: false, limit: "day", max: perDay, retryAfter: Math.ceil(((day + 1) * 86_400_000 - now) / 1000) };
    if (Number.isFinite(perMinute) && entry.inMinute >= perMinute) return { ok: false, limit: "minute", max: perMinute, retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)) };
    entry.inMinute += 1;
    entry.inDay += 1;
    return { ok: true, minute: entry.inMinute, day: entry.inDay };
  }

  async hit(key, limit, periodSeconds) {
    const now = Date.now();
    const window = Math.floor(now / (periodSeconds * 1000));
    const entry = this.hits.get(key);
    if (!entry || entry.window !== window) { this.hits.set(key, { window, n: 1 }); }
    else entry.n += 1;
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.window !== window) this.hits.delete(k);
    return (this.hits.get(key)?.n ?? 0) <= limit;
  }
}

export default {
  fetch() {
    return new Response("acard-workspace has no public routes", { status: 404 });
  },
  // The owner workspace lives on the main database, not in a store, so a 15-minute cron runs its repeating templates.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(recurringTick(env, "owner").catch((error) => console.error("owner recurring tick failed", error instanceof Error ? error.message : String(error))));
    ctx.waitUntil(webhookTick(env, true).then((out) => {
      if (!Number.isFinite(out.next)) return;
      return env.WORKSPACE.get(env.WORKSPACE.idFromName("global:webhooks")).armWebhooks(out.next);
    }).catch((error) => console.error("webhook tick failed", error instanceof Error ? error.message : String(error))));
    ctx.waitUntil(consentPurge(env).catch((error) => console.error("consent purge failed", error instanceof Error ? error.message : String(error))));
    ctx.waitUntil(env.WORKSPACE.get(env.WORKSPACE.idFromName("global:media")).mediaSweep().catch((error) => console.error("media lease sweep failed", error instanceof Error ? error.message : String(error))));
  },
};
