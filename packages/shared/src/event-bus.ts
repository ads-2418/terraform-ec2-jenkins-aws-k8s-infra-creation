import { EventEmitter } from "node:events";
import { rootLogger } from "./logger.js";

/**
 * Domain events emitted by the appointment engine - see docs/ARCHITECTURE.md
 * §6 and docs/APPOINTMENT_ENGINE.md §2. In this phase, listeners enqueue
 * BullMQ jobs (audit write; calendar-sync/notification/WhatsApp listeners
 * arrive in later phases per the roadmap in docs/ARCHITECTURE.md §11) -
 * the emit point itself never changes, so swapping this in-process bus for
 * a real broker later doesn't touch call sites in domain-appointment.
 */
export interface AppointmentEventBase {
  tenantId: string;
  appointmentId: string;
  doctorId: string;
  patientId: string;
  occurredAt: string;
}

export interface AppointmentHeldEvent extends AppointmentEventBase {
  slotId: string;
  startAt: string;
}

export interface AppointmentConfirmedEvent extends AppointmentEventBase {}

export interface AppointmentCancelledEvent extends AppointmentEventBase {
  reason?: string;
  cancelledBy: "PATIENT" | "STAFF" | "SYSTEM";
}

export interface AppointmentRescheduledEvent extends AppointmentEventBase {
  rescheduledFromId: string;
}

export interface AppointmentExpiredEvent extends AppointmentEventBase {}

export interface AppointmentCompletedEvent extends AppointmentEventBase {}

export interface AppointmentNoShowEvent extends AppointmentEventBase {}

export interface DomainEventMap {
  "appointment.held": AppointmentHeldEvent;
  "appointment.confirmed": AppointmentConfirmedEvent;
  "appointment.cancelled": AppointmentCancelledEvent;
  "appointment.rescheduled": AppointmentRescheduledEvent;
  "appointment.expired": AppointmentExpiredEvent;
  "appointment.completed": AppointmentCompletedEvent;
  "appointment.no_show": AppointmentNoShowEvent;
}

export class TypedEventBus<TEventMap extends object> {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many independent consumers (audit, notification, calendar-sync,
    // whatsapp) subscribe to the same small set of appointment events -
    // default of 10 is too easy to hit as phases are added.
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof TEventMap & string>(event: K, payload: TEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof TEventMap & string>(
    event: K,
    handler: (payload: TEventMap[K]) => void | Promise<void>,
  ): void {
    this.emitter.on(event, (payload: TEventMap[K]) => {
      Promise.resolve(handler(payload)).catch((err: unknown) => {
        rootLogger.error({ err, event }, "domain event handler failed");
      });
    });
  }
}

export const domainEventBus = new TypedEventBus<DomainEventMap>();
