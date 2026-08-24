import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Clinic, Doctor } from "../types";

export function DoctorsPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [clinicsRes, doctorsRes] = await Promise.all([
        api.get<{ clinics: Clinic[] }>("/v1/clinics"),
        api.get<{ doctors: Doctor[] }>("/v1/doctors"),
      ]);
      setClinics(clinicsRes.clinics);
      setDoctors(doctorsRes.doctors);
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
      await api.post("/v1/doctors", {
        clinicId,
        displayName,
        specialty: specialty || undefined,
        photoUrl: photoUrl || undefined,
      });
      setDisplayName("");
      setSpecialty("");
      setPhotoUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create doctor.");
    }
  }

  const clinicName = (id: string) => clinics.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <h1>Doctors</h1>
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
        <input placeholder="Dr. Full Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        <input placeholder="Specialty (optional)" value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
        <input placeholder="Photo URL (optional)" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} />
        <button type="submit">Add doctor</button>
      </form>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Clinic</th>
              <th>Specialty</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {doctors.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.photoUrl ? (
                    <img src={d.photoUrl} alt={d.displayName} className="doctor-thumb" />
                  ) : (
                    <span className="doctor-thumb doctor-thumb-placeholder">{d.displayName.charAt(0)}</span>
                  )}
                </td>
                <td>{d.displayName}</td>
                <td>{clinicName(d.clinicId)}</td>
                <td>{d.specialty ?? "-"}</td>
                <td>{d.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
