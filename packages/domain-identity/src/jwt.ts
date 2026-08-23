import { jwtVerify, SignJWT } from "jose";
import { UnauthorizedError } from "@app/shared";
import type { RoleName } from "@app/db";

export interface AccessTokenRoleClaim {
  role: RoleName;
  /** Present only when the role assignment is scoped to one clinic. */
  clinicId?: string;
  /** Present only when the role assignment is scoped to one doctor (a DOCTOR acting on themself). */
  doctorId?: string;
}

export interface AccessTokenPayload {
  sub: string;
  tenantId: string | null;
  roles: AccessTokenRoleClaim[];
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  ttlMinutes: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ tenantId: payload.tenantId, roles: payload.roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(key);
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenPayload> {
  const key = new TextEncoder().encode(secret);
  try {
    const { payload } = await jwtVerify(token, key);
    if (typeof payload["sub"] !== "string") throw new Error("missing sub");
    return {
      sub: payload["sub"],
      tenantId: (payload["tenantId"] as string | null) ?? null,
      roles: (payload["roles"] as AccessTokenRoleClaim[] | undefined) ?? [],
    };
  } catch {
    throw new UnauthorizedError("Invalid or expired access token.");
  }
}
