import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@app/db";
import {
  addAvailabilityWindow,
  createClinic,
  createDoctor,
  createService,
  createStaff,
  getClinic,
  getDoctor,
  listAvailabilityWindows,
  listClinics,
  listDoctors,
  listServices,
  listStaff,
  updateClinic,
  updateDoctor,
  updateService,
} from "@app/domain-tenant";
import { assertAuthorizedForResource, assertCan } from "@app/domain-identity";
import { writeAuditLog } from "@app/domain-audit";
import { requireTenantAuth, requireUserAuth } from "../middleware/auth.js";
import { parseBody } from "../validate.js";

const createClinicSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  phone: z.string().optional(),
  timezone: z.string().optional(),
});

const updateClinicSchema = createClinicSchema.partial();

const createServiceSchema = z.object({
  clinicId: z.string().uuid(),
  name: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  bufferBeforeMinutes: z.number().int().nonnegative().optional(),
  bufferAfterMinutes: z.number().int().nonnegative().optional(),
});

const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  durationMinutes: z.number().int().positive().optional(),
  bufferBeforeMinutes: z.number().int().nonnegative().optional(),
  bufferAfterMinutes: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
});

const createDoctorSchema = z.object({
  clinicId: z.string().uuid(),
  displayName: z.string().min(1),
  specialty: z.string().optional(),
  consultationDurationMinutes: z.number().int().positive().optional(),
  login: z.object({ email: z.string().email(), password: z.string().min(8) }).optional(),
});

