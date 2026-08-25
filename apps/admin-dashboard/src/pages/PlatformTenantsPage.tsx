import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { PlatformTenantSummary } from "../types";

export function PlatformTenantsPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<PlatformTenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ tenants: PlatformTenantSummary[] }>("/v1/platform/tenants")
      .then((res) => setTenants(res.tenants))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load tenants."))
      .finally(() => setLoading(false));
  }, []);

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  const totalActive = tenants.reduce((sum, t) => sum + t.activeApiKeyCount, 0);

  return (
    <div className="content" style={{ maxWidth: 900, margin: "0 auto" }}>
      <div className="inline-form" style={{ justifyContent: "space-between" }}>
        <h1>Platform - Tenants &amp; Integrations</h1>
        <button onClick={() => void handleLogout()}>Sign out</button>
      </div>
      <p className="hint">
        Active API keys are a proxy for integration usage per customer - a solo clinic typically has 1 (their
        WordPress site), a hospital chain running many sites/branches may have dozens.
      </p>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          <p className="hint">
            {tenants.length} tenant{tenants.length === 1 ? "" : "s"}, {totalActive} active integration
            {totalActive === 1 ? "" : "s"} across the platform.
          </p>
          <table>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Created</th>
                <th>Active API keys</th>
                <th>Total API keys (all-time)</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.slug}</code>
                  </td>
                  <td>{t.status}</td>
                  <td>{new Date(t.createdAt).toLocaleDateString("en-IN")}</td>
                  <td>{t.activeApiKeyCount}</td>
                  <td>{t.totalApiKeyCount}</td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={6}>No tenants yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
