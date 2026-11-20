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

Organisation code `demo`. The password for every account is `SEED_DEMO_PASSWORD`, which defaults to `Demo-Password-2027` and must be set when `NODE_ENV=production`. The full list of accounts is in the [README](../README.md#demo-accounts-synthetic). There are 15 demo users, one for each tenant role, plus `platform` (platform operator) and `other` (used to test cross-tenant isolation).

MFA for privileged demo users (owner, director, verifiers, supervisor, legal, finance) is controlled by `SEED_DEMO_MFA`:

- `disabled` (default): no authenticator is seeded. Users whose role requires MFA set one up the first time they sign in.
- `preenrolled` (development only): those users share the TOTP secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`. Add it to any authenticator app, or generate a code with:

```bash
SEED_DEMO_MFA=preenrolled pnpm db:seed
node -e 'const s=require("./packages/db/dist/security");console.log(s.totpAt("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", s.currentTotpStep()))'
```

The seed is idempotent and contains:

- the tenant "Demo Organisation" with the ACTIVE cycle "2027 General Election" (10 Aug 2027, `dataProvenance = SYNTHETIC`);
- all 47 counties (real public codes) and a synthetic Bungoma registry: 9 constituencies, 45 wards, 90 centres and 153 stations in an APPROVED registry version (`SYNTHETIC-2027-R1`), loaded through the same validation as a CSV import;
- 10 tally centres (one for each constituency, plus the county centre) and a Governor contest with four fictional candidates;
- form templates for all 22 forms of the 34–39 series. The Governor series (37A/B/C, plus 37D as a reference-only certificate) is approved by the legal officer, not by its creator; the others are awaiting approval.
- the NGAO360 Office tenant `bungoma-governor` (synthetic County Governor's office): `office` module and public portal on, `tally` off; Bungoma county with the synthetic constituencies and wards; 18 synthetic institutions; one user per office role (see the README); 25 citizen cases across every stage, 15 correspondence items, 10 appointments, 2 meetings and 12 projects with milestones and evidence. Evidence files are small synthetic PNGs and PDFs written under `apps/api/storage` (override with `SEED_STORAGE_ROOT`) with the same content-addressed keys the API uses. The seed prints one synthetic public reference and tracking code for `/p/bungoma-governor/track`.

### OCR

`OCR_PROVIDER=none` (default) means every value is captured by hand. `OCR_PROVIDER=stub` writes synthetic, low-confidence draft values (development only). In both cases OCR output is only ever a draft (`ocrValue`), never a confirmed value. With Redis queues enabled the OCR worker runs the provider; with `QUEUES_ENABLED=false` it runs in process.

### Synthetic form images

`fixtures/forms/` holds plain mock-ups of a Governor 37A and 37B, each labelled "SYNTHETIC REHEARSAL COPY – NOT AN IEBC FORM". The printed figures are in `governor-rehearsal.json`. To regenerate them (requires Pillow):

```bash
pnpm fixtures:forms
```

## 4. Checks

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test             # every package; API DB integration tests run when TEST_* URLs are set
                      # (export them, e.g. `set -a; . ./.env; set +a; pnpm test`)
pnpm --filter @ngao360/api test:integration   # loads .env: RLS, guards and the Governor rehearsal
pnpm test:rehearsal   # County Governor end-to-end rehearsal only
```

The test layers:

| Suite | Where | What |
| --- | --- | --- |
| Shared unit tests (vitest) | `packages/shared` | contracts, enums, registry CSV validation, rule evaluator, SoD rules |
| Web unit tests (node:test + tsx) | `apps/web/src/components/tally/__tests__` | capture model, verify model, forbidden wording |
| API unit tests (jest) | `apps/api/src/**/domain`, `rbac`, `audit` | validation engine, aggregation, separation of duties, guard |
| API integration (jest + supertest) | `apps/api/src/modules/*/__tests__`, `apps/api/test` | full HTTP stack against `ngao360_test`, with the runtime role under RLS |
| RLS and guards | `apps/api/test/rls.integration.spec.ts` | cross-tenant reads by id return nothing; append-only and immutability triggers |
| Governor rehearsal | `apps/api/test/governor-rehearsal.e2e.spec.ts` | the demo seed in a fresh synthetic tenant, with real sign-in and TOTP, and the 37A/37B flow from start to finish |
| Browser smoke (Playwright) | `scripts/smoke/web-smoke.cjs` | clerk inbox and capture image, supervisor results banner; writes `docs/screenshots/` |

Integration suites create their own synthetic tenants with random slugs in `ngao360_test` and do not delete them. Recreate the test database whenever you want a clean one.

### Browser smoke test

Start the API and web app against a database seeded with `SEED_DEMO_MFA=preenrolled`. Then run:

```bash
pnpm build
set -a; . ./.env; set +a
(cd apps/api && node dist/main.js) &
(cd apps/web && npx next start -p 3000) &
pnpm smoke:web
```

The smoke test needs Playwright with Chromium; `require('playwright')` must resolve. Each run uploads one synthetic 37A as the demo clerk, so a second run against the same database shows a "possible duplicate", which is the intended behaviour.

## 5. Working with the schema

- Edit `packages/db/prisma/schema.prisma`, then run `pnpm db:migrate:dev --name <change>`. It uses a shadow database, so the owner role needs `CREATEDB`, which the bootstrap grants.
- **Never edit an existing migration.** Add a new one.
- New tenant-owned tables must have a `tenant_id uuid` column. Add `SELECT ngao_enable_tenant_rls('<table>');` to the migration SQL.
- Append-only tables need a trigger with `ngao_reject_modification()` and `REVOKE UPDATE, DELETE` from `ngao_app`.
- Approved reference data is guarded in the database (`20261120000300_registry_imports_and_reference_guards`). Polling stations can change only while their registry version is DRAFT. An APPROVED registry version can only become SUPERSEDED. An APPROVED form template can only become RETIRED. Test fixtures must add stations before approving the version.
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
- **401 `REAUTH_REQUIRED`.** High-risk actions need a password (and TOTP) check within the last 10 minutes: resolving discrepancies, exports, releases, approvals and role changes. Call `POST /auth/reauth`; the web app prompts automatically.
- **Web pages load without styles or scripts (static chunks return 400).** An older `next start` is still holding port 3000 with a previous build. Stop it (`ss -ltnp | grep :3000`) and start it again after `pnpm build`.
- **`IMMUTABLE_RECORD: polling stations can only change in a DRAFT registry version`.** Create a new registry version and import into it; approved versions never change.
- **Uploaded originals.** With `STORAGE_DRIVER=local`, files are stored under `STORAGE_LOCAL_ROOT`, which is relative to the API's working directory (`apps/api/storage` under `pnpm dev`). They are content-addressed by SHA-256 and never overwritten.
