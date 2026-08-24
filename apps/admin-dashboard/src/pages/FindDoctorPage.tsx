import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AvailableDoctor, Clinic } from "../types";

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Current time rounded up to the next 5 minutes, as "HH:mm". */
function nowRounded(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function FindDoctorPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [date, setDate] = useState(todayKey());
  const [fromTime, setFromTime] = useState(nowRounded());
  const [toTime, setToTime] = useState("21:00");
  const [results, setResults] = useState<AvailableDoctor[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ clinics: Clinic[] }>("/v1/clinics");
      setClinics(res.clinics);
      if (res.clinics[0]) setClinicId(res.clinics[0].id);
    })();
  }, []);

  async function handleSearch() {
    if (!clinicId) return;
    setError(null);
    setLoading(true);
    setSearched(true);
    try {
      // Interpreted in the browser's local time - fine for this internal,
      // on-site staff tool where that matches the clinic's own timezone.
      const from = new Date(`${date}T${fromTime}:00`);
      const to = new Date(`${date}T${toTime}:00`);
      if (to <= from) {
        setError("End time must be after start time.");
        setResults([]);
        return;
      }
      const res = await api.get<{ doctors: AvailableDoctor[] }>(
        `/v1/available-doctors?clinicId=${clinicId}&from=${from.toISOString()}&to=${to.toISOString()}`,
      );
      setResults(res.doctors);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Find a Doctor</h1>
      <p className="hint">
        See which doctors have open time in a given window - useful when a patient asks "who can see me this
        afternoon" rather than starting from a specific doctor.
      </p>

      <div className="inline-form">
        <select value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)} />
        <span>to</span>
        <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)} />
        <button onClick={() => void handleSearch()} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {searched && !loading && (
        <div className="doctor-card-grid">
          {results.map((d) => (
            <div className="doctor-card" key={d.doctorId}>
              <div className="doctor-card-header">
                {d.photoUrl ? (
                  <img src={d.photoUrl} alt={d.displayName} className="doctor-thumb" />
                ) : (
                  <span className="doctor-thumb doctor-thumb-placeholder">{d.displayName.charAt(0)}</span>
                )}
                <div>
                  <h3>{d.displayName}</h3>
                  <p>{d.specialty ?? "General"}</p>
                </div>
              </div>
              <div className="free-range-chips">
                {d.freeRanges.map((r, i) => (
                  <span className="free-range-chip" key={i}>
                    {timeLabel(r.startAt)} - {timeLabel(r.endAt)}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {results.length === 0 && <p>No doctors have open time in that window.</p>}
        </div>
      )}
    </div>
  );
}
