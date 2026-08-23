import type { Patient, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError } from "@app/shared";

export interface FindOrCreatePatientInput {
  tenantId: string;
  clinicId: string;
  phone: string;
  fullName: string;
  email?: string;
}

/**
 * Phone is the primary identity key for WhatsApp/WordPress-originated
 * patients (docs/DATABASE.md §3) - a second booking from the same phone
 * number reuses the existing record rather than creating a duplicate.
 */
export async function findOrCreatePatient(
  prisma: PrismaClient,
  input: FindOrCreatePatientInput,
): Promise<Patient> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.patient.findUnique({
      where: { tenantId_phone: { tenantId: input.tenantId, phone: input.phone } },
    });
    if (existing) return existing;

    return tx.patient.create({
      data: {
        tenantId: input.tenantId,
        clinicId: input.clinicId,
        phone: input.phone,
        fullName: input.fullName,
        email: input.email,
      },
    });
  });
}

export async function getPatient(
  prisma: PrismaClient,
  input: { tenantId: string; patientId: string },
): Promise<Patient> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const patient = await tx.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw new NotFoundError("Patient");
    return patient;
  });
}
