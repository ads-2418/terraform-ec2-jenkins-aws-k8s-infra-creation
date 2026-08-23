# Architecture — Healthcare Appointment SaaS (India)

Status: **proposed, not yet implemented**. This document is the entry point for the
system design; it links out to the companion documents for database, appointment
engine, WhatsApp, calendar integration, security, API and local development detail.

## 1. Product framing

A multi-tenant SaaS that lets clinics/hospitals ("tenants") expose doctor
availability and take bookings through two patient-facing **channels**
(WordPress site, WhatsApp), while clinic staff manage everything from a web
dashboard. Doctor calendars stay in sync with Google Calendar / Microsoft 365.

The single non-negotiable architectural rule:

> **The appointment engine owns booking truth. WordPress, WhatsApp, Google
> Calendar and Microsoft Graph are channels/integrations around it, never
> the source of truth, and never holders of booking business logic.**

Everything below is organized to keep that rule enforceable in code, not just
in prose — channel adapters are only allowed to call the engine's API, never
touch its database, and the engine has zero imports from channel packages.

## 2. High-level component view

```mermaid
flowchart LR
    subgraph Channels
        WP[WordPress Plugin\n(PHP, thin client)]
        WA[WhatsApp Cloud API\nwebhook]
        DASH[Admin/Doctor/Staff\nDashboard SPA]
    end

    subgraph Core Platform
        GW[API Gateway / BFF\n(authN, rate limit, tenant\nresolution, validation)]
        AE[Appointment Engine\n(domain core)]
        IDS[Identity & RBAC service]
        TEN[Tenant/Clinic/Doctor\nmanagement]
        NOTIF[Notification Service\n(email + WhatsApp templates)]
        CAL[Calendar Sync Service\n(Google + Microsoft)]
        WAS[WhatsApp Conversation\nService]
        AUD[Audit Service]
        Q[(Redis + BullMQ\nqueues)]
    end

    subgraph Data
        PG[(PostgreSQL\nmulti-tenant, RLS)]
        RD[(Redis\ncache + locks + sessions)]
    end

    subgraph External
        GCAL[Google Calendar API]
        MSGRAPH[Microsoft Graph\nCalendar API]
        WACLOUD[WhatsApp Business\nCloud API]
        EMAIL[Transactional Email\nProvider]
    end

    WP -->|REST, API key + HMAC| GW
    DASH -->|REST, JWT| GW
    WACLOUD -->|webhook, signed| WAS
    WAS --> GW

    GW --> AE
    GW --> IDS
    GW --> TEN
    AE <--> PG
    AE --> Q
    Q --> CAL
    Q --> NOTIF
    Q --> WAS
    Q --> AUD
    AUD --> PG
    CAL <-->|OAuth2, webhooks| GCAL
    CAL <-->|OAuth2, webhooks| MSGRAPH
    NOTIF --> WACLOUD
    NOTIF --> EMAIL
    IDS <--> RD
    AE <--> RD
```

## 3. Services / modules

Deployed as a **modular monolith for v1** (fewer moving parts to operate,
faster to build correctly) but organized as strictly-bounded domain modules
so any of them can be extracted into an independent service later without a
rewrite — each module only talks to others through an in-process interface
that mirrors what its future HTTP/queue contract would look like.

| Module | Responsibility | Owns data | Talks to |
|---|---|---|---|
| `domain-appointment` (Appointment Engine) | Slot computation, holds, booking, state machine, double-booking prevention | `slots`, `appointments`, `appointment_events`, `idempotency_keys` | Postgres directly; publishes domain events |
| `domain-tenant` | Tenant/clinic/location/doctor/staff CRUD, business hours, service catalog | `tenants`, `clinics`, `doctors`, `staff`, `services` | Postgres directly |
| `domain-identity` | AuthN (dashboard login, refresh tokens), RBAC policy evaluation, API keys for channels | `users`, `roles`, `api_keys`, `sessions` | Postgres, Redis |
| `domain-calendar` (Calendar Sync) | OAuth flows, token refresh, push-subscription lifecycle, inbound/outbound sync, conflict detection | `calendar_connections`, `calendar_sync_state` | Google/Microsoft APIs, appointment engine (read-only + event subscription) |
| `domain-whatsapp` (WhatsApp Conversation) | Inbound webhook parsing, conversation session state machine, outbound template dispatch | `whatsapp_sessions`, `whatsapp_messages` | WhatsApp Cloud API, appointment engine |
| `domain-notification` | Channel-agnostic event → template → send, retry/backoff | `notification_log` | Email provider, `domain-whatsapp` outbound |
| `domain-audit` | Append-only audit trail, query API for compliance | `audit_log` | Postgres only (write path is append-only) |
| `wordpress-plugin` (separate runtime, PHP) | Renders booking widget, calls Gateway REST API, embeds patient-facing UI | none (stateless client) | API Gateway only |
| `admin-dashboard` (separate runtime, TS SPA) | Doctor/staff/admin console | none (calls API) | API Gateway only |

