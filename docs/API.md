# API Design

REST over HTTPS, JSON bodies, versioned path prefix `/v1`. The API Gateway
(`apps/api`) is the only entry point — WordPress plugin, admin dashboard,
and (indirectly, via `domain-whatsapp`) the WhatsApp conversation service
all go through it. This document defines boundaries and conventions; full
OpenAPI generation (from the zod schemas already required at each route,
`docs/SECURITY.md` §6) is a build-time artifact, not hand-maintained
separately.

## 1. Base conventions

- `Content-Type: application/json` request/response, `Authorization: Bearer
  <token>` for JWT and API-key auth alike (distinguished by token prefix/
  format, not by header name).
- Tenant is **never** a path/query/body parameter for authorization purposes
  — it's resolved server-side from the credential (`docs/SECURITY.md` §3).
  Where a platform-admin endpoint legitimately operates across tenants, the
  target tenant is a path parameter but the *caller's* right to touch it is
  still policy-checked, not assumed from the path.
- Pagination: cursor-based (`?cursor=...&limit=...`), not offset, since
  appointment/audit tables are high-churn.
- All timestamps ISO-8601 UTC on the wire; clients render in the
  tenant/user's timezone.

## 2. Error format

```json
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "This slot is no longer available.",
    "requestId": "req_01HFT..."
  }
}
```

`code` is a stable machine-readable enum (documented per-endpoint), `message`
is safe-to-display-to-patient English (localized where the caller indicates
a language), `requestId` ties back to the audit log / logs for support.
Validation errors additionally include a `fields` array
(`[{ path, message }]`). HTTP status is always the correct semantic code
(`400/401/403/404/409/410/422/429/500`) — `code` is for programmatic
branching, not the status itself.

## 3. Idempotency

Any endpoint documented "idempotent" requires an `Idempotency-Key` header
(client-generated UUID). Behavior per `docs/APPOINTMENT_ENGINE.md` §6:
replay with the same key + same body returns the original response;
same key + different body returns `422 IDEMPOTENCY_KEY_REUSED`. Required
on: hold, confirm, cancel, reschedule. Optional-but-honored elsewhere.

## 4. Endpoint inventory (by domain)

### Auth (`domain-identity`)
| Method & path | Purpose | Auth |
|---|---|---|
| `POST /v1/auth/login` | Dashboard login | none (rate-limited) |
| `POST /v1/auth/refresh` | Rotate access token | refresh cookie |
| `POST /v1/auth/logout` | Revoke refresh token | refresh cookie |
| `POST /v1/auth/mfa/verify` | Complete MFA challenge | partial session token |

### Tenant/Clinic/Doctor management (`domain-tenant`)
| Method & path | Purpose | Auth |
|---|---|---|
| `GET/POST /v1/clinics` | List/create clinics | JWT, `TENANT_ADMIN+` |
| `GET/PATCH /v1/clinics/:id` | Read/update clinic | JWT, scoped |
| `GET/POST /v1/doctors` | List/create doctors | JWT, `CLINIC_MANAGER+` |
| `GET/PATCH /v1/doctors/:id` | Read/update doctor | JWT, scoped |
| `PUT /v1/doctors/:id/availability` | Set recurring availability templates | JWT, `CLINIC_MANAGER+` or self (`DOCTOR`) |
| `GET/POST /v1/services` | Bookable service catalog | JWT, `CLINIC_MANAGER+` |
| `GET/POST /v1/staff` | Staff management | JWT, `CLINIC_MANAGER+` |
| `GET /v1/holidays?clinicId&doctorId` | List blocked dates | JWT, scoped |
| `POST /v1/holidays` | Block a date — omit `doctorId` for a clinic-wide closure, set it for one doctor's leave day | JWT, `CLINIC_MANAGER+` or self (`DOCTOR`, own `doctorId` only) |
| `DELETE /v1/holidays/:id` | Unblock a date | JWT, scoped |

