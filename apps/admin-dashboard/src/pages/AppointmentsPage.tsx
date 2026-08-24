import { useEffect, useMemo, useState } from "react";
import { api, idempotencyKey } from "../api/client";
import type { Appointment, AvailabilitySlot, Clinic, Doctor, Service } from "../types";

const DAYS_AHEAD = 60;

/** "YYYY-MM-DD" in the clinic's own timezone - en-CA formats that way natively, no manual date math needed. */
function localDateKey(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone });
}

function localTimeLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone, hour: "2-digit", minute: "2-digit" });
}

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function AppointmentsPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayPlus(1));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patientPhone, setPatientPhone] = useState("");
  const [patientName, setPatientName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clinicTimezone = clinics.find((c) => c.id === clinicId)?.timezone ?? "Asia/Kolkata";

  useEffect(() => {
    void (async () => {
      const [clinicsRes, doctorsRes, servicesRes] = await Promise.all([
        api.get<{ clinics: Clinic[] }>("/v1/clinics"),
        api.get<{ doctors: Doctor[] }>("/v1/doctors"),
        api.get<{ services: Service[] }>("/v1/services"),
      ]);
      setClinics(clinicsRes.clinics);
      setDoctors(doctorsRes.doctors);
      setServices(servicesRes.services);
      if (doctorsRes.doctors[0]) {
        setDoctorId(doctorsRes.doctors[0].id);
        setClinicId(doctorsRes.doctors[0].clinicId);
      }
      if (servicesRes.services[0]) setServiceId(servicesRes.services[0].id);
    })();
  }, []);

  async function loadAvailability() {
    if (!doctorId || !serviceId) return;
    setError(null);
    const from = new Date();
    const to = new Date(from.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
    try {
      const res = await api.get<{ slots: AvailabilitySlot[] }>(
        `/v1/availability?doctorId=${doctorId}&serviceId=${serviceId}&from=${from.toISOString()}&to=${to.toISOString()}`,
      );
      setSlots(res.slots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load availability.");
    }
  }

  async function loadAppointments() {
    if (!doctorId) return;
    const res = await api.get<{ appointments: Appointment[] }>(`/v1/appointments?doctorId=${doctorId}`);
    setAppointments(res.appointments);
  }

  useEffect(() => {
    void loadAvailability();
    void loadAppointments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId, serviceId]);

  // Group fetched slots by their clinic-local calendar date, so picking a
  // date is a client-side filter rather than a fresh request per date.
  const slotsByDate = useMemo(() => {
    const map = new Map<string, AvailabilitySlot[]>();
    for (const slot of slots) {
      const key = localDateKey(slot.startAt, clinicTimezone);
      const bucket = map.get(key);
      if (bucket) bucket.push(slot);
      else map.set(key, [slot]);
    }
    return map;
  }, [slots, clinicTimezone]);

  const datesWithSlots = useMemo(
    () => new Set(slotsByDate.keys()),
    [slotsByDate],
  );
  const slotsForSelectedDate = slotsByDate.get(selectedDate) ?? [];

  async function handleHold(startAt: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(
        "/v1/appointments/hold",
        { clinicId, doctorId, serviceId, startAt, patient: { phone: patientPhone, fullName: patientName } },
        { "Idempotency-Key": idempotencyKey() },
      );
      await Promise.all([loadAvailability(), loadAppointments()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hold slot.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAction(id: string, action: "confirm" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/appointments/${id}/${action}`, action === "cancel" ? { reason: "Staff action" } : undefined, {
        "Idempotency-Key": idempotencyKey(),
      });
      await Promise.all([loadAvailability(), loadAppointments()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} appointment.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Appointments</h1>
      {error && <p className="error">{error}</p>}

      <div className="filters">
        <select
          value={doctorId}
          onChange={(e) => {
            const doctor = doctors.find((d) => d.id === e.target.value);
            setDoctorId(e.target.value);
            if (doctor) setClinicId(doctor.clinicId);
          }}
        >
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName}
            </option>
          ))}
        </select>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.durationMinutes}m)
            </option>
          ))}
        </select>
      </div>

      <h2>Book a new appointment</h2>
      <div className="inline-form">
        <input placeholder="Patient phone (+91...)" value={patientPhone} onChange={(e) => setPatientPhone(e.target.value)} />
        <input placeholder="Patient name" value={patientName} onChange={(e) => setPatientName(e.target.value)} />
      </div>

      <div className="booking-picker">
        <label>
          Date
          <input
            type="date"
            value={selectedDate}
            min={todayPlus(0)}
            max={todayPlus(DAYS_AHEAD)}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
        </label>
        {!datesWithSlots.has(selectedDate) && (
          <p className="hint">No open slots on this date (fully booked, outside working hours, or a holiday).</p>
        )}
      </div>

      <div className="slot-grid">
        {slotsForSelectedDate.map((s) => (
          <button
            key={s.startAt}
            disabled={busy || !patientPhone || !patientName}
            onClick={() => void handleHold(s.startAt)}
          >
            {localTimeLabel(s.startAt, clinicTimezone)}
          </button>
        ))}
      </div>

      <h2>Appointments for this doctor</h2>
      <table>
        <thead>
          <tr>
            <th>Start</th>
            <th>Status</th>
            <th>Channel</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {appointments.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.startAt).toLocaleString("en-IN", { timeZone: clinicTimezone, dateStyle: "short", timeStyle: "short" })}</td>
              <td>{a.status}</td>
              <td>{a.channel}</td>
              <td>
                {a.status === "HELD" && (
                  <button disabled={busy} onClick={() => void handleAction(a.id, "confirm")}>
                    Confirm
                  </button>
                )}
                {(a.status === "HELD" || a.status === "CONFIRMED") && (
                  <button disabled={busy} onClick={() => void handleAction(a.id, "cancel")}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