The **API Gateway / BFF** is a thin HTTP layer (Fastify/Express + TypeScript):
authentication, tenant resolution, request validation (zod), rate limiting,
and routing into the domain modules. It contains no business logic.

Two deployable runtimes cover the backend:

- `apps/api` — the HTTP server (Gateway + all domain modules, called
  in-process). Handles synchronous requests from dashboard, WordPress plugin,
  and the WhatsApp webhook receiver.
- `apps/worker` — BullMQ consumers for everything asynchronous: hold expiry,
  calendar sync, reminders, notification dispatch, webhook retry, audit
  durability fallback.

Both import the same `packages/domain-*` and `packages/db` packages, so
there is exactly one implementation of business logic regardless of which
process runs it.

## 4. Repository structure

```
/apps
  /api                     # HTTP server: gateway + domain modules mounted in-process
  /worker                  # BullMQ workers (see docs/APPOINTMENT_ENGINE.md, ARCHITECTURE §7)
  /admin-dashboard          # TypeScript SPA (React + Vite) — clinic/doctor/staff/platform UI
  /wordpress-plugin         # PHP plugin — thin REST client + embeddable booking widget (JS)
/packages
  /domain-appointment        # pure business logic: slots, holds, state machine (framework-agnostic)
  /domain-tenant
  /domain-identity
  /domain-calendar
  /domain-whatsapp
  /domain-notification
  /domain-audit
  /db                         # Prisma schema, migrations, generated client, RLS policies
  /shared                     # zod schemas, shared types, error classes, logger, event bus contract
  /config                     # env schema + typed config loader
/infra
  /docker                    # Dockerfiles per app, docker-compose.dev.yml
  /helm                      # Helm charts per deployable, deployed onto the EKS cluster
                              #   provisioned by the root Terraform in this repo
  /jenkins                   # Jenkinsfile + shared pipeline library (build/test/push/deploy)
/docs
  ARCHITECTURE.md  DATABASE.md  APPOINTMENT_ENGINE.md  WHATSAPP.md
  CALENDAR_INTEGRATION.md  SECURITY.md  API.md  DEVELOPMENT.md
# existing, unchanged:
main.tf  outputs.tf  vars/  install_jenkins.sh  README.md
```

Package manager: **pnpm workspaces** + **Turborepo** for task orchestration
(build/test/lint caching across packages). `packages/db` is the single
Prisma schema shared by `apps/api` and `apps/worker` — no drift between
processes on what the schema looks like.

## 5. Background job architecture

Redis + BullMQ. Queues are named by domain, each with its own concurrency
and retry policy:

| Queue | Trigger | Job | Retry policy |
|---|---|---|---|
| `hold-expiry` | Delayed job scheduled at hold creation (`delay = 15 min`) | Re-validate hold status inside a transaction; flip `HELD → EXPIRED` only if still `HELD` and TTL passed | No retry needed (idempotent check); DLQ on repeated Postgres errors |
| `reminder-scan` | Cron (every 5 min) | Scan `appointments` for upcoming CONFIRMED appointments crossing a reminder threshold (T-24h, T-1h, configurable per tenant); enqueue one `reminder-dispatch` job per (appointment, threshold) with a dedup key | n/a (scanner) |
| `reminder-dispatch` | Enqueued by scanner | Send one reminder via notification service | 3 attempts, exponential backoff |
| `calendar-sync-outbound` | Appointment domain event (Confirmed/Cancelled/Rescheduled) | Create/update/delete the event in the doctor's connected calendar(s) | 5 attempts, exponential backoff, DLQ + alert |
| `calendar-sync-inbound` | Google/Microsoft webhook notification | Fetch delta, reconcile against appointments, flag conflicts | 5 attempts; failures surface as `CONFLICT` state, not silently dropped |
| `calendar-token-refresh` | Cron (every 10 min) scanning tokens expiring soon | Refresh OAuth token, re-arm push subscription before its expiry | 3 attempts; on exhaustion mark connection `NEEDS_REAUTH` and notify clinic admin |
| `whatsapp-outbound` | Notification service / conversation service | Send a WhatsApp message via Cloud API | 5 attempts, backoff; DLQ |
| `whatsapp-inbound` | Webhook receiver (fast ack, real work deferred here) | Process one inbound WhatsApp message through the conversation state machine | 3 attempts; message-id dedup makes retries safe |
| `email-outbound` | Notification service | Send transactional email | 5 attempts, backoff |
| `audit-write` | Any mutating action | Durable write to `audit_log` | At-least-once; security-critical events (auth failures, permission denials) are **also written synchronously in-request** as a fallback so a queue outage never loses them |

