import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@app/db";
import { resolveApiKey, verifyAccessToken } from "@app/domain-identity";
import { UnauthorizedError } from "@app/shared";
import type { AuthConfig } from "@app/domain-identity";

/**
 * Resolves the caller's identity from the Authorization header - either an
 * API key (WordPress plugin, `sk_live_...`) or a JWT access token
 * (dashboard). Runs on every request; routes that require auth call
 * `requireAuth`/`requireApiKeyOrUser` afterward, since some endpoints
 * (login, the OAuth/webhook callbacks in later phases) are intentionally
 * unauthenticated. docs/SECURITY.md §1.
 */
export function createAuthPreHandler(prisma: PrismaClient, authConfig: AuthConfig) {
  return async function resolveAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers["authorization"];
    if (!header?.startsWith("Bearer ")) return;

    const token = header.slice("Bearer ".length);

    if (token.startsWith("sk_live_")) {
      const apiKey = await resolveApiKey(prisma, token);
      if (apiKey) {
        request.auth = { kind: "API_KEY", tenantId: apiKey.tenantId, apiKeyId: apiKey.id };
      }
      return;
    }

    try {
      const payload = await verifyAccessToken(token, authConfig.accessSecret);
      request.auth = payload.tenantId
        ? { kind: "USER", tenantId: payload.tenantId, userId: payload.sub, roles: payload.roles }
        : { kind: "PLATFORM_USER", tenantId: null, userId: payload.sub, roles: payload.roles };
    } catch {
      // Invalid/expired token: leave request.auth unset: requireAuth()
      // below turns that into a clean 401 rather than this middleware
      // itself deciding whether the route needs auth.
    }
  };
}

export function requireAuth(request: FastifyRequest): NonNullable<FastifyRequest["auth"]> {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

/** Most tenant-scoped routes: either auth kind is fine, but must resolve to a real tenant. */
export function requireTenantAuth(
  request: FastifyRequest,
): Extract<NonNullable<FastifyRequest["auth"]>, { tenantId: string }> {
  const auth = requireAuth(request);
  if (auth.tenantId === null) throw new UnauthorizedError();
  return auth as Extract<NonNullable<FastifyRequest["auth"]>, { tenantId: string }>;
}

/** Dashboard-only routes (RBAC actions) - an API key has no roles to check. */
export function requireUserAuth(
  request: FastifyRequest,
): Extract<NonNullable<FastifyRequest["auth"]>, { kind: "USER" | "PLATFORM_USER" }> {
  const auth = requireAuth(request);
  if (auth.kind === "API_KEY") throw new UnauthorizedError();
  return auth;
}
