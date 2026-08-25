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
# --legacy: pnpm v10 defaults `deploy` to requiring
# inject-workspace-packages=true (hard-linked workspace deps) unless told
# otherwise; the legacy behavior (resolving workspace deps like any other
# dependency, no extra .npmrc config needed) is what this build actually
# wants - a fully self-contained /prod/api with no symlinks back into the
# monorepo, which is copied into a fresh runtime stage below.
RUN pnpm --filter @app/api deploy --prod /prod/api --legacy

FROM base AS runtime
ENV NODE_ENV=production
# Prisma's runtime engine-selection needs the `openssl` package present to
# correctly detect the OpenSSL version on this image and load the matching
# query engine binary (schema.prisma's binaryTargets already includes
# linux-musl-openssl-3.0.x, which node:20-alpine's OpenSSL 3.x satisfies) -
# without this, detection falls back to guessing an OpenSSL 1.1.x engine,
# which fails to load since this Alpine version has no libssl.so.1.1 at
# all. https://pris.ly/d/alpine
RUN apk add --no-cache openssl
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /prod/api .
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
