import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Clinic, Staff } from "../types";

export function StaffPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [clinicId, setClinicId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"RECEPTIONIST" | "CLINIC_MANAGER">("RECEPTIONIST");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [clinicsRes, staffRes] = await Promise.all([
        api.get<{ clinics: Clinic[] }>("/v1/clinics"),
        api.get<{ staff: Staff[] }>("/v1/staff"),
      ]);
      setClinics(clinicsRes.clinics);
      setStaff(staffRes.staff);
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
      await api.post("/v1/staff", { clinicId, role, login: { email, password } });
      setEmail("");
      setPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create staff member.");
    }
  }

  const clinicName = (id: string) => clinics.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <h1>Staff</h1>
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
        <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          <option value="RECEPTIONIST">Receptionist</option>
          <option value="CLINIC_MANAGER">Clinic Manager</option>
        </select>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <button type="submit">Add staff</button>
      </form>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Clinic</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>{clinicName(s.clinicId)}</td>
                <td>{s.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
