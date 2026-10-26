// Required consents for the WAITLIST form and account sign-up (#166). The browser sends the boxes it ticked; the Worker
// checks them and writes the record (migration 041 consent_records, service role only) with the notice version it
// serves, so a client can never choose the version or skip an item.
export const CONSENT_VERSION = "2026-10-24";

export const CONSENT_ITEMS = {
  waitlist: ["privacy", "overseas"],
  signup: ["terms", "privacy", "overseas"],
} as const;

export type ConsentSource = keyof typeof CONSENT_ITEMS;

export const hasConsent = (source: ConsentSource, value: unknown) =>
  Array.isArray(value) && CONSENT_ITEMS[source].every((item) => value.includes(item));

type ConsentEnv = { readonly SUPABASE_URL?: string; readonly SUPABASE_SERVICE_ROLE_KEY?: string };

const headers = (env: ConsentEnv) => {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
};

export async function recordConsent(env: ConsentEnv, email: string, source: ConsentSource): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/consent_records`, {
    method: "POST",
    headers: { ...headers(env), prefer: "return=minimal" },
    body: JSON.stringify({ email, source, doc_version: CONSENT_VERSION, items: [...CONSENT_ITEMS[source]] }),
  });
  if (!res.ok) throw new Error(`consent_records ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Account deletion (#170): the account's consent rows stay one year as proof of consent (privacy policy 1번 표), counted
// from now; migration 043 consent_purge deletes them after that.
export async function markConsentsDeleted(env: ConsentEnv, email: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/consent_records?email=eq.${encodeURIComponent(email.trim().toLowerCase())}`, {
    method: "PATCH",
    headers: { ...headers(env), prefer: "return=minimal" },
    body: JSON.stringify({ account_deleted_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`consent_records mark ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Daily purge (#170): the acard-workspace cron calls POST /__consent/purge every 15 minutes and the first call of a UTC day
// runs consent_purge (043). CONSENT_PURGE="on" deletes up to CONSENT_PURGE_LIMIT due rows; anything else is a dry run that
// only counts them. Every run is written to admin_audit (action consent.purge) so the count can be read back.
export const CONSENT_PURGE_LIMIT = 200;
type PurgeEnv = ConsentEnv & {
  readonly CONSENT_PURGE?: string;
  readonly OUTBOX?: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: unknown): Promise<void> };
};
export async function purgeConsents(env: PurgeEnv, now = Date.now()): Promise<{ skipped: true } | { due: number; deleted: number; dry: boolean; limit: number }> {
  const dayKey = "consent-purge:" + new Date(now).toISOString().slice(0, 10);
  if (env.OUTBOX && (await env.OUTBOX.get(dayKey))) return { skipped: true };
  const dry = env.CONSENT_PURGE !== "on";
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/consent_purge`, { method: "POST", headers: headers(env), body: JSON.stringify({ p_limit: CONSENT_PURGE_LIMIT, p_dry: dry }) });
  if (!res.ok) throw new Error(`consent_purge ${res.status} ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { due: number; deleted: number; dry: boolean; limit: number };
  const audit = await fetch(`${env.SUPABASE_URL}/rest/v1/admin_audit`, { method: "POST", headers: { ...headers(env), prefer: "return=minimal" }, body: JSON.stringify({ action: "consent.purge", target: dry ? "dry" : "delete", detail: out }) });
  if (!audit.ok) throw new Error(`admin_audit ${audit.status}`);
  await env.OUTBOX?.put(dayKey, JSON.stringify(out), { expirationTtl: 60 * 60 * 48 });
  return out;
}

export async function hasSignupConsent(env: ConsentEnv, email: string): Promise<boolean> {
  const q = `email=eq.${encodeURIComponent(email)}&source=eq.signup&doc_version=eq.${CONSENT_VERSION}&select=id&limit=1`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/consent_records?${q}`, { headers: headers(env) });
  if (!res.ok) throw new Error(`consent_records ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}
