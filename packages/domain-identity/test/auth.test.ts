import { beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError } from "@app/shared";
import { login, logout, refreshAccessToken, verifyAccessToken } from "../src/index.js";
import { createUserFixture, DEV_PASSWORD, prisma, resetDb } from "./fixtures.js";

const config = { accessSecret: "test-access-secret-at-least-16-chars", accessTtlMinutes: 15, refreshTtlDays: 30 };

describe("auth: login/refresh/logout", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("logs in with correct credentials and issues a valid access token", async () => {
    const { tenant, user } = await createUserFixture("STAFF");

    const result = await login(prisma, config, {
      tenantSlug: tenant.slug,
      email: user.email,
      password: DEV_PASSWORD,
    });

    expect(result.user.id).toBe(user.id);
    const payload = await verifyAccessToken(result.accessToken, config.accessSecret);
    expect(payload.sub).toBe(user.id);
    expect(payload.tenantId).toBe(tenant.id);
    expect(payload.roles).toEqual([{ role: "STAFF" }]);
  });

  it("rejects the wrong password", async () => {
    const { tenant, user } = await createUserFixture("STAFF");
    await expect(
      login(prisma, config, { tenantSlug: tenant.slug, email: user.email, password: "wrong-password" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a nonexistent tenant slug", async () => {
    await expect(
      login(prisma, config, { tenantSlug: "does-not-exist", email: "a@b.test", password: "x" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a nonexistent email within a real tenant", async () => {
    const { tenant } = await createUserFixture("STAFF");
    await expect(
      login(prisma, config, { tenantSlug: tenant.slug, email: "nobody@example.test", password: "x" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rotates the refresh token and invalidates the old one", async () => {
    const { tenant, user } = await createUserFixture("DOCTOR");
    const { refreshToken } = await login(prisma, config, {
      tenantSlug: tenant.slug,
      email: user.email,
      password: DEV_PASSWORD,
    });

    const rotated = await refreshAccessToken(prisma, config, { refreshToken });
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // Old token is now revoked - reusing it must fail.
    await expect(refreshAccessToken(prisma, config, { refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // The new token works.
    const again = await refreshAccessToken(prisma, config, { refreshToken: rotated.refreshToken });
    expect(again.accessToken).toBeTruthy();
  });

  it("logout revokes the refresh token", async () => {
    const { tenant, user } = await createUserFixture("STAFF");
    const { refreshToken } = await login(prisma, config, {
      tenantSlug: tenant.slug,
      email: user.email,
      password: DEV_PASSWORD,
    });

    await logout(prisma, { refreshToken });

    await expect(refreshAccessToken(prisma, config, { refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("rejects a tampered access token", async () => {
    const { tenant, user } = await createUserFixture("STAFF");
    const { accessToken } = await login(prisma, config, {
      tenantSlug: tenant.slug,
      email: user.email,
      password: DEV_PASSWORD,
    });

    const tampered = accessToken.slice(0, -1) + (accessToken.endsWith("a") ? "b" : "a");
    await expect(verifyAccessToken(tampered, config.accessSecret)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
