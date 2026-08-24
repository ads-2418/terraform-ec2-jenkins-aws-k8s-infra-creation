import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import {
  cancelAppointment,
  computeAvailability,
  confirmAppointment,
  holdSlot,
  rescheduleAppointment,
} from "@app/domain-appointment";
import { findOrCreatePatient } from "@app/domain-tenant";
import { HoldExpiredError, InvalidTransitionError, SlotUnavailableError } from "@app/shared";
import type { InboundMessage } from "./webhook-parser.js";
import { buttonsMessage, listMessage, textMessage, type OutboundMessage } from "./templates.js";
import type { WhatsAppSendClient } from "./send-client.js";

export type ConversationState =
  | "MAIN_MENU"
  | "SELECT_CLINIC"
  | "SELECT_DOCTOR"
  | "SELECT_SERVICE"
  | "SELECT_SLOT"
  | "AWAITING_NAME"
  | "AWAITING_CONFIRMATION"
  | "STATUS_CHECK"
  | "MANAGE_APPOINTMENT"
  | "CANCEL_CONFIRM"
  | "RESCHEDULE_SELECT_SLOT";

export interface ConversationContext {
  clinicId?: string;
  doctorId?: string;
  serviceId?: string;
  selectedSlotIso?: string;
  appointmentId?: string;
  [key: string]: unknown;
}

const SESSION_IDLE_MINUTES = 10;
const SLOT_LOOKAHEAD_DAYS = 7;
const MAX_SLOTS_SHOWN = 10;

interface DispatchResult {
  nextState: ConversationState;
  nextContext: ConversationContext;
  outbound: OutboundMessage[];
}

function hash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Deterministic per-message idempotency key - safe under queue retries (docs/WHATSAPP.md §4). */
function idKeyFor(waMessageId: string, action: string): string {
  return `wa:${waMessageId}:${action}`;
}

/**
 * Processes one inbound WhatsApp message end-to-end: loads/creates the
 * session, runs the state machine, persists the new session state, and
 * sends every resulting outbound message. Called once per deduplicated
 * inbound message - see apps/worker's whatsapp-inbound consumer and
 * docs/WHATSAPP.md §4 for the dedup contract this relies on.
 */
export async function processInboundMessage(
  prisma: PrismaClient,
  sendClient: WhatsAppSendClient,
  input: { tenantId: string; message: InboundMessage; holdTtlMinutes: number; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const { tenantId, message } = input;

  const session = await withTenantContext(prisma, tenantId, (tx) =>
    tx.whatsappSession.findUnique({ where: { tenantId_patientPhone: { tenantId, patientPhone: message.fromPhone } } }),
  );

  const expired = !session || session.expiresAt <= now;
  let state: ConversationState = expired ? "MAIN_MENU" : (session.state as ConversationState);
  let context: ConversationContext = expired ? {} : (session.context as ConversationContext);

  const normalizedText = message.text?.trim().toLowerCase();

  let result: DispatchResult;
  try {
    if (normalizedText === "stop") {
      result = await handleOptOut(prisma, tenantId, message);
    } else if (message.kind === "text" && ["hi", "hello", "menu", "start"].includes(normalizedText ?? "")) {
      result = await showMainMenu(prisma, tenantId);
    } else {
      result = await dispatch(prisma, tenantId, state, context, message, now, input.holdTtlMinutes);
    }
  } catch {
    // Never leave the conversation stuck - any unexpected failure resets
    // to the main menu with a plain apology rather than propagating an
    // error back through the queue (which would just retry the same
    // failing state forever, since the inbound message is already
    // deduplicated and won't be redelivered by Meta).
    result = {
      nextState: "MAIN_MENU",
      nextContext: {},
      outbound: [textMessage("Sorry, something went wrong. Let's start over - reply 'menu' anytime.")],
    };
  }

  await withTenantContext(prisma, tenantId, (tx) =>
    tx.whatsappSession.upsert({
      where: { tenantId_patientPhone: { tenantId, patientPhone: message.fromPhone } },
      create: {
        tenantId,
        patientPhone: message.fromPhone,
        state: result.nextState,
        context: result.nextContext as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + SESSION_IDLE_MINUTES * 60_000),
      },
      update: {
        state: result.nextState,
        context: result.nextContext as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + SESSION_IDLE_MINUTES * 60_000),
      },
    }),
  );

  for (const outboundMessage of result.outbound) {
    const sendResult = await sendClient.send(message.fromPhone, outboundMessage);
    await withTenantContext(prisma, tenantId, (tx) =>
      tx.whatsappMessage.create({
        data: {
          tenantId,
          direction: "OUT",
          waMessageId: sendResult.waMessageId ?? undefined,
          status: sendResult.waMessageId ? "SENT" : "SIMULATED",
          payloadSummary: { kind: outboundMessage.kind },
        },
      }),
    );
  }
}

