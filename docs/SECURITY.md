# Security Architecture

Design baseline: OWASP ASVS/Top-10 alignment, least privilege throughout,
and an explicit assumption that this system holds healthcare-adjacent
personal data for patients in India — treated with DPDP Act (India's Digital
Personal Data Protection Act) sensitivity even though full clinical records
are out of scope for v1 (see Open Questions in the final summary regarding
whether any future clinical-notes feature would trigger stricter handling).

## 1. Authentication

| Actor | Mechanism |
|---|---|
| Dashboard user (staff/doctor/admin) | Email + argon2id password, optional TOTP MFA; short-lived JWT access token (15 min) + rotating refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie |
| Platform admin | Same as above + mandatory MFA + separate role tier, IP-allowlist optional per deployment |
| WordPress plugin → API | Per-tenant API key (`sk_live_...`) issued at plugin activation, sent as `Authorization: Bearer`, plus HMAC request signing (timestamp + body hash) to prevent replay even if the key leaks via logs |
| WhatsApp Cloud API → our webhook | Meta's `X-Hub-Signature-256` HMAC verification against the app secret (§7) |
| Google/Microsoft webhooks → our callback | Provider-specific validation token / client-state check (§7) |
| Patient (WhatsApp) | Identity = phone number from the verified WhatsApp session; no password. Any future self-service web portal uses OTP-over-WhatsApp/SMS or magic link, never a stored password for patients |

Refresh tokens are rotated on every use (old one invalidated) and stored
hashed, so a leaked refresh-token DB dump doesn't grant reusable sessions.

## 2. Authorization (RBAC)

Roles: `PLATFORM_ADMIN > TENANT_ADMIN > CLINIC_MANAGER > DOCTOR / STAFF`,
each scoped via `role_assignments` (`docs/DATABASE.md` §3) to a tenant,
optionally narrowed to a clinic or a specific doctor. Authorization is two
independent checks on every request:

1. **Role/permission check** — a policy layer (`packages/domain-identity/policy`)
   maps `(role, action, resource type)` → allow/deny, e.g. `STAFF` can
   `appointment:cancel` within their clinic but not `doctor:delete`;
   `DOCTOR` can act on their own appointments but not another doctor's.
2. **Tenant/scope check** — independent of role, every resource fetch is
   scoped to the caller's `tenant_id` (and clinic/doctor id where the role
   is scoped that narrowly), enforced by the repository layer + RLS
   (`docs/DATABASE.md` §1) — so even a policy-layer bug can't cross a tenant
   boundary, only mis-scope within one, which is a strictly smaller failure
   mode.

Permission denials are always audit-logged (`§9`), including the attempted
action, since repeated denials are a signal worth alerting on.

## 3. Tenant isolation

Covered in depth in `docs/DATABASE.md` §1. Security-relevant summary:

- `tenant_id` is **derived server-side** from the authenticated principal
  (JWT claim for dashboard users, `api_keys.tenant_id` for the WordPress
  plugin, `whatsapp_sessions`/`patients.tenant_id` resolved from the
  business phone number the message arrived on for WhatsApp) — never
  accepted as client input for scoping.
- PostgreSQL RLS as a database-enforced backstop (`SET LOCAL app.tenant_id`
  per transaction; app DB role has `BYPASSRLS` revoked).
- Cross-tenant platform-admin operations use a distinct, explicitly audited
  service path — never the same request path patient/staff traffic uses.

## 4. Encryption

- **In transit**: TLS 1.2+ everywhere — client↔API, API↔Postgres/Redis
  (`sslmode=require` / Redis TLS in production), API↔external providers
  (all of Google/Microsoft/Meta/email provider already require TLS).
- **At rest**: RDS/ElastiCache encryption at rest (AWS-managed, KMS-backed)
  for the baseline; **additionally**, column-level envelope encryption for
  specifically sensitive secrets stored inside otherwise-encrypted-at-rest
  tables — OAuth access/refresh tokens (`calendar_connections`), MFA
  secrets (`users.mfa_secret`) — using a KMS data key per row (encrypt data
  key with a KMS CMK, store the encrypted data key alongside the
  ciphertext). This protects those specific fields even in a database
  snapshot/backup exposure scenario, not just a live-cluster compromise.
- Password hashing: argon2id (memory-hard, tuned per current OWASP
  guidance), never a reversible scheme.

## 5. Secret management

- No secret (DB credentials, KMS key aliases excepted, provider client
  secrets, API signing keys, Meta app secret) is ever committed to the repo
  or baked into a container image.
- **AWS Secrets Manager** is the source of truth in every deployed
  environment; local development uses `.env` (git-ignored,
  `.env.example` checked in with placeholder names only — see
  `docs/DEVELOPMENT.md`).
- Kubernetes workloads receive secrets via the **External Secrets Operator**
  syncing from Secrets Manager into namespaced `Secret` objects, mounted as
  env vars/files — Jenkins pipeline has no secret material passing through
  its own logs (masked credential bindings only, per `docs/DEVELOPMENT.md`
  §Jenkins).
