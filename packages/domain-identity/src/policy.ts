import { ForbiddenError } from "@app/shared";
import type { RoleName } from "@app/db";
import type { AccessTokenRoleClaim } from "./jwt.js";

/**
 * Two independent checks, per docs/SECURITY.md §2: (1) does any of the
 * caller's roles grant this action at all (`can`/`assertCan`), and
 * (2) is this specific role assignment scoped to the target resource
 * (`isAuthorizedForResource`) - a DOCTOR role scoped to doctorId=X can
 * write appointment data, but only for doctor X, never doctor Y. Tenant
 * scoping itself is a third, independent layer enforced by RLS
 * (docs/DATABASE.md §1), not by this module.
 */
export type Action =
  | "tenant:manage"
  | "clinic:write"
  | "clinic:read"
  | "doctor:write"
  | "doctor:read"
  | "staff:write"
  | "staff:read"
  | "service:write"
  | "service:read"
  | "availability:write"
  | "appointment:write"
  | "appointment:read"
  | "audit:read"
  | "api_key:write"
  | "api_key:read";

const ALL_TENANT_ACTIONS: Action[] = [
  "clinic:write",
  "clinic:read",
  "doctor:write",
  "doctor:read",
  "staff:write",
  "staff:read",
  "service:write",
  "service:read",
  "availability:write",
  "appointment:write",
  "appointment:read",
  "audit:read",
  "api_key:write",
  "api_key:read",
];

const ROLE_PERMISSIONS: Record<RoleName, Action[]> = {
  PLATFORM_ADMIN: ["tenant:manage", ...ALL_TENANT_ACTIONS],
  TENANT_ADMIN: ALL_TENANT_ACTIONS,
  CLINIC_MANAGER: [
    "clinic:read",
    "doctor:write",
    "doctor:read",
    "staff:write",
    "staff:read",
    "service:write",
    "service:read",
    "availability:write",
    "appointment:write",
    "appointment:read",
    "audit:read",
  ],
  DOCTOR: [
    "clinic:read",
    "doctor:read",
    "service:read",
    "availability:write",
    "appointment:write",
    "appointment:read",
  ],
  STAFF: ["clinic:read", "doctor:read", "service:read", "appointment:write", "appointment:read"],
};

export function can(roles: AccessTokenRoleClaim[], action: Action): boolean {
  return roles.some((r) => ROLE_PERMISSIONS[r.role]?.includes(action));
}

export function assertCan(roles: AccessTokenRoleClaim[], action: Action): void {
  if (!can(roles, action)) throw new ForbiddenError();
}

/**
 * Resource-level scoping: an unscoped role claim (no clinicId/doctorId -
 * TENANT_ADMIN, PLATFORM_ADMIN) authorizes any target within the tenant.
 * A claim scoped to a clinic or doctor only authorizes matching targets.
 */
export function isAuthorizedForResource(
  roles: AccessTokenRoleClaim[],
  action: Action,
  target: { clinicId?: string; doctorId?: string },
): boolean {
  return roles.some((r) => {
    if (!ROLE_PERMISSIONS[r.role]?.includes(action)) return false;
    if (r.doctorId && r.doctorId !== target.doctorId) return false;
    if (r.clinicId && target.clinicId && r.clinicId !== target.clinicId) return false;
    return true;
  });
}

export function assertAuthorizedForResource(
  roles: AccessTokenRoleClaim[],
  action: Action,
  target: { clinicId?: string; doctorId?: string },
): void {
  if (!isAuthorizedForResource(roles, action, target)) throw new ForbiddenError();
}