async function handleOptOut(prisma: PrismaClient, tenantId: string, message: InboundMessage): Promise<DispatchResult> {
  await withTenantContext(prisma, tenantId, async (tx) => {
    const patient = await tx.patient.findUnique({
      where: { tenantId_phone: { tenantId, phone: message.fromPhone } },
    });
    if (patient) {
      await tx.patient.update({ where: { id: patient.id }, data: { whatsappOptIn: false } });
    }
  });
  return {
    nextState: "MAIN_MENU",
    nextContext: {},
    outbound: [textMessage("You've been unsubscribed from WhatsApp messages. Reply 'menu' anytime to start again.")],
  };
}

async function dispatch(
  prisma: PrismaClient,
  tenantId: string,
  state: ConversationState,
  context: ConversationContext,
  message: InboundMessage,
  now: Date,
  holdTtlMinutes: number,
): Promise<DispatchResult> {
  switch (state) {
    case "MAIN_MENU":
      return handleMainMenu(prisma, tenantId, message);
    case "SELECT_CLINIC":
      return handleSelectClinic(prisma, tenantId, message);
    case "SELECT_DOCTOR":
      return handleSelectDoctor(prisma, tenantId, context, message);
    case "SELECT_SERVICE":
      return handleSelectService(prisma, tenantId, context, message, now);
    case "SELECT_SLOT":
      return handleSelectSlot(prisma, tenantId, context, message);
    case "AWAITING_NAME":
      return handleAwaitingName(prisma, tenantId, context, message, holdTtlMinutes);
    case "AWAITING_CONFIRMATION":
      return handleAwaitingConfirmation(prisma, tenantId, context, message, now, holdTtlMinutes);
    case "STATUS_CHECK":
    case "MANAGE_APPOINTMENT":
      return handleManageAppointment(prisma, tenantId, state, context, message);
    case "CANCEL_CONFIRM":
      return handleCancelConfirm(prisma, tenantId, context, message);
    case "RESCHEDULE_SELECT_SLOT":
      return handleRescheduleSelectSlot(prisma, tenantId, context, message, holdTtlMinutes);
  }
}

async function showMainMenu(prisma: PrismaClient, tenantId: string): Promise<DispatchResult> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return {
    nextState: "MAIN_MENU",
    nextContext: {},
    outbound: [
      listMessage({
        bodyText: `Hi! Welcome to ${tenant.name}. What would you like to do?`,
        buttonLabel: "Choose",
        rows: [
          { id: "book", title: "Book appointment" },
          { id: "status", title: "My appointments" },
        ],
      }),
    ],
  };
}

async function handleMainMenu(prisma: PrismaClient, tenantId: string, message: InboundMessage): Promise<DispatchResult> {
  if (message.replyId === "book") {
    const clinics = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findMany({ orderBy: { name: "asc" } }));
    if (clinics.length === 0) {
      return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("Sorry, no clinics are set up yet.")] };
    }
    if (clinics.length === 1 && clinics[0]) {
      return listDoctorsForClinic(prisma, tenantId, clinics[0].id);
    }
    return {
      nextState: "SELECT_CLINIC",
      nextContext: {},
      outbound: [
        listMessage({
          bodyText: "Please choose a clinic:",
          buttonLabel: "Choose",
          rows: clinics.map((c) => ({ id: c.id, title: c.name })),
        }),
      ],
    };
  }
  if (message.replyId === "status") {
    return listPatientAppointments(prisma, tenantId, message.fromPhone);
  }
  return showMainMenu(prisma, tenantId);
}

async function handleSelectClinic(prisma: PrismaClient, tenantId: string, message: InboundMessage): Promise<DispatchResult> {
  if (!message.replyId) return showMainMenu(prisma, tenantId);
  return listDoctorsForClinic(prisma, tenantId, message.replyId);
}

