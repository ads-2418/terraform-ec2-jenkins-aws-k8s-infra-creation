# syntax=docker/dockerfile:1
# See api.Dockerfile for the build strategy explanation - identical
# pattern, different deploy target and no exposed port (the worker has no
# HTTP surface, docs/ARCHITECTURE.md §3).
#
# Build from the repo root:
#   docker build -f infra/docker/worker.Dockerfile -t healthcare-saas/worker .

FROM node:20-alpine AS base
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @app/db generate
RUN pnpm build
RUN pnpm --filter @app/worker deploy --prod /prod/worker

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /prod/worker .
USER app
CMD ["node", "dist/worker.js"]
