import type { AgentOperation, AgentPrincipal, FeatureMcpTool } from "../agents/mcp-tools";

export type CorePrincipal = AgentPrincipal & { readonly tokenId?: string; readonly agentRules?: boolean };

export type TokenRecord = {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly created: number;
  readonly lastUsed: number | null;
  readonly revoked: number | null;
};

export type CoreEnv = {
  readonly GATE_PASSWORD?: string;
  readonly GATE_SECRET?: string;
};

export declare const acardHost: {
  readonly mcpTools: readonly FeatureMcpTool[];
  principalFromToken(env: CoreEnv, token: string | null): Promise<CorePrincipal | null>;
  run(env: CoreEnv, principal: AgentPrincipal, operation: AgentOperation, input: Record<string, unknown>): Promise<unknown>;
  serveV1(request: Request, env: CoreEnv, principal: AgentPrincipal): Promise<Response>;
  agentStep(env: CoreEnv, session: string): Promise<{ status: number; done?: boolean; busy?: boolean; error?: string }>;
  recurringTick(env: CoreEnv, now: number): Promise<{ created: { template: string; occurrence: number; row: string }[]; next: number | null }>;
  templateMigrate(env: CoreEnv): Promise<{ before: { i: number; ii: number; iii: number }; after: { i: number; ii: number; iii: number }; changed: string[]; backup_table: string }>;
  hasHumanTicket(request: Request, env: CoreEnv): Promise<boolean>;
  trust<E extends CoreEnv>(env: E): E;
  tokenAdmin(env: CoreEnv): Promise<{
    list(): Promise<TokenRecord[]>;
    create(input: unknown): Promise<{ token: string; record: TokenRecord }>;
    revoke(id: string): Promise<boolean>;
    recordGrant(grant: { id: string; clientName: string; scopes: readonly string[] }): Promise<void>;
    listGrants(): Promise<{ id: string; clientName: string; scopes: string[]; created: number }[]>;
    markGrantRevoked(id: string): Promise<void>;
    grantRevoked(id: string): Promise<boolean>;
  }>;
  isAgentError(error: unknown): error is Error & { status: number };
  storageAlertTest(env: CoreEnv): Promise<{ used: number; to: string | null; ok: boolean; status?: number; id?: string | null; error?: string }>;
  storageUsage(env: CoreEnv): Promise<{ used: number; alerted: number; cap: number; alerts: number[]; uploading: { count: number; bytes: number } | null }>;
  challenge(message: string, next: string, status: number): Response;
  escapeHtml(text: string): string;
};

declare const core: { fetch(request: Request, env: CoreEnv, ctx?: unknown): Promise<Response> };
export default core;
