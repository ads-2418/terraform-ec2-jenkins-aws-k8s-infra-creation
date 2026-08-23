import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Clinic } from "../types";

export function ClinicsPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const { clinics } = await api.get<{ clinics: Clinic[] }>("/v1/clinics");
      setClinics(clinics);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/v1/clinics", { name });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create clinic.");
    }
  }

  return (
    <div>
      <h1>Clinics</h1>
      <form className="inline-form" onSubmit={handleCreate}>
        <input placeholder="Clinic name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Add clinic</button>
      </form>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>Timezone</th>
            </tr>
          </thead>
          <tbody>
            {clinics.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.address ?? "-"}</td>
                <td>{c.timezone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