Idempotency is enforced at the consumer, not just the producer: every job
carries a natural dedup key (appointment id + transition, message id,
webhook delivery id) and handlers are written to be safely re-runnable.

## 6. Notification architecture

Domain modules emit **domain events** (`AppointmentHeld`, `AppointmentConfirmed`,
`AppointmentCancelled`, `AppointmentRescheduled`, `AppointmentReminderDue`,
`AppointmentNoShow`) onto an in-process event bus (typed `EventEmitter`
wrapper in `packages/shared`) that immediately enqueues the corresponding
BullMQ job — this keeps the HTTP request path fast and makes the emit point
swappable later for a real broker (SNS/SQS, or Kafka if scale requires it)
without touching call sites.

`domain-notification` owns the mapping from `(event, tenant, channel
preference)` → rendered message. Templates are tenant-configurable but
content rules are enforced centrally (see `docs/SECURITY.md` and
`docs/WHATSAPP.md` for the data-minimization rules — no diagnosis or
clinical detail in any notification, ever).

## 7. Audit logging architecture

Every state-changing action (booking, hold, cancel, reschedule, RBAC change,
OAuth connect/disconnect, login, permission denial) writes an immutable
`audit_log` row: `tenant_id, actor_type, actor_id, action, resource_type,
resource_id, before, after, ip, user_agent, request_id, created_at`. The
table is insert-only — no application role has `UPDATE`/`DELETE` grants on
it (enforced at the database level, not just in application code). See
`docs/DATABASE.md` §Audit and `docs/SECURITY.md` §Audit for detail.

## 8. Multi-tenancy model

