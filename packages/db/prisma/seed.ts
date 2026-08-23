import { hashPassword } from "@app/shared";
import { getPrismaClient, withTenantContext, disconnectPrisma } from "../src/index.js";
import { RoleName, StaffRole, type Prisma } from "../generated/client/index.js";

/**
 * Local-dev-only seed data - see docs/DEVELOPMENT.md §2 "Seed data
 * discipline". No production data, credentials, or real identifiers of
 * any kind: every id below is a fixed dev-only UUID chosen purely so this
 * script is idempotent (safe to re-run), not because it means anything.
 */

const DEV_PASSWORD = "DevPassword123!";

/**
 * role_assignments' unique constraint includes nullable clinicId/doctorId
 * columns - Postgres treats NULL as distinct from NULL in a unique index,
 * so upsert-by-compound-key doesn't give idempotency here the way it does
 * for the other seeded rows. findFirst-then-create sidesteps that.
 */
async function ensureRoleAssignment(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; userId: string; roleId: string; clinicId?: string; doctorId?: string },
): Promise<void> {
  const existing = await tx.roleAssignment.findFirst({
    where: {
      tenantId: args.tenantId,
      userId: args.userId,
      roleId: args.roleId,
      clinicId: args.clinicId ?? null,
      doctorId: args.doctorId ?? null,
    },
  });
  if (existing) return;
  await tx.roleAssignment.create({
    data: {
      tenantId: args.tenantId,
      userId: args.userId,
      roleId: args.roleId,
      clinicId: args.clinicId,
      doctorId: args.doctorId,
    },
  });
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();

  console.log("Seeding roles (global, not tenant-scoped)...");
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }

  console.log("Seeding demo tenant...");
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-clinic" },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Demo Multispecialty Clinic",
      slug: "demo-clinic",
      status: "ACTIVE",
    },
    update: {},
  });

  const roles = await prisma.role.findMany();
  const roleIdByName = new Map(roles.map((r) => [r.name, r.id]));

  await withTenantContext(prisma, tenant.id, async (tx) => {
    console.log("Seeding clinic...");
    const clinic = await tx.clinic.upsert({
      where: { id: "00000000-0000-0000-0000-000000000101" },
      create: {
        id: "00000000-0000-0000-0000-000000000101",
        tenantId: tenant.id,
        name: "Demo Clinic - Koramangala",
        address: "100 Ft Road, Koramangala, Bengaluru",
        phone: "+918000000001",
        timezone: "Asia/Kolkata",
      },
      update: {},
    });

    console.log("Seeding services...");
    const generalConsult = await tx.service.upsert({
      where: { id: "00000000-0000-0000-0000-000000000201" },
      create: {
        id: "00000000-0000-0000-0000-000000000201",
        tenantId: tenant.id,
        clinicId: clinic.id,
        name: "General Consultation",
        durationMinutes: 30,
      },
      update: {},
    });
    await tx.service.upsert({
      where: { id: "00000000-0000-0000-0000-000000000202" },
      create: {
        id: "00000000-0000-0000-0000-000000000202",
        tenantId: tenant.id,
        clinicId: clinic.id,
        name: "Follow-up",
        durationMinutes: 15,
      },
      update: {},
    });

    console.log("Seeding tenant admin user...");
    const passwordHash = await hashPassword(DEV_PASSWORD);
    const adminUser = await tx.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo-clinic.test" } },
      create: {
        id: "00000000-0000-0000-0000-000000000301",
        tenantId: tenant.id,
        email: "admin@demo-clinic.test",
        passwordHash,
      },
      update: {},
    });
    const tenantAdminRoleId = roleIdByName.get(RoleName.TENANT_ADMIN);
    if (tenantAdminRoleId) {
      await ensureRoleAssignment(tx, {
        tenantId: tenant.id,
        userId: adminUser.id,
        roleId: tenantAdminRoleId,
      });
    }

    console.log("Seeding doctors...");
    const doctorSeeds = [
      {
        id: "00000000-0000-0000-0000-000000000401",
        email: "dr.mehta@demo-clinic.test",
        displayName: "Dr. Anjali Mehta",
        specialty: "General Physician",
      },
      {
        id: "00000000-0000-0000-0000-000000000402",
        email: "dr.rao@demo-clinic.test",
        displayName: "Dr. Karthik Rao",
        specialty: "Dermatology",
      },
    ];

    const doctorRoleId = roleIdByName.get(RoleName.DOCTOR);

    for (const seed of doctorSeeds) {
      const doctorUser = await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: seed.email } },
        create: {
          tenantId: tenant.id,
          email: seed.email,
          passwordHash,
        },
        update: {},
      });

      const doctor = await tx.doctor.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          tenantId: tenant.id,
          clinicId: clinic.id,
          userId: doctorUser.id,
          displayName: seed.displayName,
          specialty: seed.specialty,
          consultationDurationMinutes: 30,
        },
        update: {},
      });

      if (doctorRoleId) {
        await ensureRoleAssignment(tx, {
          tenantId: tenant.id,
          userId: doctorUser.id,
          roleId: doctorRoleId,
          doctorId: doctor.id,
        });
      }

      // Mon-Fri, 09:00-13:00 and 14:00-18:00, 30-minute slots, for General
      // Consultation. See docs/DATABASE.md §3 "doctor_availability".
      for (const dayOfWeek of [1, 2, 3, 4, 5]) {
        for (const [startTime, endTime] of [
          ["09:00", "13:00"],
          ["14:00", "18:00"],
        ] as const) {
          // A plain, non-UUID deterministic key is fine here - the id
          // column is TEXT, not a checked UUID format - and avoids any
          // risk of two doctors' keys colliding the way a truncated-UUID
          // scheme did in an earlier version of this script.
          const availabilityId = `seed-avail-${doctor.id}-${dayOfWeek}-${startTime}`;
          await tx.doctorAvailability.upsert({
            where: { id: availabilityId },
            create: {
              id: availabilityId,
              tenantId: tenant.id,
              doctorId: doctor.id,
              clinicId: clinic.id,
              dayOfWeek,
              startTime,
              endTime,
              slotDurationMinutes: 30,
              serviceId: generalConsult.id,
            },
            update: {},
          });
        }
      }
    }

    console.log("Seeding receptionist staff user...");
    const staffUser = await tx.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: "front.desk@demo-clinic.test" } },
      create: {
        id: "00000000-0000-0000-0000-000000000501",
        tenantId: tenant.id,
        email: "front.desk@demo-clinic.test",
        passwordHash,
      },
      update: {},
    });
    await tx.staff.upsert({
      where: { id: "00000000-0000-0000-0000-000000000502" },
      create: {
        id: "00000000-0000-0000-0000-000000000502",
        tenantId: tenant.id,
        clinicId: clinic.id,
        userId: staffUser.id,
        role: StaffRole.RECEPTIONIST,
      },
      update: {},
    });
    const staffRoleId = roleIdByName.get(RoleName.STAFF);
    if (staffRoleId) {
      await ensureRoleAssignment(tx, {
        tenantId: tenant.id,
        userId: staffUser.id,
        roleId: staffRoleId,
        clinicId: clinic.id,
      });
    }

    console.log("Seeding demo patients...");
    await tx.patient.upsert({
      where: { tenantId_phone: { tenantId: tenant.id, phone: "+919000000001" } },
      create: {
        id: "00000000-0000-0000-0000-000000000601",
        tenantId: tenant.id,
        clinicId: clinic.id,
        fullName: "Priya Sharma",
        phone: "+919000000001",
        email: "priya.sharma@example.test",
      },
      update: {},
    });
    await tx.patient.upsert({
      where: { tenantId_phone: { tenantId: tenant.id, phone: "+919000000002" } },
      create: {
        id: "00000000-0000-0000-0000-000000000602",
        tenantId: tenant.id,
        clinicId: clinic.id,
        fullName: "Rohan Gupta",
        phone: "+919000000002",
        email: "rohan.gupta@example.test",
      },
      update: {},
    });
  });

  console.log("\nSeed complete.");
  console.log(`Tenant: ${tenant.name} (${tenant.slug})`);
  console.log(`All seeded users share the dev-only password: ${DEV_PASSWORD}`);
  console.log("  admin@demo-clinic.test        (TENANT_ADMIN)");
  console.log("  dr.mehta@demo-clinic.test     (DOCTOR)");
  console.log("  dr.rao@demo-clinic.test       (DOCTOR)");
  console.log("  front.desk@demo-clinic.test   (STAFF / RECEPTIONIST)");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