### Availability & booking (`domain-appointment`) — the surface WordPress and WhatsApp both ultimately call
| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/availability?doctorId&serviceId&from&to` | Computed open slots (`APPOINTMENT_ENGINE.md` §7) | API key (plugin) or JWT |
| `POST /v1/appointments/hold` | Create a `HELD` appointment | API key/JWT, **Idempotency-Key required** |
| `POST /v1/appointments/:id/confirm` | `HELD → CONFIRMED` | API key/JWT, Idempotency-Key required |
| `POST /v1/appointments/:id/cancel` | → `CANCELLED` | API key/JWT, Idempotency-Key required |
| `POST /v1/appointments/:id/reschedule` | → `RESCHEDULED` + new appointment | API key/JWT, Idempotency-Key required |
| `POST /v1/appointments/:id/complete` | → `COMPLETED` | JWT, staff/doctor only |
| `POST /v1/appointments/:id/no-show` | → `NO_SHOW` | JWT, staff/doctor only |
| `GET /v1/appointments/:id` | Read one | API key (own tenant)/JWT |
| `GET /v1/appointments?patientPhone=...` | Patient's appointment list (WhatsApp "My appointments") | API key (WhatsApp service credential) |
| `GET /v1/appointments?doctorId&from&to` | Dashboard schedule view | JWT |

The WordPress plugin and the WhatsApp conversation service call **exactly
this same set** of booking endpoints — neither has a privileged shortcut,
which is the concrete enforcement of "channels never contain booking
business logic" (`ARCHITECTURE.md` §1).

### Calendar connections (`domain-calendar`)
| Method & path | Purpose | Auth |
|---|---|---|
| `POST /v1/doctors/:id/calendar-connections/:provider/start` | Begin OAuth | JWT, self or `CLINIC_MANAGER+` |
| `GET /v1/integrations/:provider/callback` | OAuth redirect target | signed `state` param |
| `DELETE /v1/doctors/:id/calendar-connections/:connectionId` | Disconnect | JWT, self or `CLINIC_MANAGER+` |
| `POST /v1/webhooks/google-calendar` | Google push notification receiver | channel token (`SECURITY.md` §7) |
| `POST /v1/webhooks/microsoft-graph` | Graph subscription receiver | `clientState` (`SECURITY.md` §7) |

### WhatsApp (`domain-whatsapp`)
| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/webhooks/whatsapp` | Meta subscription verification handshake | `hub.verify_token` |
| `POST /v1/webhooks/whatsapp` | Inbound message/status webhook | `X-Hub-Signature-256` |

No other WhatsApp endpoints are public. The webhook route only verifies,
resolves the tenant, dedups, and enqueues (`WHATSAPP.md` §4); the
`whatsapp-inbound` worker calls `domain-appointment`'s functions
(`holdSlot`, `confirmAppointment`, `cancelAppointment`,
`rescheduleAppointment`) directly in-process, the same way `apps/api`'s
route handlers do — not via HTTP to the endpoints above. Both channels
still go through the identical engine functions and their idempotency-key
handling, which is what "channels never contain booking business logic"
(`ARCHITECTURE.md` §1) actually enforces here.

### Audit (`domain-audit`)
| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/audit-log?resourceType&resourceId&from&to` | Compliance/investigation query | JWT, `TENANT_ADMIN+`, itself audited |

## 5. WordPress plugin API surface

The plugin is a **thin client**: its PHP backend proxies `GET
/v1/availability`, `POST /v1/appointments/hold`, `POST
/v1/appointments/:id/confirm` (and cancel/reschedule for a patient-facing
"manage my booking" link with a signed token) using its tenant API key,
rendered through a JS-driven embeddable widget (shortcode). It performs
**no** availability computation, hold-TTL logic, or state validation of its
own — those responses come straight from the engine and the widget just
renders them, so there is exactly one implementation of booking rules
across every channel (`ARCHITECTURE.md` §1, restated because it's the most
important boundary in the whole system).

## 6. Rate limiting response

`429` responses carry `Retry-After` and the limiting scope in `error.code`
(`RATE_LIMITED_IP`, `RATE_LIMITED_TENANT`, `RATE_LIMITED_API_KEY`) so
clients (including our own plugin/WhatsApp worker) can back off
appropriately rather than hot-retrying.

## 7. Versioning policy

`/v1` is additive-change-only (new optional fields, new endpoints) without a
version bump; a breaking change ships as `/v2` with `/v1` maintained in
parallel for a defined deprecation window — necessary because the
WordPress plugin is installed on independently-updated third-party sites
and can't be assumed to upgrade in lockstep with the backend.