- Secret rotation: DB credentials and the WhatsApp/Meta app secret are
  rotatable without a code deploy (Secrets Manager rotation Lambda for RDS;
  manual rotation runbook for third-party secrets, since those depend on the
  provider's own rotation UX).

## 6. Input validation

Every API boundary (Gateway route handlers, WhatsApp webhook parser, plugin
REST calls) validates against a `zod` schema before anything touches a
domain module — reject unknown fields, enforce types/ranges/enums, and
normalize (e.g. phone numbers to E.164) before persistence. This is the
primary SQL-injection defense in combination with Prisma's parameterized
queries (no raw string-interpolated SQL anywhere in the codebase — the one
exception, the RLS/audit-trigger migrations, is static DDL, not
request-driven). Output encoding in the dashboard SPA (React's default
escaping) is the primary XSS defense, plus a strict `Content-Security-Policy`
header disallowing inline scripts.

## 7. Webhook signature verification

- **WhatsApp**: verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw request
  body using the Meta app secret) before parsing the payload; also verify
  the `hub.verify_token` on the initial GET subscription handshake.
- **Google Calendar push**: validate the `X-Goog-Channel-Token` (a secret we
  set at `watch()` time) and `X-Goog-Channel-ID` match our stored
  subscription record; the notification itself carries no data (§`CALENDAR_INTEGRATION.md`
  §4), so this only gates "should I bother fetching a delta," but it still
  matters — an unauthenticated caller shouldn't be able to trigger sync
  work at will (rate-limited regardless, per §8).
- **Microsoft Graph subscriptions**: validate `clientState` (a secret set at
  subscription creation) on every notification; validate the subscription
  handshake's `validationToken` echo per Graph's documented flow.

All three are rejected (4xx, no processing) before any queue job is
enqueued if verification fails — verification failures are audit-logged and
rate-limited per source to blunt brute-force signature guessing.

## 8. Rate limiting

Redis-backed token bucket, layered:

- Per-IP, per-endpoint baseline (protects unauthenticated endpoints —
  login, webhook receivers, OAuth callback).
- Per-tenant (protects the platform from one noisy/compromised tenant
  affecting others — critical in a shared-infrastructure multi-tenant
  system).
- Per-API-key (WordPress plugin) and per-patient-phone (WhatsApp) to blunt
  abuse of the booking flow specifically (e.g. hold-spamming a doctor's
  slots — also structurally limited by the engine only allowing one active
  hold per patient per doctor at a time, enforced as an additional business
  rule beyond rate limiting).

## 9. Audit logging

Full schema in `docs/DATABASE.md` §6; architecture in `docs/ARCHITECTURE.md`
§7. Security-relevant guarantees:

- Insert-only at the database level (`REVOKE UPDATE, DELETE` from the app
  role + a trigger that raises on attempted mutation) — an attacker with
  application-level RCE still can't rewrite history without separate
  database-superuser access, which application processes never have.
- Security-critical events (login success/failure, permission denial, MFA
  challenge, OAuth connect/disconnect, role change) are written
  **synchronously in-request** in addition to the general async audit-queue
  path used for routine domain events — so a Redis/queue outage never loses
  a security-relevant record.
- Audit entries store a `before`/`after` diff, not just the action name,
  to support real incident investigation, not just a checklist.

## 10. CSRF

Dashboard cookie-based session (refresh token cookie) requires CSRF
defense for any cookie-authenticated mutating endpoint: `SameSite=Strict`
as the primary defense, plus a double-submit CSRF token header for
state-changing requests as defense in depth (covers the cases where
`SameSite` alone is insufficient, e.g. some in-app browser webviews).
API-key and JWT-bearer-token requests (WordPress plugin, mobile/future
clients) are not cookie-authenticated and are inherently not CSRF-exposed.

## 11. Dependency & platform hygiene

- Automated dependency vulnerability scanning in CI (npm audit / Snyk-class
  tool) gating merges on high/critical findings.
- Container images built from minimal base images (`node:20-alpine`),
  non-root user, no build toolchain in the runtime image (multi-stage
  builds — `docs/DEVELOPMENT.md` §Docker).
- Kubernetes: namespace-per-environment, NetworkPolicies restricting
  pod-to-pod traffic to declared dependencies only, pods run with
  non-root/read-only-root-filesystem where feasible, IAM roles for service
  accounts (IRSA) scoped per-deployable to only the AWS resources that
  deployable needs (least privilege at the infrastructure layer, mirroring
  the RBAC principle at the application layer).

## 12. Healthcare data minimization (cross-cutting)

Restated because it's a hard product requirement, not just a nice-to-have:

- WhatsApp and email notifications never carry diagnosis, reason-for-visit
  free text, or clinical notes (`docs/WHATSAPP.md` §6).
- No clinical-notes feature exists in this v1 scope at all — `patients`
  intentionally has no free-text medical field (`docs/DATABASE.md` §3). A
  clinical-notes / EHR-adjacent feature **is confirmed on the future
  roadmap** (`docs/ARCHITECTURE.md` §11) but is explicitly not being built
  now; when it is, it gets its own access-controlled table with a
  materially stricter RBAC policy (doctor + explicitly authorized staff
  only, no blanket `CLINIC_MANAGER`/`STAFF` read access the way scheduling
  data has), field-level audit logging on every read (not just write, since
  clinical-record *access* is itself sensitive), and a dedicated security
  and compliance review completed before that feature starts implementation
  — not folded into a routine sprint. Keeping `patients` clean now is what
  makes that a clean additive change later instead of a migration that has
  to touch every existing tenant's data.
- Calendar events created by outbound sync carry only scheduling metadata
  (`docs/CALENDAR_INTEGRATION.md` §5), since calendar visibility can be
  broader than clinical-staff-only.
