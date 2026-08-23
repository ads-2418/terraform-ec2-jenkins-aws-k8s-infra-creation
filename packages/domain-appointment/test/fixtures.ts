import { randomUUID } from "node:crypto";
import { getPrismaClient, withTenantContext, type Clinic, type Doctor, type Patient, type Service, type Tenant } from "@app/db";

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
  patient: Patient;
}

/**
 * A tenant with one clinic, one doctor available essentially all day every
 * day (00:00-23:30, 30-minute grid, all services), one 30-minute service,
 * and one patient. Deliberately unconstrained on availability so tests can
 * pick any half-hour-aligned future UTC time without hitting business-hours
 * edge cases - those are covered separately in availability.test.ts.
 */
export async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { name: `Test Tenant ${randomUUID()}`, slug: `test-${randomUUID()}` },
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

    const patient = await tx.patient.create({
      data: {
        tenantId: tenant.id,
        clinicId: clinic.id,
        fullName: "Test Patient",
        phone: `+91${Math.floor(9_000_000_000 + Math.random() * 999_999_999)}`,
      },
    });

    return { tenant, clinic, doctor, service, patient };
  });
}

/** A future UTC instant aligned to the 30-minute grid the fixture doctor is available on. */
export function futureSlotTime(minutesFromNow: number): Date {
  const t = new Date(Date.now() + minutesFromNow * 60_000);
  t.setUTCSeconds(0, 0);
  const minutes = t.getUTCMinutes();
  t.setUTCMinutes(minutes - (minutes % 30));
  return t;
}

export { prisma };
