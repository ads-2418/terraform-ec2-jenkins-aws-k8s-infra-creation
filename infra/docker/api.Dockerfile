# syntax=docker/dockerfile:1
#
# Multi-stage build for apps/api - docs/DEVELOPMENT.md §4. Builds the whole
# workspace (simplest correct approach; a `turbo prune`-based pruned-
# subgraph build is the natural next optimization once build times matter)
# then uses `pnpm deploy` to produce a self-contained, production-only
# output directory for just this app and its actual dependency closure.
#
# Build from the repo root:
#   docker build -f infra/docker/api.Dockerfile -t healthcare-saas/api .

FROM node:20-alpine AS base
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Prisma's generated client is required for @app/db's own build (its
# source imports ../generated/client) - must run before any `pnpm build`.
RUN pnpm --filter @app/db generate
RUN pnpm build
RUN pnpm --filter @app/api deploy --prod /prod/api

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /prod/api .
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