async function listDoctorsForClinic(prisma: PrismaClient, tenantId: string, clinicId: string): Promise<DispatchResult> {
  const doctors = await withTenantContext(prisma, tenantId, (tx) =>
    tx.doctor.findMany({ where: { clinicId, status: "ACTIVE" }, orderBy: { displayName: "asc" } }),
  );
  if (doctors.length === 0) {
    return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("Sorry, no doctors are available at this clinic right now.")] };
  }
  return {
    nextState: "SELECT_DOCTOR",
    nextContext: { clinicId },
    outbound: [
      listMessage({
        bodyText: "Please choose a doctor:",
        buttonLabel: "Choose",
        rows: doctors.map((d) => ({ id: d.id, title: d.displayName, description: d.specialty ?? undefined })),
      }),
    ],
  };
}

async function handleSelectDoctor(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
): Promise<DispatchResult> {
  if (!message.replyId || !context.clinicId) return showMainMenu(prisma, tenantId);
  const doctorId = message.replyId;

  const services = await withTenantContext(prisma, tenantId, (tx) =>
    tx.service.findMany({ where: { clinicId: context.clinicId, isActive: true }, orderBy: { name: "asc" } }),
  );
  if (services.length === 0) {
    return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("Sorry, no bookable services are set up yet.")] };
  }
  return {
    nextState: "SELECT_SERVICE",
    nextContext: { clinicId: context.clinicId, doctorId },
    outbound: [
      listMessage({
        bodyText: "What kind of appointment?",
        buttonLabel: "Choose",
        rows: services.map((s) => ({ id: s.id, title: s.name, description: `${s.durationMinutes} min` })),
      }),
    ],
  };
}

async function listAvailableSlots(
  prisma: PrismaClient,
  tenantId: string,
  args: { doctorId: string; serviceId: string; clinicTimezone: string },
): Promise<{ rows: Array<{ id: string; title: string }>; hasSlots: boolean }> {
  const from = new Date();
  const to = new Date(from.getTime() + SLOT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const slots = await withTenantContext(prisma, tenantId, (tx) =>
    computeAvailability(tx, { tenantId, doctorId: args.doctorId, serviceId: args.serviceId, from, to }),
  );
  const shown = slots.slice(0, MAX_SLOTS_SHOWN);
  return {
    hasSlots: shown.length > 0,
    rows: shown.map((s) => ({
      id: s.startAt.toISOString(),
      title: s.startAt.toLocaleString("en-IN", {
        timeZone: args.clinicTimezone,
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    })),
  };
}

async function handleSelectService(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
  _now: Date,
): Promise<DispatchResult> {
  if (!message.replyId || !context.clinicId || !context.doctorId) return showMainMenu(prisma, tenantId);
  const serviceId = message.replyId;

  const clinic = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findUniqueOrThrow({ where: { id: context.clinicId } }));
  const { rows, hasSlots } = await listAvailableSlots(prisma, tenantId, {
    doctorId: context.doctorId,
    serviceId,
    clinicTimezone: clinic.timezone,
  });

  if (!hasSlots) {
    return {
      nextState: "MAIN_MENU",
      nextContext: {},
      outbound: [textMessage(`No open slots in the next ${SLOT_LOOKAHEAD_DAYS} days. Please try again later or contact the clinic directly.`)],
    };
  }

  return {
    nextState: "SELECT_SLOT",
    nextContext: { clinicId: context.clinicId, doctorId: context.doctorId, serviceId },
    outbound: [listMessage({ bodyText: "Please choose a time:", buttonLabel: "Choose", rows })],
  };
}

async function handleSelectSlot(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
): Promise<DispatchResult> {
  if (!message.replyId || !context.clinicId || !context.doctorId || !context.serviceId) return showMainMenu(prisma, tenantId);

  const existingPatient = await withTenantContext(prisma, tenantId, (tx) =>
    tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone: message.fromPhone } } }),
  );

  if (!existingPatient) {
    return {
      nextState: "AWAITING_NAME",
      nextContext: { ...context, selectedSlotIso: message.replyId },
      outbound: [textMessage("What's the patient's full name?")],
    };
  }

  return createHoldAndAskConfirmation(prisma, tenantId, {
    clinicId: context.clinicId,
    doctorId: context.doctorId,
    serviceId: context.serviceId,
    startAtIso: message.replyId,
    patientPhone: message.fromPhone,
    patientName: existingPatient.fullName,
    waMessageId: message.waMessageId,
  });
}

