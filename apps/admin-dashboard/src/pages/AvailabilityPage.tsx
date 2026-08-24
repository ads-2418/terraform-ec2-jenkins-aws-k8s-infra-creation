import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Clinic, Doctor, DoctorAvailability } from "../types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "09:00" -> "22:00" becomes "13h 00m" - how long this window runs for. */
function windowDuration(startTime: string, endTime: string): string {
  const [startHour, startMinute] = startTime.split(":").map(Number) as [number, number];
  const [endHour, endMinute] = endTime.split(":").map(Number) as [number, number];
  const totalMinutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function AvailabilityPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [windows, setWindows] = useState<DoctorAvailability[]>([]);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("22:00");
  const [slotDurationMinutes, setSlotDurationMinutes] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadWindows(forDoctorId: string) {
    if (!forDoctorId) {
      setWindows([]);
      return;
    }
    const res = await api.get<{ windows: DoctorAvailability[] }>(`/v1/doctors/${forDoctorId}/availability`);
    setWindows(res.windows);
  }

  async function load() {
    setLoading(true);
    try {
      const [clinicsRes, doctorsRes] = await Promise.all([
        api.get<{ clinics: Clinic[] }>("/v1/clinics"),
        api.get<{ doctors: Doctor[] }>("/v1/doctors"),
      ]);
      setClinics(clinicsRes.clinics);
      setDoctors(doctorsRes.doctors);
      const firstClinic = clinicsRes.clinics[0]?.id ?? "";
      if (!clinicId) setClinicId(firstClinic);
      const firstDoctor = doctorsRes.doctors.find((d) => d.clinicId === (clinicId || firstClinic))?.id ?? "";
      if (!doctorId) setDoctorId(firstDoctor);
      await loadWindows(doctorId || firstDoctor);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadWindows(doctorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (startTime >= endTime) {
      setError("End time must be after start time.");
      return;
    }
    try {
      await api.put(`/v1/doctors/${doctorId}/availability`, {
        clinicId,
        dayOfWeek,
        startTime,
        endTime,
        slotDurationMinutes,
      });
      await loadWindows(doctorId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save working hours.");
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await api.del(`/v1/doctors/${doctorId}/availability/${id}`);
      await loadWindows(doctorId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove window.");
    }
  }

  const doctorsForClinic = doctors.filter((d) => d.clinicId === clinicId);
  const sortedWindows = [...windows].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));

  return (
    <div>
      <h1>Working Hours</h1>
      <p className="hint">
        Set when each doctor is bookable. Patients (dashboard, WhatsApp, and the booking widget alike) can only book
        inside these windows - changes take effect immediately, including for holds already in progress.
      </p>

      <div className="inline-form">
        <select
          value={clinicId}
          onChange={(e) => {
            setClinicId(e.target.value);
            setDoctorId("");
          }}
        >
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          <option value="" disabled>
            Select doctor
          </option>
          {doctorsForClinic.map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName}
            </option>
          ))}
        </select>
      </div>

      {doctorId && (
        <>
          <form className="inline-form" onSubmit={handleCreate}>
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
              {DAY_NAMES.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
            <span>to</span>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
            <select value={slotDurationMinutes} onChange={(e) => setSlotDurationMinutes(Number(e.target.value))}>
              <option value={15}>15 min slots</option>
              <option value={20}>20 min slots</option>
              <option value={30}>30 min slots</option>
              <option value={45}>45 min slots</option>
              <option value={60}>60 min slots</option>
            </select>
            <button type="submit">Add window</button>
          </form>

          {error && <p className="error">{error}</p>}

          {loading ? (
            <p>Loading...</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Hours</th>
                  <th>Duration</th>
                  <th>Slot length</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedWindows.map((w) => (
                  <tr key={w.id}>
                    <td>{DAY_NAMES[w.dayOfWeek]}</td>
                    <td>
                      {w.startTime} - {w.endTime}
                    </td>
                    <td>{windowDuration(w.startTime, w.endTime)}</td>
                    <td>{w.slotDurationMinutes} min</td>
                    <td>
                      <button onClick={() => void handleDelete(w.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
                {sortedWindows.length === 0 && (
                  <tr>
                    <td colSpan={5}>No working hours set for this doctor yet - add one above.</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
