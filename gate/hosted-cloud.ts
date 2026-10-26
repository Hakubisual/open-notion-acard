// Self-host edition: the hosted web-publish / cloud-backup service is not included (docs/local-first.md 12장).
// Same exports as the hosted module so gate/agent-entry.ts compiles unchanged; every route answers 404.
import type { ArchiveDb } from "./archive";

export type CloudEnv = Record<string, unknown>;
export type CloudHost = {
  scoped(ws: string): { DB: ArchiveDb } & Record<string, unknown>;
  core(request: Request, env: unknown): Promise<Response>;
  prepare(env: unknown): Promise<unknown>;
};
const none = () => new Response(JSON.stringify({ error: "This server does not offer web publishing or cloud backup." }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });

export const CLOUD_V1 = /^\/api\/v1\/cloud(?:\/|$)/;
// Hosted per-account flags have no rows in the self-host edition.
export async function sb(_env: unknown, _path: string, _init: unknown = {}): Promise<unknown> { return null; }
export async function cloudV1(_request: Request, _env: CloudEnv, _host: CloudHost, _principal: unknown, _userId: string, _origin: string): Promise<Response> { return none(); }
// Self-host accounts keep nothing on a hosted service, so account deletion has nothing extra to remove.
export async function deleteHostedData(_env: unknown, _userId: string, _email: string | null): Promise<{ published: number; backups: number; synced: number; rows: number }> { return { published: 0, backups: 0, synced: 0, rows: 0 }; }
export async function cookieExport(_env: unknown, _host: CloudHost): Promise<Response> { return none(); }
// Self-host accounts have no hosted media tiers or waitlist pass; the editor's own quota (gate/_worker.js) applies.
export async function mediaPlanOf(_env: CloudEnv, _userId: string): Promise<{ tier: "free"; quota: number; passUntil: null }> { return { tier: "free", quota: Infinity, passUntil: null }; }
export async function claimCompPass(_env: CloudEnv, _userId: string): Promise<{ result: string }> { return { result: "off" }; }
export async function planOf(_env: CloudEnv, _userId: string): Promise<Response> { return none(); }
export async function isPublishWorkspace(_env: CloudEnv, _ws: string): Promise<boolean> { return false; }
export async function publicGate(_env: CloudEnv, _ws: string): Promise<Response | null> { return null; }
export function withReportFooter(response: Response, _pageUrl: string): Response { return response; }
export async function reportRoute(_request: Request, _env: CloudEnv, _url: URL): Promise<Response> { return none(); }
export async function cloudAdmin(_request: Request, _env: CloudEnv, _host: CloudHost, _api: string, _actor: string, _origin: string): Promise<Response | null> { return null; }