async function handleAwaitingName(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
  _holdTtlMinutes: number,
): Promise<DispatchResult> {
  if (message.kind !== "text" || !message.text?.trim() || !context.clinicId || !context.doctorId || !context.serviceId || !context.selectedSlotIso) {
    return showMainMenu(prisma, tenantId);
  }
  return createHoldAndAskConfirmation(prisma, tenantId, {
    clinicId: context.clinicId,
    doctorId: context.doctorId,
    serviceId: context.serviceId,
    startAtIso: context.selectedSlotIso,
    patientPhone: message.fromPhone,
    patientName: message.text.trim(),
    waMessageId: message.waMessageId,
  });
}

async function createHoldAndAskConfirmation(
  prisma: PrismaClient,
  tenantId: string,
  args: {
    clinicId: string;
    doctorId: string;
    serviceId: string;
    startAtIso: string;
    patientPhone: string;
    patientName: string;
    waMessageId: string;
  },
): Promise<DispatchResult> {
  const patient = await findOrCreatePatient(prisma, {
    tenantId,
    clinicId: args.clinicId,
    phone: args.patientPhone,
    fullName: args.patientName,
  });

  try {
    const { appointment } = await holdSlot(prisma, {
      tenantId,
      clinicId: args.clinicId,
      doctorId: args.doctorId,
      serviceId: args.serviceId,
      patientId: patient.id,
      startAt: new Date(args.startAtIso),
      channel: "WHATSAPP",
      actor: { type: "PATIENT", id: patient.id },
      holdTtlMinutes: 15,
      idempotencyKey: idKeyFor(args.waMessageId, "hold"),
      requestHash: hash({ doctorId: args.doctorId, startAt: args.startAtIso }),
    });

    const doctor = await withTenantContext(prisma, tenantId, (tx) => tx.doctor.findUniqueOrThrow({ where: { id: args.doctorId } }));
    const clinic = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findUniqueOrThrow({ where: { id: args.clinicId } }));
    const when = appointment.startAt.toLocaleString("en-IN", {
      timeZone: clinic.timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

    return {
      nextState: "AWAITING_CONFIRMATION",
      nextContext: { clinicId: args.clinicId, doctorId: args.doctorId, serviceId: args.serviceId, appointmentId: appointment.id },
      outbound: [
        buttonsMessage({
          bodyText: `Confirm your appointment with ${doctor.displayName} on ${when}?`,
          buttons: [
            { id: "confirm", title: "Confirm" },
            { id: "change_time", title: "Choose another time" },
          ],
        }),
      ],
    };
  } catch (err) {
    if (err instanceof SlotUnavailableError) {
      const clinic = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findUniqueOrThrow({ where: { id: args.clinicId } }));
      const { rows, hasSlots } = await listAvailableSlots(prisma, tenantId, {
        doctorId: args.doctorId,
        serviceId: args.serviceId,
        clinicTimezone: clinic.timezone,
      });
      if (!hasSlots) {
        return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("Sorry, that time was just taken and no other slots are open right now.")] };
      }
      return {
        nextState: "SELECT_SLOT",
        nextContext: { clinicId: args.clinicId, doctorId: args.doctorId, serviceId: args.serviceId },
        outbound: [
          textMessage("Sorry, that time was just taken."),
          listMessage({ bodyText: "Please choose another time:", buttonLabel: "Choose", rows }),
        ],
      };
    }
    throw err;
  }
}

