# Local development

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 10 (`corepack enable`)
- PostgreSQL 16 and Redis 7. You can use local binaries (below) or `docker compose -f docker-compose.dev.yml up -d`.

## 1. Install

```bash
pnpm install          # also runs prisma generate via the db build when needed
cp .env.example .env  # defaults match the local cluster below
```

## 2. Database (local binaries, no Docker)

The foundation was built against a throwaway cluster on **port 5433**, stored under `/tmp`:

```bash
# as a non-root user (initdb refuses to run as root; use `su postgres -c '…'` if needed)
mkdir -p /tmp/ngao-pg
/usr/lib/postgresql/16/bin/initdb -D /tmp/ngao-pg/data -U postgres --auth=trust -E UTF8
/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/ngao-pg/data -o "-p 5433 -k /tmp/ngao-pg" -l /tmp/ngao-pg/pg.log start

# roles + databases (ngao = owner/migrations, ngao_app = runtime with RLS enforced)
psql -h 127.0.0.1 -p 5433 -U postgres -f scripts/db-bootstrap.sql
```

| Purpose | Connection string |
| --- | --- |
| Migrations and seed (owner, bypasses RLS) | `postgresql://ngao:ngao_dev_owner@127.0.0.1:5433/ngao360` |
| API runtime (`ngao_app`, RLS enforced) | `postgresql://ngao_app:ngao_dev_app@127.0.0.1:5433/ngao360` |
| Integration tests | the same users on database `ngao360_test` |

Redis: `redis-server --port 6379 --daemonize yes`. You can also set `QUEUES_ENABLED=false` to run without Redis.

```bash
pnpm db:migrate   # prisma migrate deploy (init + RLS/integrity + later migrations)
pnpm db:seed      # synthetic demo data (idempotent)

# test database for integration tests
DATABASE_URL=postgresql://ngao:ngao_dev_owner@127.0.0.1:5433/ngao360_test \
  pnpm --filter @ngao360/db exec prisma migrate deploy
```

## 3. Run

```bash
pnpm dev          # turbo: shared/db watch builds, API on :4000, web on :3000
```

Open http://localhost:3000. The web app proxies `/api/*` to `API_INTERNAL_URL`.

### Demo accounts (synthetic)

Organisation code: `demo`. Every password is `SEED_DEMO_PASSWORD`, which defaults to `Demo-Password-2027`.

| Email | Role | MFA |
| --- | --- | --- |
| `owner@demo.example.org` | Organisation owner | TOTP |
| `director@demo.example.org` | Campaign director | TOTP |
| `supervisor@demo.example.org` | Tally supervisor | TOTP |
| `verifier@demo.example.org` | Results verifier (organisation-wide) | TOTP |
| `verifier.north@demo.example.org` | Results verifier (Synthetic Constituency North only) | TOTP |
| `clerk@demo.example.org`, `clerk2@…` | Data-entry clerk | none |
| `agent1@demo.example.org`, `agent2@…` | Polling agent (one station each) | none |
| `legal@demo.example.org` | Legal/compliance officer | TOTP |
| `ops@demo.example.org`, `comms@…` | Operations director / Communications editor | none |

Other tenants:

- `platform`: `operator@platform.example.org` (platform operator)
- `other`: `owner@other.example.org`, used for cross-tenant tests

In development, privileged demo users share the TOTP secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`. Add it to any authenticator app, or generate a code with:

```bash
node -e 'const s=require("./packages/db/dist/security");console.log(s.totpAt("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", s.currentTotpStep()))'
```

The seed contains:

- one ACTIVE election cycle with `dataProvenance = SYNTHETIC`
- Bungoma county (public code 039) with synthetic constituencies, wards, centres and 16 stations in an APPROVED registry
- three tally centres
- a Governor contest with four synthetic candidates
- APPROVED form templates 37A, 37B and 37C

## 4. Checks

```bash
pnpm typecheck
pnpm lint
pnpm test                  # unit tests; API DB integration tests run when TEST_* URLs are set
pnpm --filter @ngao360/api test:integration   # loads .env (TEST_DATABASE_URL, TEST_APP_DATABASE_URL)
pnpm build
```

## 5. Working with the schema

- Edit `packages/db/prisma/schema.prisma`, then run `pnpm db:migrate:dev --name <change>`. It uses a shadow database, so the owner role needs `CREATEDB`, which the bootstrap grants.
- **Never edit an existing migration.** Add a new one.
- New tenant-owned tables must have a `tenant_id uuid` column. Add `SELECT ngao_enable_tenant_rls('<table>');` to the migration SQL.
- Append-only tables need a trigger with `ngao_reject_modification()` and `REVOKE UPDATE, DELETE` from `ngao_app`.
- Prisma cannot express the partial unique indexes and CHECK constraints in `20261120000100_rls_and_integrity`. Prisma 6 does not try to drop them in diffs, but always review generated SQL before committing.
- Keep enum values in step with `packages/shared/src/enums.ts`. `packages/shared/src/shared.test.ts` fails if they drift.
- Prisma blocks `prisma migrate reset` when run by an automated agent. To start over locally, a person should drop and recreate the dev database (`dropdb`/`createdb` as `ngao`), then run `pnpm db:migrate && pnpm db:seed`.

## 6. Writing API endpoints (module agents)

```ts
@Controller('tally/submissions')
export class SubmissionsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get(':id')
  @RequirePermission('tally.view', { geo: { kind: 'submission', from: 'params', key: 'id' } })
  get(@Param(new ZodPipe(IdParamSchema)) { id }: IdParam, @CurrentAuth() auth: AuthContext) { … }

  @Post(':id/transition')
  @RequirePermission(['tally.capture', 'tally.verify', 'tally.exclude', 'tally.approve'], { anyOf: true })
  transition(@Param(new ZodPipe(IdParamSchema)) { id }: IdParam, @Body() dto: SubmissionTransitionDto, @CurrentAuth() auth: AuthContext) {
    return this.prisma.tenantTx(async (tx) => {
      const before = await tx.resultSubmission.findUniqueOrThrow({ where: { id } });
      // …check canTransitionSubmission, permissions for target, SoD…
      const after = await tx.resultSubmission.update({ where: { id, version: before.version }, data: { status: dto.to, version: { increment: 1 } } });
      await this.audit.record({ tenantId: auth.tenantId, action: AUDIT_ACTIONS.SUBMISSION_STATUS_CHANGED, entityType: 'ResultSubmission', entityId: id, before: { status: before.status }, after: { status: after.status }, reason: dto.reason }, tx);
      return after;
    });
  }
}
```

- Define DTO classes with `createZodDto(SchemaFromShared)`.
- Throw `AppException.*` for expected errors. Use `AppException.separationOfDuties()` for SoD violations.
- Register geo resolvers in `onModuleInit` with `GeoScopeService.register(kind, resolver)`.
- Queues are already registered: `OCR_QUEUE`, `REGISTRY_IMPORT_QUEUE`, `TALLY_EXPORT_QUEUE` and `NOTIFICATION_QUEUE`. Inject them with `@Optional() @InjectQueue(NAME)`.

## 7. Troubleshooting

- **`APP_DATABASE_URL not set` warning.** The API is connecting as the owner, so RLS is not enforced. Set `APP_DATABASE_URL` to the `ngao_app` role.
- **403 `CSRF_HEADER_MISSING`.** Send `x-ngao-client: web` on non-GET requests. The web `api` client does this automatically.
- **403 `MFA_REQUIRED`.** The user holds a privileged role. Sign in through the MFA step.
