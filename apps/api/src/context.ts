import type { AccessTokenRoleClaim } from "@app/domain-identity";

export type AuthContext =
  | { kind: "USER"; tenantId: string; userId: string; roles: AccessTokenRoleClaim[] }
  | { kind: "PLATFORM_USER"; tenantId: null; userId: string; roles: AccessTokenRoleClaim[] }
  | { kind: "API_KEY"; tenantId: string; apiKeyId: string };

declare module "fastify" {
  interface FastifyRequest {
    // Fastify already provides `request.id` as the correlation id used in
    // docs/API.md §2's error.requestId - no need to duplicate it here.
    auth?: AuthContext;
  }
}
