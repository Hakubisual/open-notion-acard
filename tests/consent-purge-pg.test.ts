// consent_records purge (#170, migration 043) on a real Postgres (PGlite): only rows marked by an account deletion more
// than a year ago whose email has no auth user left are due; a live account's rows never are, dry runs only count, and
// one run deletes at most its limit.
import { beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const migration = (name: string) => readFileSync(join(ROOT, "migrations/supabase", name), "utf8");
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);`);
  await db.exec(migration("041-acard-consent-records.sql"));
  await db.exec(migration("043-acard-consent-purge.sql"));
  await db.exec(migration("043-acard-consent-purge.sql"));
});

async function seed(rows: { email: string; deleted?: string | null }[], liveEmails: string[]) {
  await db.exec("DELETE FROM public.consent_records; DELETE FROM auth.users;");
  for (const email of liveEmails) await db.query("INSERT INTO auth.users (email) VALUES ($1)", [email]);
  for (const r of rows) {
    await db.query(
      "INSERT INTO public.consent_records (email, source, doc_version, items, account_deleted_at) VALUES ($1, 'signup', '2026-10-24', ARRAY['terms','privacy','overseas'], $2::timestamptz)",
      [r.email, r.deleted ?? null],
    );
  }
}
const purge = async (limit: number, dry: boolean) => (await db.query<{ r: any }>("SELECT public.consent_purge($1, $2) AS r", [limit, dry])).rows[0].r;
const left = async () => (await db.query<{ email: string }>("SELECT email FROM public.consent_records ORDER BY id")).rows.map((r) => r.email);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

test("a live account's rows are never due, even when marked long ago or under another letter case", async () => {
  await seed([
    { email: "live@example.test", deleted: ago(800) },
    { email: "Live2@Example.test", deleted: ago(800) },
    { email: "live@example.test" },
  ], ["live@example.test", "live2@example.test"]);
  expect(await purge(1000, false)).toMatchObject({ due: 0, deleted: 0, dry: false });
  expect((await left()).length).toBe(3);
});

test("only rows deleted more than a year ago go; unmarked rows (waitlist, no account deletion) and recent deletions stay", async () => {
  await seed([
    { email: "gone-old@example.test", deleted: ago(366) },
    { email: "gone-recent@example.test", deleted: ago(300) },
    { email: "waitlist-only@example.test" },
  ], []);
  expect(await purge(1000, false)).toMatchObject({ due: 1, deleted: 1 });
  expect(await left()).toEqual(["gone-recent@example.test", "waitlist-only@example.test"]);
});

test("dry run counts the due rows and deletes nothing", async () => {
  await seed([{ email: "a@example.test", deleted: ago(400) }, { email: "b@example.test", deleted: ago(400) }], []);
  expect(await purge(1000, true)).toEqual({ due: 2, deleted: 0, dry: true, limit: 1000 });
  expect((await left()).length).toBe(2);
});

test("one run deletes at most its limit, oldest first, and the limit is clamped to 1..1000", async () => {
  await seed([
    { email: "c@example.test", deleted: ago(500) },
    { email: "d@example.test", deleted: ago(700) },
    { email: "e@example.test", deleted: ago(600) },
  ], []);
  expect(await purge(2, false)).toMatchObject({ due: 3, deleted: 2, limit: 2 });
  expect(await left()).toEqual(["c@example.test"]);
  expect(await purge(0, true)).toMatchObject({ limit: 1 });
  expect(await purge(5000, true)).toMatchObject({ limit: 1000 });
});

test("anon and authenticated cannot run the purge or touch the table; service_role can", async () => {
  const can = async (role: string, what: string) => (await db.query<{ ok: boolean }>(`SELECT ${what} AS ok`, [role])).rows[0].ok;
  for (const role of ["anon", "authenticated"]) {
    expect(await can(role, "has_function_privilege($1, 'public.consent_purge(int, boolean)', 'EXECUTE')")).toBe(false);
    expect(await can(role, "has_table_privilege($1, 'public.consent_records', 'SELECT')")).toBe(false);
    expect(await can(role, "has_column_privilege($1, 'public.consent_records', 'account_deleted_at', 'UPDATE')")).toBe(false);
  }
  expect(await can("service_role", "has_function_privilege($1, 'public.consent_purge(int, boolean)', 'EXECUTE')")).toBe(true);
  expect(await can("service_role", "has_column_privilege($1, 'public.consent_records', 'account_deleted_at', 'UPDATE')")).toBe(true);
});


test("the Worker's daily purge is a dry run unless CONSENT_PURGE=on, runs once per UTC day and writes admin_audit", async () => {
  const { purgeConsents, CONSENT_PURGE_LIMIT } = await import("../gate/consent");
  const realFetch = globalThis.fetch;
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, body });
    if (u.pathname === "/rest/v1/rpc/consent_purge") return Response.json({ due: 0, deleted: 0, dry: body.p_dry, limit: body.p_limit });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  try {
    const kv = new Map<string, string>();
    const OUTBOX = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } };
    const env = { SUPABASE_URL: "https://supa.test", SUPABASE_SERVICE_ROLE_KEY: "service", OUTBOX };
    const day = Date.parse("2026-10-26T03:00:00Z");
    expect(await purgeConsents(env, day)).toEqual({ due: 0, deleted: 0, dry: true, limit: CONSENT_PURGE_LIMIT });
    expect(await purgeConsents(env, day + 3600_000)).toEqual({ skipped: true });
    expect(calls.map((c) => c.path)).toEqual(["/rest/v1/rpc/consent_purge", "/rest/v1/admin_audit"]);
    expect(calls[1].body).toMatchObject({ action: "consent.purge", target: "dry", detail: { due: 0, dry: true } });
    expect(await purgeConsents({ ...env, CONSENT_PURGE: "on" }, day + 86_400_000)).toMatchObject({ dry: false });
  } finally { globalThis.fetch = realFetch; }
});
