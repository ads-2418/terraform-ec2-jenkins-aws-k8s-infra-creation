import type { PrismaClient, Service } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError } from "@app/shared";

export interface CreateServiceInput {
  tenantId: string;
  clinicId: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
}

export async function createService(prisma: PrismaClient, input: CreateServiceInput): Promise<Service> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.service.create({
      data: {
        tenantId: input.tenantId,
        clinicId: input.clinicId,
        name: input.name,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
      },
    }),
  );
}

export async function listServices(
  prisma: PrismaClient,
  input: { tenantId: string; clinicId?: string; activeOnly?: boolean },
): Promise<Service[]> {
  return withTenantContext(prisma, input.tenantId, (tx) =>
    tx.service.findMany({
      where: { clinicId: input.clinicId, isActive: input.activeOnly ? true : undefined },
      orderBy: { name: "asc" },
    }),
  );
}

export interface UpdateServiceInput {
  tenantId: string;
  serviceId: string;
  name?: string;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  isActive?: boolean;
}

export async function updateService(prisma: PrismaClient, input: UpdateServiceInput): Promise<Service> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const existing = await tx.service.findUnique({ where: { id: input.serviceId } });
    if (!existing) throw new NotFoundError("Service");
    return tx.service.update({
      where: { id: input.serviceId },
      data: {
        name: input.name,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
        isActive: input.isActive,
      },
    });
  });
}
