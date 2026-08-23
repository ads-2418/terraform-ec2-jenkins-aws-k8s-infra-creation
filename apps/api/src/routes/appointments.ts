import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTenantContext, type PrismaClient } from "@app/db";
import { enqueueHoldExpiry } from "@app/queue";
import {
  cancelAppointment,
  completeAppointment,
  computeAvailability,
  confirmAppointment,
  holdSlot,
  markNoShow,
  rescheduleAppointment,
} from "@app/domain-appointment";
import { assertAuthorizedForResource, assertCan } from "@app/domain-identity";
import { findOrCreatePatient } from "@app/domain-tenant";
import { writeAuditLog } from "@app/domain-audit";
import { ValidationError } from "@app/shared";
import { requireTenantAuth, requireUserAuth } from "../middleware/auth.js";
import { hashRequestBody } from "../idempotency-hash.js";
import { parseBody } from "../validate.js";

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8) {
    throw new ValidationError([{ path: "Idempotency-Key", message: "Idempotency-Key header is required." }]);
  }
  return key;
}

const availabilityQuerySchema = z.object({
  doctorId: z.string().uuid(),
  serviceId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

const holdSchema = z.object({
  clinicId: z.string().uuid(),
  doctorId: z.string().uuid(),
  serviceId: z.string().uuid(),
  startAt: z.string().datetime(),
  patient: z.object({
    phone: z.string().min(8),
    fullName: z.string().min(1),
    email: z.string().email().optional(),
  }),
});

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

const rescheduleSchema = z.object({
  newStartAt: z.string().datetime(),
});

export function registerAppointmentRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; holdTtlMinutes: number; noShowGraceMinutes: number; queueRedis: Redis },
): void {
  const { prisma } = deps;

  app.get("/v1/availability", async (request) => {
    const auth = requireTenantAuth(request);
    const query = parseBody(availabilityQuerySchema, request.query);
    const slots = await withTenantContext(prisma, auth.tenantId, (tx) =>
      computeAvailability(tx, {
        tenantId: auth.tenantId,
        doctorId: query.doctorId,
        serviceId: query.serviceId,
        from: new Date(query.from),
        to: new Date(query.to),
      }),
    );
    return { slots };
  });

  app.post("/v1/appointments/hold", async (request, reply) => {
    const auth = requireTenantAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseBody(holdSchema, request.body);

    const patient = await findOrCreatePatient(prisma, {
      tenantId: auth.tenantId,
      clinicId: body.clinicId,
      ...body.patient,
    });

    const channel = auth.kind === "API_KEY" ? "WORDPRESS" : "DASHBOARD";
    const actor =
      auth.kind === "USER"
        ? ({ type: "USER" as const, id: auth.userId })
        : ({ type: "PATIENT" as const, id: patient.id });

    const { appointment, replayed } = await holdSlot(prisma, {
      tenantId: auth.tenantId,
      clinicId: body.clinicId,
      doctorId: body.doctorId,
      serviceId: body.serviceId,
      patientId: patient.id,
      startAt: new Date(body.startAt),
      channel,
      actor,
      holdTtlMinutes: deps.holdTtlMinutes,
      idempotencyKey,
      requestHash: hashRequestBody(body),
    });

    if (!replayed) {
      await writeAuditLog(prisma, {
        tenantId: auth.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.hold",
        resourceType: "appointment",
        resourceId: appointment.id,
        after: appointment,
        requestId: request.id,
        ip: request.ip,
      });

      // Scheduled AFTER commit, per docs/APPOINTMENT_ENGINE.md §3 step 8 -
      // the transaction that created this HELD row has already committed
      // by the time holdSlot() returns, so there's no risk of the job
      // firing before the row is visible.
      const delayMs = appointment.holdExpiresAt ? appointment.holdExpiresAt.getTime() - Date.now() : 0;
      await enqueueHoldExpiry(
        deps.queueRedis,
        { tenantId: auth.tenantId, appointmentId: appointment.id },
        Math.max(delayMs, 0),
      );
    }

    reply.status(201).send(appointment);
  });

  app.post<{ Params: { id: string } }>("/v1/appointments/:id/confirm", async (request, reply) => {
    const auth = requireTenantAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const actor =
      auth.kind === "USER"
        ? ({ type: "USER" as const, id: auth.userId })
        : ({ type: "PATIENT" as const });

    const { appointment, replayed } = await confirmAppointment(prisma, {
      tenantId: auth.tenantId,
      appointmentId: request.params.id,
      idempotencyKey,
      requestHash: hashRequestBody({ appointmentId: request.params.id }),
      actor,
    });

    if (!replayed) {
      await writeAuditLog(prisma, {
        tenantId: auth.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.confirm",
        resourceType: "appointment",
        resourceId: appointment.id,
        after: appointment,
        requestId: request.id,
        ip: request.ip,
      });
    }

    reply.status(200).send(appointment);
  });

  app.post<{ Params: { id: string } }>("/v1/appointments/:id/cancel", async (request, reply) => {
    const auth = requireTenantAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseBody(cancelSchema, request.body ?? {});
    const cancelledBy = auth.kind === "USER" ? "STAFF" : "PATIENT";
    const actor =
      auth.kind === "USER"
        ? ({ type: "USER" as const, id: auth.userId })
        : ({ type: "PATIENT" as const });

    const { appointment, replayed } = await cancelAppointment(prisma, {
      tenantId: auth.tenantId,
      appointmentId: request.params.id,
      idempotencyKey,
      requestHash: hashRequestBody(body),
      cancelledBy,
      reason: body.reason,
      actor,
    });

    if (!replayed) {
      await writeAuditLog(prisma, {
        tenantId: auth.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.cancel",
        resourceType: "appointment",
        resourceId: appointment.id,
        after: appointment,
        requestId: request.id,
        ip: request.ip,
      });
    }

    reply.status(200).send(appointment);
  });

  app.post<{ Params: { id: string } }>("/v1/appointments/:id/reschedule", async (request, reply) => {
    const auth = requireTenantAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseBody(rescheduleSchema, request.body);
    const staffInitiated = auth.kind === "USER";
    const channel = auth.kind === "API_KEY" ? "WORDPRESS" : "DASHBOARD";
    const actor = staffInitiated ? ({ type: "USER" as const, id: auth.userId }) : ({ type: "PATIENT" as const });

    const { oldAppointment, newAppointment, replayed } = await rescheduleAppointment(prisma, {
      tenantId: auth.tenantId,
      existingAppointmentId: request.params.id,
      newStartAt: new Date(body.newStartAt),
      channel,
      actor,
      holdTtlMinutes: deps.holdTtlMinutes,
      staffInitiated,
      idempotencyKey,
      requestHash: hashRequestBody(body),
    });

    if (!replayed) {
      await writeAuditLog(prisma, {
        tenantId: auth.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.reschedule",
        resourceType: "appointment",
        resourceId: newAppointment.id,
        before: oldAppointment,
        after: newAppointment,
        requestId: request.id,
        ip: request.ip,
      });

      // Patient-initiated reschedules leave the new appointment HELD (staff-
      // initiated ones are auto-confirmed and need no expiry job) - same
      // reasoning as the /hold route above.
      if (newAppointment.status === "HELD" && newAppointment.holdExpiresAt) {
        const delayMs = newAppointment.holdExpiresAt.getTime() - Date.now();
        await enqueueHoldExpiry(
          deps.queueRedis,
          { tenantId: auth.tenantId, appointmentId: newAppointment.id },
          Math.max(delayMs, 0),
        );
      }
    }

    reply.status(200).send({ oldAppointment, newAppointment });
  });

  app.post<{ Params: { id: string } }>("/v1/appointments/:id/complete", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot complete appointments via this endpoint.");
    assertCan(auth.roles, "appointment:write");
    const appointment = await completeAppointment(prisma, {
      tenantId: auth.tenantId,
      appointmentId: request.params.id,
      actor: { type: "USER", id: auth.userId },
    });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "appointment.complete",
      resourceType: "appointment",
      resourceId: appointment.id,
      after: appointment,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(200).send(appointment);
  });

  app.post<{ Params: { id: string } }>("/v1/appointments/:id/no-show", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot mark no-shows via this endpoint.");
    assertCan(auth.roles, "appointment:write");
    const appointment = await markNoShow(prisma, {
      tenantId: auth.tenantId,
      appointmentId: request.params.id,
      actor: { type: "USER", id: auth.userId },
      graceMinutes: deps.noShowGraceMinutes,
    });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "appointment.no_show",
      resourceType: "appointment",
      resourceId: appointment.id,
      after: appointment,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(200).send(appointment);
  });

  app.get<{ Params: { id: string } }>("/v1/appointments/:id", async (request) => {
    const auth = requireTenantAuth(request);
    return withTenantContext(prisma, auth.tenantId, (tx) =>
      tx.appointment.findUniqueOrThrow({ where: { id: request.params.id } }),
    );
  });

  app.get("/v1/appointments", async (request) => {
    const auth = requireTenantAuth(request);
    if (auth.kind === "USER") {
      assertAuthorizedForResource(auth.roles, "appointment:read", {});
    }
    const query = request.query as { doctorId?: string; from?: string; to?: string; patientPhone?: string };
    return withTenantContext(prisma, auth.tenantId, async (tx) => {
      const patientId = query.patientPhone
        ? (await tx.patient.findUnique({ where: { tenantId_phone: { tenantId: auth.tenantId, phone: query.patientPhone } } }))?.id
        : undefined;
      const appointments = await tx.appointment.findMany({
        where: {
          doctorId: query.doctorId,
          patientId: query.patientPhone ? (patientId ?? "__none__") : undefined,
          startAt: query.from || query.to ? { gte: query.from ? new Date(query.from) : undefined, lte: query.to ? new Date(query.to) : undefined } : undefined,
        },
        orderBy: { startAt: "desc" },
        take: 100,
      });
      return { appointments };
    });
  });
}
