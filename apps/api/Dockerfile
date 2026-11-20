# syntax=docker/dockerfile:1.7
# NGAO360 API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t ngao360-api .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@ngao360/api...

FROM base AS runtime
ENV NODE_ENV=production
# The full workspace is kept so the same image can run `prisma migrate deploy`
# (migrate service) and the seed. Slim it with `pnpm deploy` once the image is stable.
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
