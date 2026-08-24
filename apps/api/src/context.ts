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
    // Raw JSON body bytes, captured by app.ts's content-type parser -
    // needed to verify the WhatsApp webhook's X-Hub-Signature-256, which
    // is an HMAC over the exact bytes Meta sent, not the reserialized object.
    rawBody?: Buffer;
  }
}
