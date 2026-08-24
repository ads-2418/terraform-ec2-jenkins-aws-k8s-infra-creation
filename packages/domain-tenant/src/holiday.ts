import type { Holiday, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError } from "@app/shared";

export interface AddHolidayInput {
  tenantId: string;
  clinicId: string;
  /** Omit for a clinic-wide closure (every doctor); set for one doctor's individual leave day. */
  doctorId?: string;
  /** A calendar date - callers should pass a UTC-midnight-normalized Date (see apps/api's date parsing). */
  date: Date;
  reason?: string;
}

/**
 * findFirst-then-create rather than a DB-level upsert: the (clinicId,
 * doctorId, date) uniqueness can't be enforced by a compound unique index
 * because doctorId is nullable and Postgres treats NULL as distinct from
 * NULL - same reasoning as role_assignments (docs/DATABASE.md §3).
 */
export async function addHoliday(prisma: PrismaClient, input: AddHolidayInput): Promise<Holiday> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.holiday.findFirst({
      where: {
        clinicId: input.clinicId,
        doctorId: input.doctorId ?? null,
        date: input.date,
      },
    });
    if (existing) return existing;

    return tx.holiday.create({
      data: {
        tenantId: input.tenantId,
        clinicId: input.clinicId,
        doctorId: input.doctorId,
        date: input.date,
        reason: input.reason,
      },
    });
  });
}

/** Admin management view: every holiday for a clinic, or just one doctor's if `doctorId` is given. */
export async function listHolidays(
  prisma: PrismaClient,
  input: { tenantId: string; clinicId: string; doctorId?: string },
): Promise<Holiday[]> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.holiday.findMany({
      where: { clinicId: input.clinicId, doctorId: input.doctorId },
      orderBy: { date: "asc" },
    }),
  );
}

export async function getHoliday(
  prisma: PrismaClient,
  input: { tenantId: string; holidayId: string },
): Promise<Holiday> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const holiday = await tx.holiday.findUnique({ where: { id: input.holidayId } });
    if (!holiday) throw new NotFoundError("Holiday");
    return holiday;
  });
}

// Note: there is deliberately no "effective holidays for a doctor" query
// here. The appointment engine (packages/domain-appointment) reads the
// holidays table directly via Prisma, the same way it reads
// doctor_availability directly rather than calling into this package -
// see availability.ts there. This package only owns the admin-facing CRUD.

export async function removeHoliday(
  prisma: PrismaClient,
  input: { tenantId: string; holidayId: string },
): Promise<void> {
  await withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.holiday.findUnique({ where: { id: input.holidayId } });
    if (!existing) throw new NotFoundError("Holiday");
    await tx.holiday.delete({ where: { id: input.holidayId } });
  });
}
