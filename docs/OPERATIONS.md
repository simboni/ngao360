# NGAO360 operations: deployment artefacts, load test, backup and restore

Operational readiness for the pilot (roadmap stage 6). Procedures are in [RUNBOOKS.md](./RUNBOOKS.md).
All data used below is synthetic. Results were measured on 2026-11-21 in the build environment.

## 1. Deployment artefacts

| Artefact | What it is | Validation |
| --- | --- | --- |
| `apps/api/Dockerfile` | Multi-stage. `build` (full workspace, turbo build) → `deploy` (`pnpm deploy --prod`, generated Prisma client copied in) → targets `api` (default, `PROCESS_ROLE=api`), `worker` (`dist/worker.js`, heartbeat health check) and `migrate` (`prisma migrate deploy`). Runtime: `node:22-bookworm-slim`, tini, application tree owned by root, process runs as uid 1000. | hadolint 2.15.1: clean. The `pnpm deploy` tree was built locally and started (`/api/health` ok; `prisma migrate status` from it ok). **Image not built** (no Docker daemon). |
| `apps/web/Dockerfile` | Next.js standalone, tini, uid 1000, only `.next/cache` writable (tmpfs in compose). | hadolint clean; not built. |
| `docker-compose.prod.yml` | Postgres 16 (data checksums, tuned memory, slow-query log), Redis with password and AOF, MinIO, `minio-init` (Object Lock bucket, COMPLIANCE default retention, scoped app user without delete, read-only backup user), clamd (always on), one-shot `migrate`, `api` ×2 (HTTP only), `worker`, `web`, Caddy (`deploy/caddy/Caddyfile`, DNS-discovered API replicas, health checks, cookie/authorization headers dropped from logs), `backup` (profile `ops`). Application containers: `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`. Networks: `backend` is `internal` (no route out); only Caddy publishes ports. | Parsed and checked against the compose-spec JSON schema (only false positives from the 2020 schema: top-level `name`, duration format, `depends_on.required`). **`docker compose config` / `up` not run.** |
| `docker-compose.yml` | Existing single-host stack, updated to the new build targets (`migrate`, `api` with `PROCESS_ROLE=all`), Object Lock bucket and `S3_OBJECT_LOCK_MODE=COMPLIANCE`. | as above |
| `deploy/env.prod.example` | Every variable of the production stack, secrets empty. | — |
| `deploy/minio/*` | `init.sh` and the two bucket policies. | `sh -n`; not run against MinIO. |

### Process roles

`PROCESS_ROLE` (default `all`): `api` serves HTTP and produces jobs (queues registered, repeatable schedules
upserted) but runs no BullMQ processor; `worker` (`node dist/worker.js`) has no HTTP listener and runs the
OCR, registry-import and notification processors and the durable `platform-jobs` worker (outbox dispatch,
malware scans, retention, War Room recorder, comparison retries, reminders). Liveness: the worker touches
`WORKER_HEARTBEAT_FILE` every 15 s; its container health check fails after 60 s without a beat.
Tested: `src/queue/__tests__/process-role.spec.ts`; the load test runs one `api` and one `worker` process.

### S3 Object Lock for originals

With `STORAGE_DRIVER=s3` every object is written with `x-amz-object-lock-mode` and
`x-amz-object-lock-retain-until-date` (`S3_OBJECT_LOCK_MODE`, default `off`; `S3_OBJECT_LOCK_DAYS`, default
2555 ≈ 7 years) in addition to `If-None-Match: *`. At start-up the API reads the bucket's Object Lock
configuration and refuses to start if it is not enabled. In production with S3, mode `off` stops start-up
unless `S3_OBJECT_LOCK_ALLOW_OFF=true` (documented exception). COMPLIANCE retention cannot be shortened or
removed by anyone, the root account included: choose the days with the data protection officer (a
redacted-portal-photo blob also stays until its retention ends; it is unlinked and never served).
Tests: `src/storage/__tests__/s3-object-lock.spec.ts` (command input, serialised headers including the
integrity checksum S3 requires, start-up check, production rule) with a mocked S3 client.

## 2. Load test

