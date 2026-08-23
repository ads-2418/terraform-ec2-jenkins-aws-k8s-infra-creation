# Development, Testing & Deployment

## 1. What this repository already provides

Root-level Terraform (`main.tf`, `outputs.tf`, `vars/dev-west-2.tfvars`) and
`install_jenkins.sh` provision a single EC2 instance running Jenkins (port
8081) with Docker, `kubectl`, `eksctl`, and the AWS CLI pre-installed. That
instance is the CI/CD control plane: it is used (via `eksctl`, run as a
pipeline step, not by Terraform itself) to create/manage the EKS cluster
the SaaS backend deploys onto, and Jenkins is the pipeline runner for
build → test → image push → deploy. Nothing about that provisioning changes
in this proposal — the application build below adds `/apps`, `/packages`,
`/infra` alongside it, and a Jenkinsfile that runs *on* the existing Jenkins
host.

## 2. Local development environment

Prerequisites: Node.js 20 LTS, pnpm, Docker + Docker Compose.

`infra/docker/docker-compose.dev.yml` brings up everything a developer needs
without touching AWS:

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:15` | primary database, RLS-enabled schema applied via Prisma migrate |
| `redis` | `redis:7` | BullMQ queues, cache, session/hold-adjacent fast paths |
| `mailhog` | `mailhog/mailhog` | captures outbound email locally instead of hitting a real provider |
| `api` | built from `infra/docker/api.Dockerfile` | the Gateway + domain modules |
| `worker` | built from `infra/docker/worker.Dockerfile` | BullMQ consumers |

```bash
cp .env.example .env          # fill in local values; never commit .env
pnpm install
pnpm --filter @app/db migrate:dev
pnpm --filter @app/db seed      # demo tenant, clinic, doctor, patient, services
docker compose -f infra/docker/docker-compose.dev.yml up -d postgres redis mailhog
pnpm --filter @app/api dev
pnpm --filter @app/worker dev
```

### External integrations locally

- **Google/Microsoft OAuth**: use each provider's sandbox/dev app
  credentials pointed at a tunnel (e.g. `ngrok`/`cloudflared`) for the
  OAuth redirect and webhook callback URLs — cloud providers cannot reach
  `localhost` directly. Documented per-provider setup lives in each
  package's README, not duplicated here.
- **WhatsApp Cloud API**: Meta's test number + a tunnel for the webhook URL;
  the `whatsapp-inbound` dedup logic (`docs/WHATSAPP.md` §4) is exercised
  with Meta's webhook test-send tool.
- **Email**: MailHog captures everything by default in dev — no real
  provider credentials needed to develop notification flows end-to-end.
- **WordPress plugin**: a local `wp-env` (or any local WP install) with the
  plugin pointed at `http://localhost:<api-port>` via its settings screen,
  using a dev-issued API key from the seeded tenant.

### Seed data discipline

The seed script creates one demo tenant with one clinic, two doctors
(distinct availability templates), a handful of services, and a few demo
patients — enough to exercise the full booking → hold → confirm → reminder
→ calendar-sync loop locally. No production data, credentials, phone
numbers, or calendar/tenant/doctor IDs are ever hard-coded into the seed
script or into any test fixture — all IDs are generated at seed/test time.

## 3. Testing strategy

| Layer | Tooling | What it covers |
|---|---|---|
| Unit | Vitest | `packages/domain-*` pure logic in isolation — state machine transitions, availability-window math, template rendering — no I/O, no database |
| Repository/integration | Vitest + Testcontainers (real Postgres + Redis, not mocks) | Prisma queries, RLS policies actually deny cross-tenant reads, unique-constraint behavior, idempotency-key replay, transactional hold logic |
| **Concurrency** | Vitest + Testcontainers, purpose-built suite | Fires N parallel `holdSlot()` calls at the identical doctor+time and asserts exactly one succeeds — this is the test that actually proves the double-booking guarantee in `docs/APPOINTMENT_ENGINE.md` §4, not just a unit test of the happy path |
| Contract | Vitest + `nock`-style HTTP mocking, recorded fixtures | Google/Microsoft/WhatsApp/email provider client wrappers, against fixture responses captured from each provider's docs/sandbox — verifies our parsing, not the provider's uptime |
| Sandbox smoke (optional, gated) | Same contract suite, `RUN_LIVE_SANDBOX=1` | A small subset run against each provider's real sandbox/test credentials — not part of the default CI run (would make CI flaky/slow/rate-limited), run on a schedule or before a release |
| API/E2E | Supertest against a running `apps/api` + real Postgres/Redis in CI | Full request→response for the booking endpoints (`docs/API.md` §4), including idempotency-key replay and RBAC/tenant-isolation denial cases |
| WhatsApp conversation flow | Vitest, simulated inbound webhook payloads through the real state machine | Full menu→slot→confirm and reschedule/cancel flows, plus dedup-on-retry |
| WordPress plugin | PHPUnit, HTTP client mocked at the boundary | Widget rendering and correct proxying to the API — no business logic to test here by design (`docs/API.md` §5) |
| Frontend | Vitest + Testing Library; Playwright for critical-path E2E (login, book from dashboard, connect calendar) | Admin dashboard |

CI (Jenkins, §5) runs unit + repository/integration + contract + API/E2E on
every PR; sandbox smoke and Playwright E2E run on merge to main / before
release, not on every PR, to keep PR feedback fast.

