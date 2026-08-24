import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { ApiKeySummary } from "../types";

export function IntegrationsPage() {
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [name, setName] = useState("WordPress plugin");
  const [justCreatedKey, setJustCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ apiKeys: ApiKeySummary[] }>("/v1/api-keys");
      setApiKeys(res.apiKeys);
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
    setJustCreatedKey(null);
    try {
      const res = await api.post<{ rawKey: string }>("/v1/api-keys", { name });
      setJustCreatedKey(res.rawKey);
      setName("WordPress plugin");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key.");
    }
  }

  async function handleRevoke(id: string) {
    setError(null);
    try {
      await api.del(`/v1/api-keys/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key.");
    }
  }

  return (
    <div>
      <h1>Integrations</h1>
      <p className="hint">
        API keys let external channels - the WordPress plugin, or any future server-to-server integration - call the
        same booking API the dashboard and WhatsApp use. Paste the key into the plugin&apos;s settings page in
        WordPress after creating it here.
      </p>

      <form className="inline-form" onSubmit={handleCreate}>
        <input placeholder="Key name (e.g. WordPress plugin)" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Generate API key</button>
      </form>

      {justCreatedKey && (
        <div className="card api-key-reveal">
          <p>
            <strong>Copy this key now</strong> - it won&apos;t be shown again. Paste it into the WordPress plugin&apos;s
            "API Key" setting.
          </p>
          <code>{justCreatedKey}</code>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key prefix</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>
                  <code>{k.keyPrefix}...</code>
                </td>
                <td>{k.status}</td>
                <td>{new Date(k.createdAt).toLocaleDateString("en-IN")}</td>
                <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("en-IN") : "Never"}</td>
                <td>
                  {k.status === "ACTIVE" && <button onClick={() => void handleRevoke(k.id)}>Revoke</button>}
                </td>
              </tr>
            ))}
            {apiKeys.length === 0 && (
              <tr>
                <td colSpan={6}>No API keys yet - generate one above to connect the WordPress plugin.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
