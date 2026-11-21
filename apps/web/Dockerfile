# syntax=docker/dockerfile:1.7
# NGAO360 web image (Next.js standalone). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t ngao360-web .
# Runs as the unprivileged `node` user with a read-only root filesystem; the only writable path is
# the Next.js cache (mount a tmpfs at /app/apps/web/.next/cache, as docker-compose.prod.yml does).
# Pin the base image by digest for releases: --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:...
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Rewrites are resolved at build time; in Compose, Caddy routes /api directly to the API.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@ngao360/web...

FROM ${NODE_IMAGE} AS runtime
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Application files are owned by root (read-only to the runtime user).
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p /app/apps/web/.next/cache && chown node:node /app/apps/web/.next/cache
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
