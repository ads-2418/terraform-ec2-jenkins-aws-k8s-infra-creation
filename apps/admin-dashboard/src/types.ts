export interface Clinic {
  id: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  timezone: string;
}

export interface Service {
  id: string;
  clinicId: string;
  name: string;
  durationMinutes: number;
  isActive: boolean;
}

export interface Doctor {
  id: string;
  clinicId: string;
  displayName: string;
  specialty?: string | null;
  status: "ACTIVE" | "INACTIVE";
}

export interface Staff {
  id: string;
  clinicId: string;
  role: "RECEPTIONIST" | "CLINIC_MANAGER";
}

export type AppointmentStatus =
  | "HELD"
  | "CONFIRMED"
  | "CANCELLED"
  | "RESCHEDULED"
  | "COMPLETED"
  | "NO_SHOW"
  | "EXPIRED";

export interface Appointment {
  id: string;
  doctorId: string;
  patientId: string;
  serviceId: string;
  status: AppointmentStatus;
  startAt: string;
  endAt: string;
  channel: string;
}

export interface AvailabilitySlot {
  startAt: string;
  endAt: string;
}

export interface Holiday {
  id: string;
  clinicId: string;
  doctorId: string | null;
  date: string;
  reason: string | null;
}
