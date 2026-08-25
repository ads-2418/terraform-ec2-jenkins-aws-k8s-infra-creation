import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@app/db";
import { login, logout, refreshAccessToken, type AuthConfig } from "@app/domain-identity";
import { writeAuditLog } from "@app/domain-audit";
import { ForbiddenError, UnauthorizedError } from "@app/shared";
import type { Redis } from "ioredis";
import { checkRateLimit } from "../rate-limit.js";
import { parseBody } from "../validate.js";

const loginSchema = z.object({
  // Omit for a platform-admin login (docs/API.md §4) - a user with no tenant.
  tenantSlug: z.string().min(1).optional(),
  email: z.string().email(),
  password: z.string().min(1),
});

const REFRESH_COOKIE = "refresh_token";
const CSRF_COOKIE = "csrf_token";

function setAuthCookies(reply: import("fastify").FastifyReply, refreshToken: string, csrfToken: string): void {
  const isProd = process.env["NODE_ENV"] === "production";
  reply.setCookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict",
    path: "/v1/auth",
  });
  // Deliberately NOT httpOnly: the double-submit CSRF pattern requires the
  // client's JS to read this and echo it back as a header - docs/SECURITY.md §10.
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: "strict",
    path: "/v1/auth",
  });
}

function assertCsrf(request: import("fastify").FastifyRequest): void {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw new ForbiddenError("Missing or invalid CSRF token.");
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; authConfig: AuthConfig; redis: Redis },
): void {
  app.post("/v1/auth/login", async (request, reply) => {
    await checkRateLimit(deps.redis, { scope: "IP", key: request.ip, limit: 10, windowSeconds: 60 });

    const body = parseBody(loginSchema, request.body);
    const result = await login(deps.prisma, deps.authConfig, body);

    const csrfToken = randomUUID();
    setAuthCookies(reply, result.refreshToken, csrfToken);

    await writeAuditLog(deps.prisma, {
      tenantId: null,
      actorType: "USER",
      actorId: result.user.id,
      action: "auth.login",
      resourceType: "user",
      resourceId: result.user.id,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      requestId: request.id,
    });

    reply.status(200).send({ accessToken: result.accessToken, user: result.user });
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    assertCsrf(request);
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (!refreshToken) throw new UnauthorizedError("No refresh token present.");

    const result = await refreshAccessToken(deps.prisma, deps.authConfig, { refreshToken });

    const csrfToken = randomUUID();
    setAuthCookies(reply, result.refreshToken, csrfToken);

    reply.status(200).send({ accessToken: result.accessToken });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (refreshToken) {
      await logout(deps.prisma, { refreshToken });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/v1/auth" });
    reply.clearCookie(CSRF_COOKIE, { path: "/v1/auth" });
    reply.status(204).send();
  });
}
