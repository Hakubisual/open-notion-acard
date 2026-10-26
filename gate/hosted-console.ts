// Self-host edition: the hosted admin console (roles, AI registry, usage dashboard) is not included.
// Same exports as the hosted module so gate/agent-entry.ts compiles unchanged.
import { type Session, type TenancyEnv } from "./tenancy";

export type AdminEnv = TenancyEnv;
export type AdminDeps = { revokeGrants(userId: string): Promise<number>; revokeTokens(ws: string): Promise<number>; ctx?: unknown; cloud?: (api: string, actor: string) => Promise<Response | null>; storageAlertTest?: () => Promise<unknown>; storageUsage?: () => Promise<unknown> };
export const ADMIN_PATH = /(?!)/;
export async function roleOf(_env: AdminEnv, _userId: string): Promise<string | null> { return null; }
export async function isAdmin(_env: AdminEnv, _session: Session | null): Promise<boolean> { return false; }
export const suspendKey = (userId: string) => `suspended:${userId}`;
export async function isSuspended(_env: AdminEnv, _userId: string): Promise<boolean> { return false; }
export async function adminRoute(_request: Request, _env: AdminEnv, _url: URL, _session: Session | null, _deps: AdminDeps): Promise<Response> {
  return new Response("Not Found", { status: 404 });
}
export async function myUsage(_env: AdminEnv, _session: Session): Promise<Response> {
  return new Response(JSON.stringify({ usage: null }), { headers: { "content-type": "application/json; charset=utf-8" } });
}