### Setup

- `scripts/load/setup-load-db.sh` creates `ngao360_load` (refuses any database name without "load"),
  migrates it, runs the standard synthetic seed with pre-enrolled demo TOTP, then
  `scripts/load/seed-load.sql`: registry version `LOAD-55K` (55,000 stations in 290 constituencies,
  1,450 wards and 18,848 centres, all under one county so the seeded Governor contest spans the whole
  registry, i.e. the size of a national presidential tally), 45,621 result forms (35,269 VERIFIED with a PASS
  verification, ~4,000 in the verification queue, the rest captured / submitted / disputed, ~540
  duplicates), 343,136 result values, 49,460 agents and deployments, 63,429 field reports, 2,473
  incidents and 200 field-app accounts (one station each). Run time 40 s; database 363 MB.
- `scripts/load/run-load.sh` starts a private Redis (6380), the API with `PROCESS_ROLE=api` and a separate
  worker on the load database (production mode, Redis rate-limit store), then drives it with
  `scripts/load/run-load.mjs` (closed-loop virtual users, no think time, keep-alive). Results land in
  `.load/results-*.json`. Options: `LOAD_DURATION_S`, `LOAD_SCENARIOS`, `LOAD_CONCURRENCY_<SCENARIO>`,
  `LOAD_MIX=1` (all scenarios at once), `LOAD_API_INSTANCES`, `LOAD_DB_POOL`.
- Load-only overrides: the per-IP global limit is raised (one client IP drives every virtual user),
  access tokens live an hour. Everything else is the production configuration.
- Machine: 4 vCPU, 16 GB RAM; PostgreSQL 16 with default settings (`shared_buffers` 128 MB); the API,
  worker, Postgres, Redis and the load driver all share the 4 vCPUs. Absolute numbers are therefore a
  floor, not a capacity statement for production hardware.

| Scenario | Request | User |
| --- | --- | --- |
| tally-intake | `POST /tally/submissions` (≈ 60 KB PNG with unique bytes, new idempotency key, station without a form) | clerk |
| verify-queue | `GET /tally/submissions?view=awaiting_me` (page 1 of 25) | verifier |
| aggregate | `GET /tally/results/live` (55,000-station denominator) | tally supervisor |
| warroom-overview | `GET /warroom/overview` | War Room commander |
| warroom-stations | `GET /warroom/stations?attentionOnly=true` (page of 50) | War Room commander |
| field-sync | `POST /field/sync` with 5 opening-of-polls reports | one polling agent per virtual user |

### Results: one scenario at a time

Baseline = the code on `main` (first run; 10–20 s per scenario). After = this branch (30 s per scenario,
`results-20261121T115716Z.json`). Latencies in ms.

| Scenario | VUs | Baseline req/s | Baseline p50 / p95 / p99 | Baseline errors | After req/s | After p50 / p95 / p99 | After errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tally-intake | 8 | 42.1 | 170 / 248 / 322 | 0 % | 61.5 | 118 / 164 / 198 | 0 % |
| verify-queue | 16 | 16.0 | 972 / 1,361 / 1,444 | 0 % | 46.2 | 338 / 513 / 633 | 0 % |
| aggregate | 8 | 3.6 | 2,081 / 3,090 / 3,483 | **100 % (500)** | 86.3 | 86 / 124 / 148 | 0 % |
| warroom-overview | 16 | 17.9 | 858 / 1,159 / 1,215 | 0 % | 151.2 | 91 / 124 / 186 | 0 % |
| warroom-stations | 16 | 19.3 | 392 / 5,687 / 5,953 | 0 % | 140.3 | 104 / 137 / 180 | 0 % |
| field-sync (×5 reports) | 16 | 16.6 | 823 / 1,860 / 2,304 | 0 % | 18.0 (90 reports/s) | 810 / 1,755 / 2,224 | 0 % |

The blueprint 16.1 planning target (p95 < 700 ms for common reads) is met by every read scenario.
A cold live aggregate (cache miss) takes about 1.5 s for 55,000 stations; the max column of the
aggregate run (1.4 s) is that first computation.