async function handleAwaitingConfirmation(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
  _now: Date,
  holdTtlMinutes: number,
): Promise<DispatchResult> {
  if (!context.appointmentId) return showMainMenu(prisma, tenantId);

  if (message.replyId === "confirm") {
    const patient = await withTenantContext(prisma, tenantId, (tx) =>
      tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone: message.fromPhone } } }),
    );
    try {
      await confirmAppointment(prisma, {
        tenantId,
        appointmentId: context.appointmentId,
        idempotencyKey: idKeyFor(message.waMessageId, "confirm"),
        requestHash: hash({ appointmentId: context.appointmentId }),
        actor: { type: "PATIENT", id: patient?.id },
      });
      return {
        nextState: "MAIN_MENU",
        nextContext: {},
        outbound: [textMessage("You're all set! Your appointment is confirmed. Reply 'menu' anytime for more options.")],
      };
    } catch (err) {
      if (err instanceof HoldExpiredError || err instanceof InvalidTransitionError) {
        return {
          nextState: "MAIN_MENU",
          nextContext: {},
          outbound: [textMessage("Sorry, that hold expired. Please start over - reply 'menu' to book again.")],
        };
      }
      throw err;
    }
  }

  if (message.replyId === "change_time") {
    const patient = await withTenantContext(prisma, tenantId, (tx) =>
      tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone: message.fromPhone } } }),
    );
    await cancelAppointment(prisma, {
      tenantId,
      appointmentId: context.appointmentId,
      idempotencyKey: idKeyFor(message.waMessageId, "cancel-for-change"),
      requestHash: hash({ appointmentId: context.appointmentId }),
      cancelledBy: "PATIENT",
      reason: "Patient chose a different time",
      actor: { type: "PATIENT", id: patient?.id },
    });
    if (!context.clinicId || !context.doctorId || !context.serviceId) return showMainMenu(prisma, tenantId);
    void holdTtlMinutes;
    const clinic = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findUniqueOrThrow({ where: { id: context.clinicId } }));
    const { rows, hasSlots } = await listAvailableSlots(prisma, tenantId, {
      doctorId: context.doctorId,
      serviceId: context.serviceId,
      clinicTimezone: clinic.timezone,
    });
    if (!hasSlots) return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("No other slots are open right now.")] };
    return {
      nextState: "SELECT_SLOT",
      nextContext: { clinicId: context.clinicId, doctorId: context.doctorId, serviceId: context.serviceId },
      outbound: [listMessage({ bodyText: "Please choose a time:", buttonLabel: "Choose", rows })],
    };
  }

  return showMainMenu(prisma, tenantId);
}

async function listPatientAppointments(prisma: PrismaClient, tenantId: string, phone: string): Promise<DispatchResult> {
  const patient = await withTenantContext(prisma, tenantId, (tx) => tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone } } }));
  if (!patient) {
    return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("You don't have any appointments yet. Reply 'menu' to book one.")] };
  }

  const appointments = await withTenantContext(prisma, tenantId, (tx) =>
    tx.appointment.findMany({
      where: { patientId: patient.id, status: { in: ["HELD", "CONFIRMED"] } },
      orderBy: { startAt: "asc" },
      take: MAX_SLOTS_SHOWN,
      include: { doctor: true, clinic: true },
    }),
  );

  if (appointments.length === 0) {
    return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("You have no upcoming appointments. Reply 'menu' to book one.")] };
  }

  return {
    nextState: "MANAGE_APPOINTMENT",
    nextContext: {},
    outbound: [
      listMessage({
        bodyText: "Your upcoming appointments:",
        buttonLabel: "Select",
        rows: appointments.map((a) => ({
          id: a.id,
          title: a.startAt.toLocaleString("en-IN", { timeZone: a.clinic.timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
          description: `${a.doctor.displayName} (${a.status})`,
        })),
      }),
    ],
  };
}

async function handleManageAppointment(
  prisma: PrismaClient,
  tenantId: string,
  state: ConversationState,
  context: ConversationContext,
  message: InboundMessage,
): Promise<DispatchResult> {
  void context;
  if (state === "STATUS_CHECK") return listPatientAppointments(prisma, tenantId, message.fromPhone);
  if (!message.replyId) return showMainMenu(prisma, tenantId);

  // The reply id is only ever an appointment id we ourselves listed for
  // this exact phone number in listPatientAppointments - but a crafted
  // reply payload could name a different, arbitrary appointment id.
  // Tenant-scoping via RLS isn't enough here (it only rules out other
  // tenants' appointments, not another patient's at the *same* tenant),
  // so this must also confirm the appointment actually belongs to the
  // patient this session is authenticated as (by phone).
  const [appointment, patient] = await withTenantContext(prisma, tenantId, async (tx) => {
    const patient = await tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone: message.fromPhone } } });
    const appointment = await tx.appointment.findUnique({ where: { id: message.replyId } });
    return [appointment, patient] as const;
  });
  if (!appointment || !patient || appointment.patientId !== patient.id) return showMainMenu(prisma, tenantId);

  return {
    nextState: "CANCEL_CONFIRM",
    nextContext: { appointmentId: appointment.id, doctorId: appointment.doctorId, serviceId: appointment.serviceId, clinicId: appointment.clinicId },
    outbound: [
      buttonsMessage({
        bodyText: "What would you like to do with this appointment?",
        buttons: [
          { id: "cancel_yes", title: "Cancel it" },
          { id: "reschedule", title: "Reschedule" },
          { id: "back", title: "Never mind" },
        ],
      }),
    ],
  };
}

