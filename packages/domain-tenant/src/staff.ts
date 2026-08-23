import type { PrismaClient, RoleName, Staff, StaffRole } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError, hashPassword } from "@app/shared";

export interface CreateStaffInput {
  tenantId: string;
  clinicId: string;
  role: StaffRole;
  login: { email: string; password: string };
}

const STAFF_ROLE_TO_RBAC_ROLE: Record<StaffRole, RoleName> = {
  RECEPTIONIST: "STAFF",
  CLINIC_MANAGER: "CLINIC_MANAGER",
};

export async function createStaff(prisma: PrismaClient, input: CreateStaffInput): Promise<Staff> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const passwordHash = await hashPassword(input.login.password);
    const user = await tx.user.create({
      data: { tenantId: input.tenantId, email: input.login.email, passwordHash },
    });

    const staff = await tx.staff.create({
      data: { tenantId: input.tenantId, clinicId: input.clinicId, userId: user.id, role: input.role },
    });

    const rbacRoleName = STAFF_ROLE_TO_RBAC_ROLE[input.role];
    const rbacRole = await tx.role.upsert({
      where: { name: rbacRoleName },
      create: { name: rbacRoleName },
      update: {},
    });
    await tx.roleAssignment.create({
      data: { tenantId: input.tenantId, userId: user.id, roleId: rbacRole.id, clinicId: input.clinicId },
    });

    return staff;
  });
}

export async function listStaff(
  prisma: PrismaClient,
  input: { tenantId: string; clinicId?: string },
): Promise<Staff[]> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.staff.findMany({ where: { clinicId: input.clinicId } }),
  );
}

export async function getStaff(
  prisma: PrismaClient,
  input: { tenantId: string; staffId: string },
): Promise<Staff> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const staff = await tx.staff.findUnique({ where: { id: input.staffId } });
    if (!staff) throw new NotFoundError("Staff");
    return staff;
  });
}
