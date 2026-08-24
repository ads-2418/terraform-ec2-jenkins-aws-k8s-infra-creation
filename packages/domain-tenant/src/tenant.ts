import type { PrismaClient, RoleName, Tenant } from "@app/db";
import { withTenantContext } from "@app/db";
import { hashPassword } from "@app/shared";

export interface CreateTenantInput {
  name: string;
  slug: string;
  timezone?: string;
  locale?: string;
  adminEmail: string;
  adminPassword: string;
}

/**
 * Platform-admin-only operation (docs/API.md §4 doesn't expose a public
 * `POST /v1/tenants` in this phase - onboarding is an internal/platform
 * action). Creates the tenant plus its first TENANT_ADMIN user in one
 * transaction, since a tenant with no way to log in is useless.
 */
export async function createTenant(prisma: PrismaClient, input: CreateTenantInput): Promise<Tenant> {
  const tenant = await prisma.tenant.create({
    data: {
      name: input.name,
      slug: input.slug,
      timezone: input.timezone,
      locale: input.locale,
      status: "ACTIVE",
    },
  });

  await withTenantContext(prisma, tenant.id, async (tx) => {
    const role = await tx.role.upsert({
      where: { name: "TENANT_ADMIN" as RoleName },
      create: { name: "TENANT_ADMIN" },
      update: {},
    });
    const passwordHash = await hashPassword(input.adminPassword);
    const user = await tx.user.create({
      data: { tenantId: tenant.id, email: input.adminEmail, passwordHash },
    });
    await tx.roleAssignment.create({
      data: { tenantId: tenant.id, userId: user.id, roleId: role.id },
    });
  });

  return tenant;
}

/**
 * Resolves a tenant from an inbound WhatsApp webhook's `metadata.phone_number_id`
 * - the only identity a webhook carries before any other auth context
 * exists. `tenants` has no RLS (it IS the tenant boundary), so this is a
 * plain lookup, same as the API-key bootstrap pattern in domain-identity.
 * docs/WHATSAPP.md §4.
 */
export async function findTenantByWhatsappPhoneNumberId(
  prisma: PrismaClient,
  phoneNumberId: string,
): Promise<Tenant | null> {
  return prisma.tenant.findUnique({ where: { whatsappPhoneNumberId: phoneNumberId } });
}
