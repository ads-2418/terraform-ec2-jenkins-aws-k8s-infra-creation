import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [platformMode, setPlatformMode] = useState(false);
  const [tenantSlug, setTenantSlug] = useState("demo-clinic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(platformMode ? "" : tenantSlug, email, password);
      navigate(user.roles.includes("PLATFORM_ADMIN") ? "/platform/tenants" : "/appointments");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="centered-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>{platformMode ? "Platform Admin" : "Clinic Admin"}</h1>
        {error && <p className="error">{error}</p>}
        {!platformMode && (
          <label>
            Clinic ID
            <input value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
        <button type="button" className="link-button" onClick={() => setPlatformMode((v) => !v)}>
          {platformMode ? "Back to clinic sign in" : "Sign in as platform admin"}
        </button>
      </form>
    </div>
  );
}
