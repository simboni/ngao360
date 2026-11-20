# NGAO360

NGAO360 is an operations platform for campaign, election-day and office work. It includes **NGAO TALLY**, an independent, non-statutory system for parallel recordkeeping of result forms and checking them.

> NGAO TALLY is a parallel tally. It is never an official IEBC result. The IEBC is the sole authority for official declarations and certification.

- Product spec: [docs/BLUEPRINT.md](docs/BLUEPRINT.md). Confirmed scope: [docs/DECISIONS.md](docs/DECISIONS.md).
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- REST contract: [docs/API_CONTRACT.md](docs/API_CONTRACT.md)
- Local setup: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

```bash
pnpm install && cp .env.example .env
pnpm db:migrate && pnpm db:seed   # synthetic demo data only
pnpm dev                          # API :4000, web :3000
```

Workspace: `apps/api` (NestJS), `apps/web` (Next.js PWA), `packages/db` (Prisma and RLS), `packages/shared` (zod contracts), `packages/config`.
