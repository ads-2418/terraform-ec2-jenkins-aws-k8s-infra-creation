import type { Doctor, DoctorAvailability, PrismaClient, RoleName } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError, hashPassword } from "@app/shared";

export interface CreateDoctorInput {
  tenantId: string;
  clinicId: string;
  displayName: string;
  specialty?: string;
  photoUrl?: string;
  consultationDurationMinutes?: number;
  /** Optional: create a dashboard login for this doctor alongside the record. */
  login?: { email: string; password: string };
}

export async function createDoctor(prisma: PrismaClient, input: CreateDoctorInput): Promise<Doctor> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    let userId: string | undefined;

    if (input.login) {
      const passwordHash = await hashPassword(input.login.password);
      const user = await tx.user.create({
        data: { tenantId: input.tenantId, email: input.login.email, passwordHash },
      });
      userId = user.id;
    }

    const doctor = await tx.doctor.create({
      data: {
        tenantId: input.tenantId,
        clinicId: input.clinicId,
        userId,
        displayName: input.displayName,
        specialty: input.specialty,
        photoUrl: input.photoUrl,
        consultationDurationMinutes: input.consultationDurationMinutes ?? 30,
      },
    });

    if (userId) {
      const role = await tx.role.upsert({
        where: { name: "DOCTOR" as RoleName },
        create: { name: "DOCTOR" },
        update: {},
      });
      await tx.roleAssignment.create({
        data: { tenantId: input.tenantId, userId, roleId: role.id, doctorId: doctor.id },
      });
    }

    return doctor;
  });
}

export async function getDoctor(
  prisma: PrismaClient,
  input: { tenantId: string; doctorId: string },
): Promise<Doctor> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const doctor = await tx.doctor.findUnique({ where: { id: input.doctorId } });
    if (!doctor) throw new NotFoundError("Doctor");
    return doctor;
  });
}

export async function listDoctors(
  prisma: PrismaClient,
  input: { tenantId: string; clinicId?: string },
): Promise<Doctor[]> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.doctor.findMany({ where: { clinicId: input.clinicId }, orderBy: { displayName: "asc" } }),
  );
}

export interface UpdateDoctorInput {
  tenantId: string;
  doctorId: string;
  displayName?: string;
  specialty?: string;
  photoUrl?: string;
  consultationDurationMinutes?: number;
  status?: "ACTIVE" | "INACTIVE";
}

export async function updateDoctor(prisma: PrismaClient, input: UpdateDoctorInput): Promise<Doctor> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.doctor.findUnique({ where: { id: input.doctorId } });
    if (!existing) throw new NotFoundError("Doctor");
    return tx.doctor.update({
      where: { id: input.doctorId },
      data: {
        displayName: input.displayName,
        specialty: input.specialty,
        photoUrl: input.photoUrl,
        consultationDurationMinutes: input.consultationDurationMinutes,
        status: input.status,
      },
    });
  });
}

export interface SetAvailabilityWindowInput {
  tenantId: string;
  doctorId: string;
  clinicId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
  serviceId?: string;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
}

/** Adds one recurring weekly window - docs/DATABASE.md §3 "doctor_availability". */
export async function addAvailabilityWindow(
  prisma: PrismaClient,
  input: SetAvailabilityWindowInput,
): Promise<DoctorAvailability> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.doctorAvailability.create({
      data: {
        tenantId: input.tenantId,
        doctorId: input.doctorId,
        clinicId: input.clinicId,
        dayOfWeek: input.dayOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
        slotDurationMinutes: input.slotDurationMinutes,
        serviceId: input.serviceId,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil,
      },
    }),
  );
}

export async function listAvailabilityWindows(
  prisma: PrismaClient,
  input: { tenantId: string; doctorId: string },
): Promise<DoctorAvailability[]> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.doctorAvailability.findMany({
      where: { doctorId: input.doctorId },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    }),
  );
}

export async function removeAvailabilityWindow(
  prisma: PrismaClient,
  input: { tenantId: string; doctorId: string; availabilityId: string },
): Promise<void> {
  await withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.doctorAvailability.findUnique({ where: { id: input.availabilityId } });
    if (!existing || existing.doctorId !== input.doctorId) throw new NotFoundError("Availability window");
    await tx.doctorAvailability.delete({ where: { id: input.availabilityId } });
  });
}
