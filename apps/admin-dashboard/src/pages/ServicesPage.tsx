import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Clinic, Service } from "../types";

export function ServicesPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [clinicsRes, servicesRes] = await Promise.all([
        api.get<{ clinics: Clinic[] }>("/v1/clinics"),
        api.get<{ services: Service[] }>("/v1/services"),
      ]);
      setClinics(clinicsRes.clinics);
      setServices(servicesRes.services);
      if (!clinicId && clinicsRes.clinics[0]) setClinicId(clinicsRes.clinics[0].id);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/v1/services", { clinicId, name, durationMinutes });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create service.");
    }
  }

  const clinicName = (id: string) => clinics.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <h1>Services</h1>
      <form className="inline-form" onSubmit={handleCreate}>
        <select value={clinicId} onChange={(e) => setClinicId(e.target.value)} required>
          <option value="" disabled>
            Select clinic
          </option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input placeholder="Service name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input
          type="number"
          min={5}
          step={5}
          value={durationMinutes}
          onChange={(e) => setDurationMinutes(Number(e.target.value))}
          required
        />
        <span>minutes</span>
        <button type="submit">Add service</button>
      </form>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Clinic</th>
              <th>Duration</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{clinicName(s.clinicId)}</td>
                <td>{s.durationMinutes} min</td>
                <td>{s.isActive ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
