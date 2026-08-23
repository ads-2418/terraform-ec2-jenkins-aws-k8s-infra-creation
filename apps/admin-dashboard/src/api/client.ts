/**
 * Thin fetch wrapper: holds the access token in memory only (never
 * localStorage - docs/SECURITY.md §1), auto-retries once on 401 by
 * rotating the refresh-token cookie, and attaches the CSRF header the
 * refresh endpoint requires (docs/SECURITY.md §10).
 */

let accessToken: string | null = null;
let refreshInFlight: Promise<void> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function doRefresh(): Promise<void> {
  const res = await fetch("/v1/auth/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": readCookie("csrf_token") ?? "" },
  });
  if (!res.ok) throw new Error("refresh failed");
  const data = (await res.json()) as { accessToken: string };
  accessToken = data.accessToken;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let res = await fetch(path, { ...init, headers, credentials: "include" });

  if (res.status === 401 && accessToken) {
    refreshInFlight ??= doRefresh().finally(() => {
      refreshInFlight = null;
    });
    try {
      await refreshInFlight;
      headers.set("Authorization", `Bearer ${accessToken}`);
      res = await fetch(path, { ...init, headers, credentials: "include" });
    } catch {
      accessToken = null;
    }
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; fields?: Array<{ path: string; message: string }> };
    };
    throw new ApiError(
      res.status,
      body.error?.code ?? "UNKNOWN",
      body.error?.message ?? res.statusText,
      body.error?.fields,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: extraHeaders }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
};