### Results: mixed election-night profile

Everything at once for 60 s: 4 intake clerks, 4 verifiers, 4 aggregate viewers, 8 War Room overview and 4
station-list viewers, 8 polling agents syncing (32 closed-loop users with no think time ≈ several hundred
real users), API pool 40 connections, one API process.

| Scenario | `TALLY_AGGREGATE_MAX_STALE_SECONDS=0` req/s · p50 / p95 / p99 | `=5` req/s · p50 / p95 / p99 |
| --- | --- | --- |
| tally-intake | 3.6 · 916 / 2,354 / 2,696 | 5.9 · 583 / 1,167 / 2,180 |
| verify-queue | 8.1 · 393 / 1,260 / 1,554 | 12.4 · 279 / 589 / 1,009 |
| aggregate | 0.8 · 5,336 / 6,033 / 6,056 | 8.4 · 230 / 2,245 / 4,285 |
| warroom-overview | 12.2 · 454 / 1,643 / 2,875 | 21.1 · 287 / 836 / 2,268 |
| warroom-stations | 6.2 · 438 / 1,779 / 2,643 | 10.8 · 296 / 674 / 1,989 |
| field-sync (×5) | 1.8 · 2,531 / 12,812 / 14,682 | 2.4 · 3,473 / 7,388 / 8,660 |