const updateDoctorSchema = z.object({
  displayName: z.string().min(1).optional(),
  specialty: z.string().optional(),
  consultationDurationMinutes: z.number().int().positive().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const addAvailabilitySchema = z.object({
  clinicId: z.string().uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([0-1]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([0-1]\d|2[0-3]):[0-5]\d$/),
  slotDurationMinutes: z.number().int().positive(),
  serviceId: z.string().uuid().optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
});

const createStaffSchema = z.object({
  clinicId: z.string().uuid(),
  role: z.enum(["RECEPTIONIST", "CLINIC_MANAGER"]),
  login: z.object({ email: z.string().email(), password: z.string().min(8) }),
});

export function registerTenantManagementRoutes(app: FastifyInstance, deps: { prisma: PrismaClient }): void {
  const { prisma } = deps;

  // --- Clinics ---
  app.get("/v1/clinics", async (request) => {
    const auth = requireTenantAuth(request);
    return { clinics: await listClinics(prisma, { tenantId: auth.tenantId }) };
  });

  app.post("/v1/clinics", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot create clinics via this endpoint.");
    assertCan(auth.roles, "clinic:write");
    const body = parseBody(createClinicSchema, request.body);
    const clinic = await createClinic(prisma, { tenantId: auth.tenantId, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "clinic.create",
      resourceType: "clinic",
      resourceId: clinic.id,
      after: clinic,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(201).send(clinic);
  });

  app.get<{ Params: { id: string } }>("/v1/clinics/:id", async (request) => {
    const auth = requireTenantAuth(request);
    return getClinic(prisma, { tenantId: auth.tenantId, clinicId: request.params.id });
  });

  app.patch<{ Params: { id: string } }>("/v1/clinics/:id", async (request) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot update clinics via this endpoint.");
    assertAuthorizedForResource(auth.roles, "clinic:write", { clinicId: request.params.id });
    const body = parseBody(updateClinicSchema, request.body);
    const clinic = await updateClinic(prisma, { tenantId: auth.tenantId, clinicId: request.params.id, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "clinic.update",
      resourceType: "clinic",
      resourceId: clinic.id,
      after: clinic,
      requestId: request.id,
      ip: request.ip,
    });
    return clinic;
  });

  // --- Services ---
  app.get("/v1/services", async (request) => {
    const auth = requireTenantAuth(request);
    const clinicId = (request.query as { clinicId?: string }).clinicId;
    return { services: await listServices(prisma, { tenantId: auth.tenantId, clinicId }) };
  });

  app.post("/v1/services", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot create services via this endpoint.");
    const body = parseBody(createServiceSchema, request.body);
    assertAuthorizedForResource(auth.roles, "service:write", { clinicId: body.clinicId });
    const service = await createService(prisma, { tenantId: auth.tenantId, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "service.create",
      resourceType: "service",
      resourceId: service.id,
      after: service,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(201).send(service);
  });

  app.patch<{ Params: { id: string } }>("/v1/services/:id", async (request) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot update services via this endpoint.");
    assertCan(auth.roles, "service:write");
    const body = parseBody(updateServiceSchema, request.body);
    const service = await updateService(prisma, { tenantId: auth.tenantId, serviceId: request.params.id, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "service.update",
      resourceType: "service",
      resourceId: service.id,
      after: service,
      requestId: request.id,
      ip: request.ip,
    });
    return service;
  });

  // --- Doctors ---
  app.get("/v1/doctors", async (request) => {
    const auth = requireTenantAuth(request);
    const clinicId = (request.query as { clinicId?: string }).clinicId;
    return { doctors: await listDoctors(prisma, { tenantId: auth.tenantId, clinicId }) };
  });

  app.post("/v1/doctors", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot create doctors via this endpoint.");
    const body = parseBody(createDoctorSchema, request.body);
    assertAuthorizedForResource(auth.roles, "doctor:write", { clinicId: body.clinicId });
    const doctor = await createDoctor(prisma, { tenantId: auth.tenantId, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "doctor.create",
      resourceType: "doctor",
      resourceId: doctor.id,
      after: doctor,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(201).send(doctor);
  });

  app.get<{ Params: { id: string } }>("/v1/doctors/:id", async (request) => {
    const auth = requireTenantAuth(request);
    return getDoctor(prisma, { tenantId: auth.tenantId, doctorId: request.params.id });
  });

  app.patch<{ Params: { id: string } }>("/v1/doctors/:id", async (request) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot update doctors via this endpoint.");
    assertAuthorizedForResource(auth.roles, "doctor:write", { doctorId: request.params.id });
    const body = parseBody(updateDoctorSchema, request.body);
    const doctor = await updateDoctor(prisma, { tenantId: auth.tenantId, doctorId: request.params.id, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "doctor.update",
      resourceType: "doctor",
      resourceId: doctor.id,
      after: doctor,
      requestId: request.id,
      ip: request.ip,
    });
    return doctor;
  });

  app.get<{ Params: { id: string } }>("/v1/doctors/:id/availability", async (request) => {
    const auth = requireTenantAuth(request);
    return { windows: await listAvailabilityWindows(prisma, { tenantId: auth.tenantId, doctorId: request.params.id }) };
  });

  app.put<{ Params: { id: string } }>("/v1/doctors/:id/availability", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot manage availability via this endpoint.");
    assertAuthorizedForResource(auth.roles, "availability:write", { doctorId: request.params.id });
    const body = parseBody(addAvailabilitySchema, request.body);
    const window = await addAvailabilityWindow(prisma, {
      tenantId: auth.tenantId,
      doctorId: request.params.id,
      ...body,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      effectiveUntil: body.effectiveUntil ? new Date(body.effectiveUntil) : undefined,
    });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "doctor_availability.create",
      resourceType: "doctor_availability",
      resourceId: window.id,
      after: window,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(201).send(window);
  });

  // --- Staff ---
  app.get("/v1/staff", async (request) => {
    const auth = requireTenantAuth(request);
    const clinicId = (request.query as { clinicId?: string }).clinicId;
    return { staff: await listStaff(prisma, { tenantId: auth.tenantId, clinicId }) };
  });

  app.post("/v1/staff", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot create staff via this endpoint.");
    const body = parseBody(createStaffSchema, request.body);
    assertAuthorizedForResource(auth.roles, "staff:write", { clinicId: body.clinicId });
    const staff = await createStaff(prisma, { tenantId: auth.tenantId, ...body });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "staff.create",
      resourceType: "staff",
      resourceId: staff.id,
      after: staff,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(201).send(staff);
  });
}
