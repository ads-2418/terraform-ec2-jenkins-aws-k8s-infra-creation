import { randomUUID } from "node:crypto";
import { getPrismaClient, withTenantContext, type RoleName, type Tenant, type User } from "@app/db";
import { hashPassword } from "@app/shared";

export const prisma = getPrismaClient();

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_log, notification_log, whatsapp_messages, whatsapp_sessions,
      calendar_sync_state, calendar_busy_blocks, calendar_connections,
      idempotency_keys, appointment_events, appointments, slots,
      doctor_availability, patients, services, staff, doctors,
      refresh_tokens, api_keys, role_assignments, roles, users, clinics, tenants
    RESTART IDENTITY CASCADE;
  `);
}

export const DEV_PASSWORD = "CorrectHorseBatteryStaple1!";

export interface UserFixture {
  tenant: Tenant;
  user: User;
}

export async function createUserFixture(roleName: RoleName): Promise<UserFixture> {
  const tenant = await prisma.tenant.create({
    data: { name: `Test Tenant ${randomUUID()}`, slug: `test-${randomUUID()}`, status: "ACTIVE" },
  });

  const role = await prisma.role.upsert({
    where: { name: roleName },
    create: { name: roleName },
    update: {},
  });

  const passwordHash = await hashPassword(DEV_PASSWORD);

  const user = await withTenantContext(prisma, tenant.id, async (tx) => {
    const u = await tx.user.create({
      data: { tenantId: tenant.id, email: `user-${randomUUID()}@example.test`, passwordHash },
    });
    await tx.roleAssignment.create({
      data: { tenantId: tenant.id, userId: u.id, roleId: role.id },
    });
    return u;
  });

  return { tenant, user };
}
