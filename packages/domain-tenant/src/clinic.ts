import type { Clinic, Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError } from "@app/shared";

export interface CreateClinicInput {
  tenantId: string;
  name: string;
  address?: string;
  phone?: string;
  timezone?: string;
  businessHours?: Prisma.InputJsonValue;
}

export async function createClinic(prisma: PrismaClient, input: CreateClinicInput): Promise<Clinic> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.clinic.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        address: input.address,
        phone: input.phone,
        timezone: input.timezone,
        businessHours: input.businessHours,
      },
    }),
  );
}

export async function getClinic(
  prisma: PrismaClient,
  input: { tenantId: string; clinicId: string },
): Promise<Clinic> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const clinic = await tx.clinic.findUnique({ where: { id: input.clinicId } });
    if (!clinic) throw new NotFoundError("Clinic");
    return clinic;
  });
}

export async function listClinics(prisma: PrismaClient, input: { tenantId: string }): Promise<Clinic[]> {
  return withTenantContext(prisma, input.tenantId, (tx) => tx.clinic.findMany({ orderBy: { name: "asc" } }));
}

export interface UpdateClinicInput {
  tenantId: string;
  clinicId: string;
  name?: string;
  address?: string;
  phone?: string;
  timezone?: string;
  businessHours?: Prisma.InputJsonValue;
}

export async function updateClinic(prisma: PrismaClient, input: UpdateClinicInput): Promise<Clinic> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.clinic.findUnique({ where: { id: input.clinicId } });
    if (!existing) throw new NotFoundError("Clinic");
    return tx.clinic.update({
      where: { id: input.clinicId },
      data: {
        name: input.name,
        address: input.address,
        phone: input.phone,
        timezone: input.timezone,
        businessHours: input.businessHours,
      },
    });
  });
}