## 4. Docker architecture

Multi-stage Dockerfiles per deployable (`infra/docker/api.Dockerfile`,
`worker.Dockerfile`, `admin-dashboard.Dockerfile`):

```
FROM node:20-alpine AS build
# install full workspace deps, run turbo build for the target app+its
# package deps only (turbo's pruned-subgraph install keeps this minimal)

FROM node:20-alpine AS runtime
# copy only the pruned build output + production node_modules
# non-root user, read-only filesystem where the app allows it
# HEALTHCHECK hitting the app's own /healthz
```

- `apps/api` and `apps/worker` are **separate images** despite sharing all
  their domain package code — they scale independently in production (API
  on request rate, worker on queue depth) and a worker crash-loop can't take
  the request-serving path down with it.
- `admin-dashboard` builds to static assets served via a minimal Nginx
  image (or an S3+CloudFront static hosting path in production — either is
  compatible with this build; the Helm chart, §5, targets the Nginx-image
  path for parity with local dev).
- Local Compose networks all services together with fixed hostnames
  (`postgres`, `redis`) so `.env.example` values work unmodified for every
  developer.

## 5. Production deployment

```mermaid
flowchart LR
    DEV[Developer PR] --> GH[GitHub]
    GH --> JENKINS[Jenkins\n(EC2, this repo's Terraform)]
    JENKINS -->|test| TESTS[Unit/Integration/Contract/E2E]
    JENKINS -->|build & push| ECR[(Amazon ECR)]
    JENKINS -->|prisma migrate deploy| RDS[(RDS PostgreSQL\nMulti-AZ)]
    JENKINS -->|helm upgrade| EKS[EKS Cluster]
    EKS --> API[apps/api Deployment]
    EKS --> WORKER[apps/worker Deployment]
    EKS --> DASH[admin-dashboard Deployment]
    ESO[External Secrets Operator] -->|sync| EKS
    SM[(AWS Secrets Manager)] --> ESO
    ALB[ALB + WAF] --> API
    ALB --> DASH
    API --> RDS
    WORKER --> RDS
    API --> ELASTICACHE[(ElastiCache Redis)]
    WORKER --> ELASTICACHE
```

- **Jenkins pipeline** (`infra/jenkins/Jenkinsfile`): lint → typecheck →
  unit/integration/contract/API tests (spinning up ephemeral
  Postgres/Redis via Testcontainers, same as local) → build images → push
  to ECR (tagged by commit SHA, immutable) → `prisma migrate deploy`
  against the target environment's RDS → `helm upgrade --install` per
  deployable into the target namespace. Credentials the pipeline needs
  (ECR push, kubeconfig, DB migration user) are Jenkins credential bindings,
  never plaintext in the Jenkinsfile.
- **Environments**: separate Kubernetes namespaces (and separate RDS/
  ElastiCache instances) for `dev`, `staging`, `prod` — promotion is the
  same image tag moving through environments, not a rebuild, so what's
  tested is exactly what ships.
- **Database**: managed RDS PostgreSQL, Multi-AZ in staging/prod, automated
  backups + point-in-time recovery enabled; local/dev Compose Postgres is
  for developer convenience only and never in the promotion path.
- **Redis**: managed ElastiCache, used for BullMQ queues, availability
  cache (`docs/APPOINTMENT_ENGINE.md` §7), rate-limit counters, and
  WhatsApp/dashboard session state.
- **Secrets**: AWS Secrets Manager → External Secrets Operator →
  Kubernetes `Secret` objects (`docs/SECURITY.md` §5) — no secret material
  in Helm `values.yaml` files committed to the repo.
- **Networking**: ALB + AWS WAF in front of `apps/api` and
  `admin-dashboard`; Kubernetes NetworkPolicies restrict pod-to-pod traffic
  to declared dependencies (`docs/SECURITY.md` §11).
- **Scaling**: Horizontal Pod Autoscaler on `apps/api` (CPU/request-rate)
  and on `apps/worker` (custom metric: BullMQ queue depth, via a metrics
  exporter) — booking traffic and calendar-sync/notification backlogs don't
  scale together, so they shouldn't share a scaling policy.
- **Observability**: structured JSON logs (with `requestId` correlation,
  `docs/API.md` §2) shipped to CloudWatch Logs; Prometheus + Grafana (or
  CloudWatch Container Insights) for metrics; OpenTelemetry tracing across
  API → domain modules → Postgres/external-provider calls, so a slow
  booking request can be traced through calendar-sync or WhatsApp-send
  latency specifically rather than guessed at.
- **Rollback**: Helm release history (`helm rollback`) plus immutable
  commit-SHA image tags makes rollback a redeploy of the previous known-good
  tag, not a rebuild.

## 6. What's deliberately deferred past v1 infra

Single-region deployment (`ap-south-1`, Mumbai, for India-latency and
data-residency reasons) is a **confirmed decision** for v1, not just a
placeholder assumption (`docs/ARCHITECTURE.md` §11). Multi-region
deployment, blue/green or canary rollout automation, and a dedicated
read-replica for reporting/analytics are not in the v1 production
architecture — Multi-AZ RDS within the single region gives adequate
availability for the initial customer base, and these are the first
infrastructure investments to revisit as tenant count/scale grows or a
specific customer/compliance requirement forces the question (see the
phased plan in `docs/ARCHITECTURE.md` §11).
