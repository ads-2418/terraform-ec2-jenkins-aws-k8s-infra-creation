import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@app/db";
import {
  addAvailabilityWindow,
  createClinic,
  createDoctor,
  createService,
  createStaff,
  createTenant,
  listAvailabilityWindows,
  listDoctors,
  updateDoctor,
} from "../src/index.js";

const prisma = getPrismaClient();

async function resetDb(): Promise<void> {
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

describe("domain-tenant smoke test", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("onboards a tenant end-to-end: admin, clinic, doctor (with login+role), service, availability, staff", async () => {
    const tenant = await createTenant(prisma, {
      name: "Smoke Test Clinic",
      slug: "smoke-test-clinic",
      adminEmail: "admin@smoke.test",
      adminPassword: "AdminPass123!",
    });
    expect(tenant.status).toBe("ACTIVE");

    const clinic = await createClinic(prisma, { tenantId: tenant.id, name: "Main Branch" });
    expect(clinic.tenantId).toBe(tenant.id);

    const service = await createService(prisma, {
      tenantId: tenant.id,
      clinicId: clinic.id,
      name: "Consultation",
      durationMinutes: 30,
    });

    const doctor = await createDoctor(prisma, {
      tenantId: tenant.id,
      clinicId: clinic.id,
      displayName: "Dr. Smoke",
      login: { email: "dr.smoke@smoke.test", password: "DoctorPass123!" },
    });
    expect(doctor.userId).toBeTruthy();

    await addAvailabilityWindow(prisma, {
      tenantId: tenant.id,
      doctorId: doctor.id,
      clinicId: clinic.id,
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "17:00",
      slotDurationMinutes: 30,
      serviceId: service.id,
    });
    const windows = await listAvailabilityWindows(prisma, { tenantId: tenant.id, doctorId: doctor.id });
    expect(windows).toHaveLength(1);

    const updated = await updateDoctor(prisma, {
      tenantId: tenant.id,
      doctorId: doctor.id,
      specialty: "Cardiology",
    });
    expect(updated.specialty).toBe("Cardiology");

    const staff = await createStaff(prisma, {
      tenantId: tenant.id,
      clinicId: clinic.id,
      role: "RECEPTIONIST",
      login: { email: "front.desk@smoke.test", password: "StaffPass123!" },
    });
    expect(staff.role).toBe("RECEPTIONIST");

    const doctors = await listDoctors(prisma, { tenantId: tenant.id });
    expect(doctors.map((d) => d.id)).toContain(doctor.id);
  });
});