No errors in either run. With strict freshness every intake changes the contest's data stamp and the
55k-station aggregate is recomputed for nearly every viewer request; five seconds of tolerated staleness
(the response's `computedAt` shows it) multiplies aggregate throughput by ten and relieves every other
path. In the mixed runs the single API process is CPU-bound (≈ 110 % CPU, Postgres connections idle in
transaction waiting for Node): most of it is per-request authentication and transaction round trips
through the query engine plus garbage collection. A second API process on the same 4 vCPUs did not help
(the box was saturated); on production hardware run at least two API replicas on their own cores and
Postgres on its own host (RUNBOOKS, "Election-day operations").

### Hot spots found and fixed (with tests)

1. **Live aggregate failed above 32,767 stations** (`fix(tally)`): Prisma bound one parameter per station
   code and per verified submission; Postgres refuses more than 32,767, so every aggregate, breakdown and
   snapshot of a national-size contest answered 500. Rewritten to select the contest's forms with
   primary-key joins and match codes in memory; open discrepancy links read once per contest; only the
   aggregated fields loaded; hash joins forced for these contest-wide reads (stale statistics after a bulk
   insert produced 47–62 s nested loops in the regression test). Read paths share a cache keyed by tenant,
   contest, area and caller scope, reused only while the contest's data stamp is unchanged, with single
   flight. Regression test `apps/api/test/scale-hotspots.integration.spec.ts` (40,000 stations, 34,000
   verified forms; 500 before the fix).
2. **Verification queue counted duplicates over the whole table** (`perf(tally)`): a relation `_count`
   made Prisma `GROUP BY` all 47k submissions per page. Now the first duplicate id via a new partial index;
   new indexes for the queue's `NOT EXISTS` checks (migration `20261130000000_ops_load_test_indexes`).
3. **War Room stampede and per-request recomputation** (`perf(field)`): single flight for the 55k-station
   snapshot; per-caller views and counts memoised per snapshot (scope, tally scope and area in the key;
   tenants never share); overview tally counts cached for the snapshot's lifetime; the queue probe no
   longer opens a Redis connection per request. Tests `src/modules/field/warroom/__tests__/`.
4. **Pool exhaustion answered 500** (`fix(api)`): P2024 / P2028 "unable to start a transaction" are now
   503 `RATE_LIMITED` with `Retry-After: 2` (nothing was written). Test
   `src/common/http/__tests__/overload-503.spec.ts`.

### Open findings (not fixed here)

- **Field-report and form references serialise writes per tenant.** `nextReference()` increments one row
  of `reference_sequences` per prefix and year and holds its lock until the surrounding transaction commits
  (create, audit, detail read, ledger). Sync throughput is therefore ~90 reports/s per tenant on this box
  regardless of the number of agents, and under CPU pressure lock hold times grow (mixed run p95 7–13 s).
  90 reports/s is ~320,000 per hour, above the expected peak of 55,000 stations × a few reports, but a
  burst after a network outage will queue. Options: allocate the reference in a short separate
  transaction (gaps possible on rollback) or move the reference to a sequence per prefix; needs a
  decision because references are user-visible.
- **Authentication costs a transaction per request** (session, security policy, user, grants). Not cached
  on purpose (revocation and policy changes apply on the next request); it is the largest share of API CPU
  under mixed load.
- **Synthetic seed on a fresh database stops** at the campaign ledger seed (an entry is approved before a
  CLEAN supporting document exists; trigger from `20261129000200_platform_infra_clean_ledger_documents`).
  A second run completes; `setup-load-db.sh` retries once. Owner: the seed.
- Statistics: right after approving a new registry version or a bulk import, run `ANALYZE` (RUNBOOKS);
  the aggregate and War Room force hash joins, other paths rely on fresh statistics.
- Registry import of 55k rows through the HTTP import (queued) was not timed here (the load registry was
  inserted with SQL).

## 3. Backup and restore drill

`scripts/ops/backup.sh` and `scripts/ops/restore-drill.sh` (see the headers for every variable).

**Backup.** One `REPEATABLE READ` transaction exports its snapshot; `pg_dump --format=custom
--snapshot=…` and every metadata query import it, so the dump and the metadata describe the same state
while the API keeps writing. Written next to the dump: exact row counts per table, the list of tables with
RLS, the audit chain digest (SHA-256 over `seq:event_hash` in `seq` order) and head, a storage manifest
(every `stored_files` row with key, SHA-256, size and scan status). For the local driver every blob is
re-hashed against the manifest and copied; a mismatch or a missing original fails the backup (missing
can be allowed explicitly and is then listed). `SHA256SUMS` covers every file; `backup.json` summarises.
With S3 the originals are versioned and under Object Lock; replicate the bucket separately
(RUNBOOKS) and let the drill spot-check it with `mc`.

**Drill.** Verifies `SHA256SUMS`; restores into a new `ngao360_restore_<timestamp>` database (never the
live one); compares exact row counts per table; compares the RLS table list and checks that every table
with `tenant_id` has RLS; recomputes every audit event's `event_hash` and payload hashes
(`scripts/ops/audit-verify.cjs`, kept in step with `AuditService` by `apps/api/test/ops-audit-verify.spec.ts`)
and the chain digest; checks the append-only trigger refuses an `UPDATE`; compares the stored-file manifest;
re-hashes a random sample of originals from the backup copy and from live storage; connects as `ngao_app`
and checks it is neither superuser nor `BYPASSRLS`, sees no tenant rows without a tenant setting and no
other tenant's rows in any of the 115 tenant tables with tenant A set, sees exactly tenant A's stored files,
and cannot update the audit log. Writes `restore-report.json` and drops the scratch database.
Negative checks: a tampered row count and chain digest are reported as failures; a modified dump is
refused before restoring.

### Drill results (2026-11-21, local PostgreSQL 16.15)

| Database | Backup time | Dump | Backup folder (with blobs) | Rows / tables | Audit events | Originals | Drill time (restore) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ngao360` (development seed + rehearsal data) | 19.5 s (blob re-hash 17 s) | 15.5 MB | 98 MB | 196,891 / 118 | 44,090, all re-hash, digest `186e1ad3…` | 2,314: all re-hashed at backup, 200 sampled at restore (backup copy and live) | 4.9 s (1 s) | **passed**, all 14 checks |
| `ngao360_load` (55k stations) | 24.2 s | 45.3 MB | 257 MB | 851,015 / 118 | 8,936, digest `5c0e9ec7…` | 48,070 rows; 45,621 synthetic rows have no blob by design (allowed and reported), 2,449 re-hashed, 200 sampled | 6.3 s (4 s) | **passed** (warning for the known synthetic missing blobs) |

Record each production drill in S30 (`POST /workspace/backup/verifications`, outcome `RESTORED_OK`): the S03
onboarding step "restore test in the last 90 days" reads it.
