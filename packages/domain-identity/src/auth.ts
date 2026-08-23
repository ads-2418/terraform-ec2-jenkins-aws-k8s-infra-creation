import type { PrismaClient } from "@app/db";
import { withPlatformContext, withTenantContext } from "@app/db";
import { UnauthorizedError, generateSecret, hashPassword, hashSecret, verifyPassword } from "@app/shared";
import { signAccessToken, type AccessTokenRoleClaim } from "./jwt.js";

export interface AuthConfig {
  accessSecret: string;
  accessTtlMinutes: number;
  refreshTtlDays: number;
}

export interface LoginInput {
  tenantSlug: string;
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginOutput extends AuthTokens {
  user: { id: string; email: string };
}

// Computed once and reused so a login attempt against a nonexistent
// tenant/email takes roughly the same time as one against a real user with
// a wrong password - otherwise response latency itself leaks which
// tenant/email combinations exist (a real, well-known enumeration
// side-channel, not a hypothetical one). docs/SECURITY.md §1.
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("timing-safety-dummy-password-do-not-use");
  return dummyHashPromise;
}

function roleClaimsFromAssignments(
  assignments: Array<{ role: { name: AccessTokenRoleClaim["role"] }; clinicId: string | null; doctorId: string | null }>,
): AccessTokenRoleClaim[] {
  return assignments.map((ra) => ({
    role: ra.role.name,
    clinicId: ra.clinicId ?? undefined,
    doctorId: ra.doctorId ?? undefined,
  }));
}

export async function login(
  prisma: PrismaClient,
  config: AuthConfig,
  input: LoginInput,
): Promise<LoginOutput> {
  const tenant = await prisma.tenant.findUnique({ where: { slug: input.tenantSlug } });

  if (!tenant || tenant.status !== "ACTIVE") {
    await verifyPassword(await getDummyHash(), input.password);
    throw new UnauthorizedError("Invalid credentials.");
  }

  return withTenantContext(prisma, tenant.id, async (tx) => {
    const user = await tx.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
      include: { roleAssignments: { include: { role: true } } },
    });

    if (!user || user.status !== "ACTIVE") {
      await verifyPassword(await getDummyHash(), input.password);
      throw new UnauthorizedError("Invalid credentials.");
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) throw new UnauthorizedError("Invalid credentials.");

    const roles = roleClaimsFromAssignments(user.roleAssignments);
    const accessToken = await signAccessToken(
      { sub: user.id, tenantId: tenant.id, roles },
      config.accessSecret,
      config.accessTtlMinutes,
    );

    const { raw, hashedKey } = generateSecret("rt");
    await tx.refreshToken.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: hashedKey,
        expiresAt: new Date(Date.now() + config.refreshTtlDays * 86_400_000),
      },
    });

    return { accessToken, refreshToken: raw, user: { id: user.id, email: user.email } };
  });
}

/**
 * Rotates the refresh token on every use (old one revoked, pointing at the
 * new one) - docs/SECURITY.md §1. The lookup-by-hash happens under a
 * platform context (refresh_tokens' bootstrap_lookup RLS policy,
 * docs/DATABASE.md's RLS migration), since the caller's tenant isn't known
 * until the token itself is resolved.
 */
export async function refreshAccessToken(
  prisma: PrismaClient,
  config: AuthConfig,
  input: { refreshToken: string },
): Promise<AuthTokens> {
  const tokenHash = hashSecret(input.refreshToken);
  const existing = await withPlatformContext(prisma, (tx) =>
    tx.refreshToken.findUnique({ where: { tokenHash } }),
  );

  if (!existing || existing.revokedAt || existing.expiresAt <= new Date()) {
    throw new UnauthorizedError("Invalid refresh token.");
  }

  const rotate: Parameters<typeof withPlatformContext<AuthTokens>>[1] = async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: existing.userId },
      include: { roleAssignments: { include: { role: true } } },
    });
    if (!user || user.status !== "ACTIVE") throw new UnauthorizedError("Invalid refresh token.");

    const roles = roleClaimsFromAssignments(user.roleAssignments);
    const accessToken = await signAccessToken(
      { sub: user.id, tenantId: existing.tenantId, roles },
      config.accessSecret,
      config.accessTtlMinutes,
    );

    const { raw, hashedKey } = generateSecret("rt");
    const newToken = await tx.refreshToken.create({
      data: {
        tenantId: existing.tenantId,
        userId: user.id,
        tokenHash: hashedKey,
        expiresAt: new Date(Date.now() + config.refreshTtlDays * 86_400_000),
      },
    });
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedBy: newToken.id },
    });

    return { accessToken, refreshToken: raw };
  };

  // A platform admin's refresh token has tenantId === null, so it can only
  // ever satisfy the "no tenant context" RLS branch - passing it to
  // withTenantContext would fail UUID validation. Two call shapes, same
  // callback, chosen by which context this specific token belongs to.
  return existing.tenantId
    ? withTenantContext(prisma, existing.tenantId, rotate)
    : withPlatformContext(prisma, rotate);
}

export async function logout(prisma: PrismaClient, input: { refreshToken: string }): Promise<void> {
  const tokenHash = hashSecret(input.refreshToken);
  const existing = await withPlatformContext(prisma, (tx) =>
    tx.refreshToken.findUnique({ where: { tokenHash } }),
  );
  if (!existing || existing.revokedAt) return;

  const revoke: Parameters<typeof withPlatformContext<unknown>>[1] = (tx) =>
    tx.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });

  if (existing.tenantId) {
    await withTenantContext(prisma, existing.tenantId, revoke);
  } else {
    await withPlatformContext(prisma, revoke);
  }
}
