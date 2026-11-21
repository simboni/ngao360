# syntax=docker/dockerfile:1.7
# NGAO360 API and worker images. Build from the repository root:
#   docker build -f apps/api/Dockerfile --target api    -t ngao360-api .
#   docker build -f apps/api/Dockerfile --target worker -t ngao360-worker .
#   docker build -f apps/api/Dockerfile --target migrate -t ngao360-migrate .
#
# Stages:
#   build    full workspace install + turbo build (dev dependencies, never shipped)
#   deploy   `pnpm deploy --prod`: only the API's production dependency tree, plus the generated
#            Prisma client copied from the build (the deploy re-links packages without it)
#   api      HTTP only (PROCESS_ROLE=api), non-root, runs with a read-only root filesystem
#   worker   BullMQ processors and durable jobs, no HTTP (dist/worker.js), heartbeat health check
#   migrate  one-shot `prisma migrate deploy` as the schema owner (same slim tree)
#
# Pin the base image by digest for releases: --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:...
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@ngao360/api...

FROM build AS deploy
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @ngao360/api deploy --prod --legacy /out \
  && client_dir="$(ls -d /out/node_modules/.pnpm/@prisma+client@*/node_modules)" \
  && cp -r /repo/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma "$client_dir/" \
  && rm -rf /out/src /out/test /out/storage /out/Dockerfile /out/*.config.* /out/tsconfig*.json /out/nest-cli.json \
  && ln -s "$(ls -d /out/node_modules/.pnpm/prisma@*/node_modules/prisma)/build/index.js" /out/prisma-cli.js

FROM ${NODE_IMAGE} AS runtime-base
# openssl for the Prisma engine; tini reaps children and forwards signals for graceful shutdown.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=deploy --chown=root:root /out /app
# The application tree is owned by root and read-only to the runtime user.
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime-base AS migrate
ENV PROCESS_ROLE=worker
CMD ["node", "/app/prisma-cli.js", "migrate", "deploy", "--schema", "/app/node_modules/@ngao360/db/prisma/schema.prisma"]

FROM runtime-base AS worker
ENV PROCESS_ROLE=worker WORKER_HEARTBEAT_FILE=/tmp/ngao360-worker.alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const s=require('fs').statSync(process.env.WORKER_HEARTBEAT_FILE);process.exit(Date.now()-s.mtimeMs<60000?0:1)"]
CMD ["node", "dist/worker.js"]

# Default target: the HTTP API.
FROM runtime-base AS api
ENV PROCESS_ROLE=api API_PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
