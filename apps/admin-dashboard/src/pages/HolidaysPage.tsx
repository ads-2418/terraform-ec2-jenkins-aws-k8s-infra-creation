import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Clinic, Doctor, Holiday } from "../types";

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function HolidaysPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [doctorId, setDoctorId] = useState(""); // "" = whole clinic
  const [date, setDate] = useState(todayPlus(1));
  const [reason, setReason] = useState("");
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadHolidays(forClinicId: string) {
    if (!forClinicId) return;
    const res = await api.get<{ holidays: Holiday[] }>(`/v1/holidays?clinicId=${forClinicId}`);
    setHolidays(res.holidays);
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
      await loadHolidays(clinicId || firstClinic);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadHolidays(clinicId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/v1/holidays", {
        clinicId,
        doctorId: doctorId || undefined,
        date,
        reason: reason || undefined,
      });
      setReason("");
      await loadHolidays(clinicId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add holiday.");
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await api.del(`/v1/holidays/${id}`);
      await loadHolidays(clinicId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove holiday.");
    }
  }

  const doctorsForClinic = doctors.filter((d) => d.clinicId === clinicId);
  const doctorName = (id: string | null) => (id ? doctors.find((d) => d.id === id)?.displayName ?? id : "Whole clinic");

  return (
    <div>
      <h1>Holidays</h1>
      <p className="hint">
        Blocked dates are excluded everywhere - the booking widget, the dashboard, and any hold attempt, even one
        already in flight when the holiday is added.
      </p>
      <form className="inline-form" onSubmit={handleCreate}>
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
          <option value="">Whole clinic</option>
          {doctorsForClinic.map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName}
            </option>
          ))}
        </select>
        <input type="date" value={date} min={todayPlus(0)} onChange={(e) => setDate(e.target.value)} required />
        <input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="submit">Block this date</button>
      </form>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Scope</th>
              <th>Reason</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.id}>
                <td>{h.date.slice(0, 10)}</td>
                <td>{doctorName(h.doctorId)}</td>
                <td>{h.reason ?? "-"}</td>
                <td>
                  <button onClick={() => void handleDelete(h.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {holidays.length === 0 && (
              <tr>
                <td colSpan={4}>No holidays set for this clinic.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
