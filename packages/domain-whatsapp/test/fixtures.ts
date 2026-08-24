import { randomUUID } from "node:crypto";
import { getPrismaClient, withTenantContext, type Clinic, type Doctor, type Service, type Tenant } from "@app/db";

const prisma = getPrismaClient();

/** TRUNCATE, not DELETE: fast, and side-steps RLS/FK-order entirely (owner privilege, not subject to row policies). */
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

export interface Fixture {
  tenant: Tenant;
  clinic: Clinic;
  doctor: Doctor;
  service: Service;
}

/**
 * A tenant with WhatsApp routing configured, one clinic, one doctor
 * available essentially all day every day (00:00-23:30, 30-minute grid),
 * and one 30-minute service - enough to drive a full booking conversation
 * without hitting business-hours edge cases (those belong to
 * domain-appointment's own test suite).
 */
export async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: {
      name: `Test Tenant ${randomUUID()}`,
      slug: `test-${randomUUID()}`,
      whatsappPhoneNumberId: `wa-phone-${randomUUID()}`,
    },
  });

  return withTenantContext(prisma, tenant.id, async (tx) => {
    const clinic = await tx.clinic.create({
      data: { tenantId: tenant.id, name: "Test Clinic", timezone: "Asia/Kolkata" },
    });

    const service = await tx.service.create({
      data: { tenantId: tenant.id, clinicId: clinic.id, name: "Consultation", durationMinutes: 30 },
    });

    const doctor = await tx.doctor.create({
      data: {
        tenantId: tenant.id,
        clinicId: clinic.id,
        displayName: "Dr. Test",
        consultationDurationMinutes: 30,
      },
    });

    for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
      await tx.doctorAvailability.create({
        data: {
          tenantId: tenant.id,
          doctorId: doctor.id,
          clinicId: clinic.id,
          dayOfWeek,
          startTime: "00:00",
          endTime: "23:30",
          slotDurationMinutes: 30,
          effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        },
      });
    }

    return { tenant, clinic, doctor, service };
  });
}

/** A fresh, plausible-looking Indian MSISDN so each test's patient is distinct. */
export function testPhone(): string {
  return `+91${Math.floor(9_000_000_000 + Math.random() * 999_999_999)}`;
}

export { prisma };
