import { describe, expect, it } from "vitest";
import { can, isAuthorizedForResource } from "../src/policy.js";

describe("RBAC policy", () => {
  it("TENANT_ADMIN can write clinics; STAFF cannot", () => {
    expect(can([{ role: "TENANT_ADMIN" }], "clinic:write")).toBe(true);
    expect(can([{ role: "STAFF" }], "clinic:write")).toBe(false);
  });

  it("PLATFORM_ADMIN has tenant:manage; TENANT_ADMIN does not", () => {
    expect(can([{ role: "PLATFORM_ADMIN" }], "tenant:manage")).toBe(true);
    expect(can([{ role: "TENANT_ADMIN" }], "tenant:manage")).toBe(false);
  });

  it("a DOCTOR role scoped to doctorId=X can act on appointments for X but not Y", () => {
    const roles = [{ role: "DOCTOR" as const, doctorId: "doc-x" }];
    expect(isAuthorizedForResource(roles, "appointment:write", { doctorId: "doc-x" })).toBe(true);
    expect(isAuthorizedForResource(roles, "appointment:write", { doctorId: "doc-y" })).toBe(false);
  });

  it("an unscoped TENANT_ADMIN role authorizes any doctor in the tenant", () => {
    const roles = [{ role: "TENANT_ADMIN" as const }];
    expect(isAuthorizedForResource(roles, "appointment:write", { doctorId: "doc-x" })).toBe(true);
    expect(isAuthorizedForResource(roles, "appointment:write", { doctorId: "doc-y" })).toBe(true);
  });

  it("a CLINIC_MANAGER scoped to clinicId=A cannot act on clinic B's resources", () => {
    const roles = [{ role: "CLINIC_MANAGER" as const, clinicId: "clinic-a" }];
    expect(isAuthorizedForResource(roles, "staff:write", { clinicId: "clinic-a" })).toBe(true);
    expect(isAuthorizedForResource(roles, "staff:write", { clinicId: "clinic-b" })).toBe(false);
  });

  it("a role that doesn't grant the action at all is never authorized, regardless of scope", () => {
    const roles = [{ role: "STAFF" as const }];
    expect(isAuthorizedForResource(roles, "clinic:write", {})).toBe(false);
  });
});