async function handleCancelConfirm(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
): Promise<DispatchResult> {
  if (!context.appointmentId) return showMainMenu(prisma, tenantId);

  if (message.replyId === "cancel_yes") {
    const patient = await withTenantContext(prisma, tenantId, (tx) =>
      tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone: message.fromPhone } } }),
    );
    await cancelAppointment(prisma, {
      tenantId,
      appointmentId: context.appointmentId,
      idempotencyKey: idKeyFor(message.waMessageId, "cancel"),
      requestHash: hash({ appointmentId: context.appointmentId }),
      cancelledBy: "PATIENT",
      reason: "Cancelled via WhatsApp",
      actor: { type: "PATIENT", id: patient?.id },
    });
    return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("Your appointment has been cancelled. Reply 'menu' for more options.")] };
  }

  if (message.replyId === "reschedule") {
    if (!context.clinicId || !context.doctorId || !context.serviceId) return showMainMenu(prisma, tenantId);
    const clinic = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findUniqueOrThrow({ where: { id: context.clinicId } }));
    const { rows, hasSlots } = await listAvailableSlots(prisma, tenantId, {
      doctorId: context.doctorId,
      serviceId: context.serviceId,
      clinicTimezone: clinic.timezone,
    });
    if (!hasSlots) return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("No other slots are open right now.")] };
    return {
      nextState: "RESCHEDULE_SELECT_SLOT",
      nextContext: context,
      outbound: [listMessage({ bodyText: "Please choose a new time:", buttonLabel: "Choose", rows })],
    };
  }

  return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("No changes made. Reply 'menu' for more options.")] };
}

async function handleRescheduleSelectSlot(
  prisma: PrismaClient,
  tenantId: string,
  context: ConversationContext,
  message: InboundMessage,
  holdTtlMinutes: number,
): Promise<DispatchResult> {
  if (!message.replyId || !context.appointmentId) return showMainMenu(prisma, tenantId);

  const patient = await withTenantContext(prisma, tenantId, (tx) =>
    tx.patient.findUnique({ where: { tenantId_phone: { tenantId, phone: message.fromPhone } } }),
  );

  try {
    const { newAppointment } = await rescheduleAppointment(prisma, {
      tenantId,
      existingAppointmentId: context.appointmentId,
      newStartAt: new Date(message.replyId),
      channel: "WHATSAPP",
      actor: { type: "PATIENT", id: patient?.id },
      holdTtlMinutes,
      staffInitiated: false,
      idempotencyKey: idKeyFor(message.waMessageId, "reschedule"),
      requestHash: hash({ appointmentId: context.appointmentId, newStartAt: message.replyId }),
    });

    const doctor = await withTenantContext(prisma, tenantId, (tx) => tx.doctor.findUniqueOrThrow({ where: { id: newAppointment.doctorId } }));
    const clinic = await withTenantContext(prisma, tenantId, (tx) => tx.clinic.findUniqueOrThrow({ where: { id: newAppointment.clinicId } }));
    const when = newAppointment.startAt.toLocaleString("en-IN", {
      timeZone: clinic.timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

    return {
      nextState: "AWAITING_CONFIRMATION",
      nextContext: { appointmentId: newAppointment.id, clinicId: newAppointment.clinicId, doctorId: newAppointment.doctorId, serviceId: newAppointment.serviceId },
      outbound: [
        buttonsMessage({
          bodyText: `Confirm your new appointment time with ${doctor.displayName} on ${when}?`,
          buttons: [
            { id: "confirm", title: "Confirm" },
            { id: "change_time", title: "Choose another time" },
          ],
        }),
      ],
    };
  } catch (err) {
    if (err instanceof SlotUnavailableError) {
      return { nextState: "MAIN_MENU", nextContext: {}, outbound: [textMessage("Sorry, that time was just taken. Please reply 'menu' and try again.")] };
    }
    throw err;
  }
}