Shared database, shared schema, **row-level multi-tenancy** using
`tenant_id` on every tenant-scoped table plus PostgreSQL **Row-Level
Security** as a database-enforced backstop to application-level tenant
scoping (defense in depth — a bug in one layer doesn't leak data). Full
detail in `docs/DATABASE.md` §Multi-tenancy and `docs/SECURITY.md`
§Tenant isolation.

Rejected alternative: schema-per-tenant or database-per-tenant. Simpler
isolation guarantee, but migrations and cross-tenant platform analytics
become operationally expensive at the tenant counts we'd expect in year 1–2
of an India-focused SMB clinic product. Revisit if a large hospital-chain
tenant later needs hard physical isolation (contractual/compliance driver),
which is where we'd carve out a dedicated database for that one tenant
rather than changing the model for everyone.

## 9. Production deployment (summary)

Builds on the AWS infrastructure this repository already provisions
(`main.tf`, `install_jenkins.sh`): EC2-hosted Jenkins driving an EKS
cluster. Full detail in `docs/DEVELOPMENT.md` §Production deployment; in
short:

- `apps/api` and `apps/worker` ship as separate container images, deployed
  as separate Kubernetes Deployments (independent scaling — worker scales on
  queue depth, api scales on request rate/CPU).
- Managed **RDS PostgreSQL** (Multi-AZ) and **ElastiCache Redis** replace
  in-cluster stateful services in production.
- Jenkins (already provisioned by this repo) runs the build → test →
  image push (ECR) → `helm upgrade` pipeline.
- Secrets come from **AWS Secrets Manager**, synced into Kubernetes via the
  External Secrets Operator — never baked into images or Helm values.

## 10. Companion documents

- `docs/DATABASE.md` — entities, relationships, indices, RLS policies.
- `docs/APPOINTMENT_ENGINE.md` — state machine, hold mechanism, concurrency.
- `docs/WHATSAPP.md` — conversation state machine, webhook handling.
- `docs/CALENDAR_INTEGRATION.md` — Google + Microsoft sync architecture.
- `docs/SECURITY.md` — OWASP-aligned control set.
- `docs/API.md` — REST API boundaries and contracts.
- `docs/DEVELOPMENT.md` — local dev, Docker, Jenkins/K8s deployment.

## 11. Architecture decisions, assumptions, risks, open questions

**Key decisions**: modular monolith over microservices for v1; shared-schema
+ RLS multi-tenancy; appointment engine as the only writer of booking state;
BullMQ for all async work; hold TTL enforced by delayed job + transactional
re-check, not just client-side timer.

**Key risks**: WhatsApp template approval turnaround from Meta; calendar
webhook subscription expiry windows (Microsoft: max ~3 days) requiring
reliable renewal; clock/timezone correctness across IST-only v1 scope but
UTC storage; PHI minimization discipline across every notification template
a tenant admin might customize.

### Resolved product decisions

Answered by the product owner after the initial architecture pass — these
were open questions during design and are now settled, with the affected
docs updated to reflect them directly rather than as caveats:

- **Clinical-notes / EHR-adjacent feature**: confirmed as a **future
  roadmap item**, not v1 scope. The data model stays deliberately clean of
  clinical fields now (`docs/DATABASE.md` §3 — no free-text medical field on
  `patients`) specifically so that feature can land later as its own
  access-controlled table without a `patients`-table migration. Building it
  requires its own dedicated security review before implementation — the
  RBAC and PHI-handling bar for clinical notes is materially higher than
  anything else in this system (`docs/SECURITY.md` §12).
- **Deployment region**: single-region (`ap-south-1`, Mumbai) confirmed for
  v1 — not just a deferred assumption. Multi-region/DR is explicitly out of
  scope until tenant scale or a specific customer/compliance requirement
  justifies the added operational cost (`docs/DEVELOPMENT.md` §6).
- **Pricing / plan tiers**: deferred — no plan-tier gating (doctor count
  caps, feature flags, usage limits) is designed into the v1 schema or API.
  `tenants` (`docs/DATABASE.md` §3) is intentionally a small, additive
  table — a `plan_tier` field and any associated limit-enforcement logic
  can be added later without restructuring tenant/clinic/doctor
  relationships, since nothing else in the schema currently depends on
  plan tier.
- **Patient self-service web portal**: confirmed **out of v1, planned for a
  later phase** — not speculative, but deliberately sequenced after the
  channels in this scope. WhatsApp and WordPress are the only
  patient-facing booking channels for v1; patients never authenticate into
  anything in this phase — they stay anonymous-until-booking, identified by
  phone (WhatsApp) or whatever the WordPress widget collects.
  `domain-identity` therefore only needs to handle dashboard
  staff/doctor/admin auth for v1 (`docs/SECURITY.md` §1). When the portal
  phase starts, it adds patient authentication (OTP over WhatsApp/SMS or a
  magic link, never a password), a patient session model scoped strictly to
  that patient's own resources (no RBAC matrix needed — always self-scoped,
  a narrower trust tier than staff roles), and a new `apps/patient-portal`
  frontend calling the same booking endpoints WordPress and WhatsApp already
  use (`docs/API.md` §4) — no new booking logic, only a new authenticated
  entry point onto the existing engine.

### Implementation phases

1. Core engine + dashboard: schema, appointment engine, RBAC/tenant
   isolation, admin dashboard CRUD — no external channels yet.
2. WordPress channel: plugin + widget against the same booking API.
3. WhatsApp channel: webhook, conversation engine, template approval
   (start this with Meta early — longest external lead time).
4. Calendar sync: Google first, then Microsoft Graph.
5. Notifications hardening: reminders, data-minimization review, delivery
   failure fallback.
6. Production hardening: security review pass, load-testing the
   concurrency guarantees, observability, Jenkins/EKS deploy pipeline
   finalized.
7. **(Post-v1) Patient self-service portal**: patient auth (OTP/magic-link),
   patient session model, `apps/patient-portal` frontend — reusing the
   existing booking API, no changes to the appointment engine itself.
