# NGAO360 runbooks

Procedures for the pilot deployment (`docker-compose.prod.yml`, [OPERATIONS.md](./OPERATIONS.md)). Commands
assume the stack directory on the host and `C="docker compose -f docker-compose.prod.yml --env-file /etc/ngao360/.env.prod"`
(the env file lives outside the checkout, mode 600; `.env.prod` is git- and docker-ignored should a copy land in it).
Every step that changes production is done by two people (one runs, one checks and records). Never paste a
secret into a ticket, chat or this repository; refer to the vault entry instead.

Labelling rules that no procedure may relax: the parallel tally is an internal, unofficial record (never an
IEBC result); historical-demo and synthetic data keep their labels; tenancy, RBAC, separation of duties and
the append-only audit log are never bypassed to "fix" something quickly. Fixes go through the API or a
reviewed migration, not ad-hoc SQL as the owner role.

## 1. Deploy

**Before** (T-1 day for a release):

1. Release tag built and reviewed: CI green (`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`,
   rehearsals), images built from the tag with the base image pinned by digest
   (`--build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:…`), image digests recorded.
2. Read the release's migrations. Migrations are additive in this codebase; a migration that rewrites a
   large table or adds a non-concurrent index on `result_*`, `polling_stations`, `audit_events` or
   `field_reports` needs a maintenance window.
3. A backup from the last 24 h exists and its drill passed (section 6), or take one now:
   `$C --profile ops run --rm backup`.
4. `.env.prod` diff reviewed (names only in the review; values in the vault).

**Deploy:**

```bash
export NGAO_VERSION=<tag>
$C pull || $C build                      # images for the tag
$C run --rm migrate                      # prisma migrate deploy as the schema owner; stops on error
$C up -d --no-deps worker                # background work first (idempotent jobs)
$C up -d --no-deps --scale api=2 api     # replicas restart one by one behind Caddy (health checks)
$C up -d --no-deps web
$C ps                                    # all healthy; migrate exited 0
```

**Verify** (within 10 minutes): `curl -fsS https://$NGAO_DOMAIN/api/health` shows database, storage and redis
`up`; sign in as a test operator with MFA; open the War Room and the tally results page (unofficial banner
present); S30 integrations show the expected providers and no missing variables; `/platform/jobs` shows
recent SUCCEEDED runs; the API log has no start-up refusal (a selected provider missing a variable, an S3
bucket without Object Lock, production with lock mode `off` all stop start-up by design).

## 2. Rollback

Application rollback is safe because migrations are additive and the previous release ignores new columns
and tables:

```bash
export NGAO_VERSION=<previous tag>
$C up -d --no-deps worker api web
```

- Do **not** roll back migrations (no down migrations; history tables are append-only by trigger). If a
  migration itself is wrong, write a new forward migration.
- If a release wrote bad data, do not edit rows as the owner. Use the product's correction paths
  (reversing ledger entries, value changes with reasons, superseding registry versions, discrepancy cases);
  each is audited. Data loss or corruption beyond that → section 6 (restore) with the incident commander.
- Repeatable job schedules are upserted at start-up; a job retired in a newer release stays scheduled in
  Redis after rollback only if the older code still registers it. Check `/platform/jobs`.
- Record the rollback (release, time, reason) in the change log and, if users were affected, in the
  breach register as an availability incident when section 5 applies.

## 3. Key and secret rotation

Rotate on a schedule (12 months, or on staff departure with access to the vault) and immediately on
suspected compromise. Generate with `openssl rand -base64 32` (keys) or `-base64 48` (secrets), store in
the vault, update `.env.prod`, then restart the named services (`$C up -d --no-deps <services>`).

| Secret | Effect of rotating | Procedure |
| --- | --- | --- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Every session ends; users sign in again (with MFA). Signed local file URLs (5 min) stop working. | Rotate both, restart `api` and `worker`. Announce outside election day. |
| `POSTGRES_PASSWORD` (superuser `ngao`) | Used by no container except `postgres` itself (break-glass administration). | `ALTER ROLE ngao PASSWORD …` (as a superuser), update env. |
| `NGAO_OWNER_DB_PASSWORD` (schema owner `ngao_owner`, not a superuser) | Only `migrate` and `backup` use it. | `ALTER ROLE ngao_owner PASSWORD …`, update env; the next `migrate` / `backup` run uses it. |
| `NGAO_APP_DB_PASSWORD` (`ngao_app`) | API and worker reconnect. | `ALTER ROLE ngao_app PASSWORD …`, update env, restart `api` and `worker` immediately (old connections keep working until restart). |
| `REDIS_PASSWORD` | Queues, rate limits and job schedules pause during the restart; durable jobs resume. | Update env, `$C up -d redis api worker` together. |
| `S3_APP_SECRET_ACCESS_KEY`, `S3_BACKUP_SECRET_ACCESS_KEY`, `MINIO_ROOT_PASSWORD` | — | Update env, `$C run --rm minio-init` (resets the users to the env values), restart `api` and `worker`. Root: change in MinIO, then env. |
| `SMTP_PASSWORD`, `AFRICASTALKING_API_KEY`, `CAPTCHA_SECRET` | Messages wait in the outbox (retries with backoff) while the key is wrong; captcha refuses portal submissions (fail closed). | Rotate at the vendor, update env, restart `api` and `worker`, send a test message from S30 and check `/workspace/messages`. |
| `AFRICASTALKING_DLR_TOKEN` | Delivery reports and STOP replies to the old path token are refused. | Change the callback URLs at Africa's Talking in the same minute as the restart. |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` | Existing push subscriptions stop working; people must re-enable push. | Only on compromise. |
| `MESSAGING_ENCRYPTION_KEY`, `MESSAGING_HASH_KEY` | Sealed addresses / push endpoints and keyed address hashes (STOP replies, verified contacts). | Online, with re-encryption and re-hashing: section 3.1, `--target messaging` (rotate both together). |
| `MFA_ENCRYPTION_KEY` | TOTP secrets. Campaign identifier fingerprints are keyed with it unless `IDENTIFIER_FINGERPRINT_KEY` is set. | Online, with re-encryption: section 3.1, `--target mfa`. First set `IDENTIFIER_FINGERPRINT_KEY` to the **current** MFA key (fingerprints cannot be recomputed); the tool refuses otherwise. On compromise of the TOTP secrets themselves, also reset MFA for every user (admin screens), as re-encryption does not make leaked secrets safe. |
| `AGENT_DATA_KEY` | Agent national ID, phone, M-Pesa number and next of kin (column-level encryption) and their lookup hashes. | Online, with re-encryption: section 3.1, `--target agent-data`. Never lose it: without it the agent personal data is gone. |

After any rotation: check `/api/health`, sign in, send a test message, and record the rotation (who, when,
which secret, vault version) — never the value.

### 3.1 Key rotation with re-encryption (`pnpm ops:rotate-keys`)

For `MFA_ENCRYPTION_KEY`, `MESSAGING_ENCRYPTION_KEY` + `MESSAGING_HASH_KEY` and `AGENT_DATA_KEY`. The service keeps
running: while a rotation is under way the API reads with both the new key and `<NAME>_PREVIOUS`, writes with the new
one, and matches keyed hashes under both (STOP replies and opt-outs are never missed). Two people: one generates and
stores the new key in the vault, the other runs and checks the tool. Nothing secret is printed (counts and a key
identifier only); the checkpoint file holds row ids and counts, no data or keys.

1. **Prepare.** Generate the new key (`openssl rand -base64 32`; the hash key `-base64 48`), store it in the vault.
   For `MFA_ENCRYPTION_KEY`: if `IDENTIFIER_FINGERPRINT_KEY` is empty, set it to the current MFA key first and restart
   `api` and `worker` (campaign fingerprints keep working).
2. **Switch the API.** In `.env.prod` move the current value to `<NAME>_PREVIOUS` and put the new key in `<NAME>`
   (messaging: both `MESSAGING_ENCRYPTION_KEY*` and `MESSAGING_HASH_KEY*`). `$C up -d --no-deps api worker`. Check
   `/api/health` and a sign-in (MFA) / a test message / an agent reveal.
3. **Dry run.** `$C run --rm migrate node dist/cli/key-rotation.js --target <mfa|messaging|agent-data> --dry-run`
   (the `migrate` image contains the built API and gets the schema-owner `DATABASE_URL` and the same key variables
   as the API from `.env.prod`). It reports per
   table how many rows would be rewritten and how many are `unreadable` (sealed under neither key). Unreadable rows:
   stop and investigate (a key from an earlier rotation?) — they are never touched.
4. **Run.** `$C run --rm -v "$PWD/rotation:/rotation" migrate node dist/cli/key-rotation.js --target <target>
   --checkpoint /rotation/<target>.json` (the checkpoint survives the container in `./rotation`). Batches of 200 (`--batch-size`), one transaction each; each row is rewritten only if
   unchanged since it was read. Interrupted? Run the same command again: it resumes from the checkpoint. A checkpoint
   from another key or target is refused (`--reset-checkpoint` starts over; harmless, rows already under the new key
   are skipped). `--tenant <id>` limits a run to one organisation (staging only: it ends with `Tenant <id> complete`
   and exit 4, never `Complete`; the previous key may be retired only after a run without `--tenant`).
5. **Verify.** Run once more with `--reset-checkpoint` and without `--tenant`: it must print `Complete` (exit 0: every row in every tenant current, nothing
   unreadable, nothing changed during the run). Exit 2 means some rows still need the previous key: re-run, then
   investigate; do not retire the old key. For `agent-data`, add `--validate` once (it validates the database
   constraint that refuses plaintext; only without `--tenant`).
6. **Retire the old key.** Empty `<NAME>_PREVIOUS` in `.env.prod`, restart `api` and `worker`, check again, destroy
   the old key in the vault after the backup retention period (older backups are encrypted with it). Record the
   rotation.

Rows that are not re-keyed, by design: contact verifications for an address the person no longer has (only a hash is
stored; they are superseded on next use and never matched again), and campaign identifier fingerprints (step 1).
The first deployment of column encryption seals existing agent rows automatically at API start-up; step 5 with
`--target agent-data --validate` confirms it and validates the constraint.

### 3.2 First encrypted deployment: plaintext left behind

Sealing rewrites agent personal data in place. PostgreSQL keeps the old (clear) row versions in the table files until
they are vacuumed and overwritten, and every backup, WAL archive or point-in-time base backup taken **before** the
release holds national ID numbers, phone and M-Pesa numbers and next-of-kin details in clear. Do this once, right after
the first release with `AGENT_DATA_KEY` (and after any restore from a pre-encryption backup):

1. **Confirm sealing.** `$C run --rm migrate node dist/cli/key-rotation.js --target agent-data --reset-checkpoint
   --validate` (no `--tenant`) must print `Complete` and `CHECK constraint validated`.
2. **Rewrite the table.** In a quiet window, as the schema owner: `VACUUM (FULL, VERBOSE) agent_sensitive;` then
   `CHECKPOINT;`. `VACUUM FULL` writes a new copy of the table and its indexes and drops the old files (the table is
   small; it is locked for seconds). A plain `VACUUM` only marks the old versions reusable.
3. **Record the clean-from date.** Take a backup now (`$C --profile ops run --rm backup`) and drill it (section 6).
   Record in the processing register (DPIA / ROPA) the date of that backup: every backup and WAL segment from that
   date on is free of agent plaintext; every earlier one is not.
4. **Expire the earlier backups.** Keep pre-encryption backups and WAL archives only as long as the recovery need
   requires (at most the normal retention), in the restricted backup store, then delete them
   (`BACKUP_RETENTION_DAYS`, WAL archive expiry, and any off-site copies). Note the deletion in the register.
5. **Restore from a pre-encryption backup (only while one still exists).** The API seals the restored rows again at
   start-up; then re-apply every agent erasure recorded after the backup's date (`field.agent.sensitive_erased` audit
   events: erase those agents again), repeat steps 1–3, and record it.

Erasure (`POST /field/agents/:id/sensitive/erase`, the retention job) removes the sealed values from the live table;
copies in backups expire with them (section 6 keeps backups for the retention period only).

## 4. Election-day operations

**T-14 days**

- Production sizing: API replicas on their own cores (the load test saturated one API process at about
  65 mixed requests/s on shared vCPUs), Postgres on its own host with `shared_buffers` ≈ 25 % of RAM,
  `APP_DB_POOL_SIZE` × API replicas + worker pool < `max_connections` − 20.
- Load test on the production-sized environment with the election's registry
  (`scripts/load/setup-load-db.sh` and `run-load.sh` against a copy, never against production data) and
  compare with OPERATIONS.md.
- Restore drill passed in the last 7 days; record it in S30.
- clamd healthy and signatures fresh; SMTP and SMS tested end to end; captcha keys valid.
- Registry: the gazetted station list imported and approved by two people; run `ANALYZE polling_stations,
  geographic_units;` as the owner right after approval (fresh statistics; OPERATIONS.md open findings).
- Rate limits: field agents behind mobile-carrier NAT share public IPs. Raise `RATE_LIMIT_MAX` (global,
  per IP per minute; default 300) to fit the expected agents per carrier gateway, keep `AUTH_RATE_LIMIT_MAX`
  strict. Re-test sign-in limits after changing them.

**T-1 day**: change freeze (no deploys after the freeze except a rollback); backup taken and drilled;
`TALLY_AGGREGATE_MAX_STALE_SECONDS=5` set (results pages show `computedAt`; five seconds of tolerated
staleness keeps the 55k-station aggregate from recomputing per viewer during intake bursts); on-call rota
and the incident commander named; War Room screens signed in and in wall mode.

**Election day**

| Watch | Where | Act when |
| --- | --- | --- |
| API p95 and 5xx | Caddy JSON log / metrics | p95 > 2 s for 5 min or any sustained 503 `RATE_LIMITED` (pool exhausted): add an API replica (`--scale api=3`), check Postgres CPU and slow-query log. |
| Postgres | `log_min_duration_statement=500` log, CPU, connections | Long queries on `result_*` or `field_*`: capture the statement for the developers; do not kill the recorder job mid-run unless it blocks writes. |
| Worker heartbeat and jobs | `$C ps`, `/platform/jobs` | `files.scan_pending`, `messaging.dispatch`, `field.station_status_record` not SUCCEEDED in 3 intervals: restart `worker`. |
| Sync backlog | War Room "sync items / conflicts (15 min)" | Rising conflicts: field coordinators contact agents; never delete queued items server-side. |
| Uploads PENDING scan | S30 / `/files/:id/scan` | clamd down: files stay PENDING (by design); restart clamd, the job catches up. |
| Disk | host | Postgres volume < 20 % free or MinIO < 20 %: expand; never delete originals. |

Polling closes: snapshots are created by tally supervisors; "release" is internal only. Nothing NGAO360
produces is an official result; communications staff use only approved, labelled snapshots.

**After**: keep the freeze until the tally is closed; take and drill a backup; export the War Room and
audit summaries for the after-action review; revert `TALLY_AGGREGATE_MAX_STALE_SECONDS` if desired.

## 5. Breach response

Kenya Data Protection Act 2019 (docs/RESEARCH.md): the **controller** (each tenant organisation) must notify
the ODPC **within 72 hours** of becoming aware of a breach (s.43) and affected people where there is a real
risk of harm; NGAO360 as **processor** must notify the controller without delay (secondary source: within
48 hours; we commit to **24 hours**). Confirm current wording with counsel; ODPC registration of controller
and processor is a prerequisite.

1. **Detect and record (hour 0).** Anyone who suspects a breach records it in the breach register
   (`/security/breaches`, `security.breach.record`): what, when detected, categories and approximate
   counts only, no personal data in the text. HIGH / CRITICAL raises an acknowledgement-required alert to
   holders of `security.breach.manage`. Name an incident commander and a scribe.
2. **Contain (hours 0–4).** Revoke sessions of affected accounts (admin screens: suspend, reset MFA);
   rotate exposed secrets (section 3); block the vector at Caddy or the network; take the affected
   integration offline (provider back to `log`: messages wait in the outbox). Do not delete or alter
   logs, audit events or evidence.
3. **Preserve evidence.** Take a backup now (`$C --profile ops run --rm backup`) and keep it apart (not
   rotated); export the audit log for the window (`audit.export`, re-auth); keep Caddy and API logs; attach
   evidence files to the breach timeline (`BREACH_EVIDENCE`, scanned and immutable).
4. **Assess (by hour 24).** Which tenants, which data categories (result forms, agent personal data, citizen
   cases, contributor data, contact details), how many people, likely harm. Use the audit log
   (`FILE_SOURCE_ACCESSED`, reveals, exports) — RLS limits blast radius to the tenants whose sessions or
   keys were involved.
5. **Notify the controller(s) (by hour 24, processor duty).** The NGAO360 operator informs each affected
   tenant's owner and DPO in writing with the facts known so far; record it as a `CONTROLLER_NOTIFIED`
   timeline event.
6. **Controller notifies the ODPC (by hour 72)** and affected people where required; record
   `REGULATOR_NOTIFIED` / `SUBJECTS_NOTIFIED` events with dates. If facts are incomplete, notify within 72 h
   anyway and supplement.
7. **Remediate and close.** Fix the cause, verify, export the breach timeline (PDF, CONFIDENTIAL,
   `security.breach.export` with re-auth), hold a lessons-learned review; the closer must not be the
   reporter (enforced). Drills are recorded with `isDrill: true` and run at least once before the pilot.

## 6. Restore

**Routine drill (monthly, and before every election-period milestone):**

```bash
# on an ops host with the repository at the release tag, PostgreSQL 16 client tools and Node 22
export DATABASE_URL=postgresql://ngao:…@db-host:5432/ngao360    # owner role (CREATEDB)
export APP_DATABASE_URL=postgresql://ngao_app:…@db-host:5432/ngao360
BACKUP_DIR=/srv/ngao360/backups scripts/ops/restore-drill.sh            # latest backup
```

It restores into a scratch database, runs every integrity check (OPERATIONS.md §3), writes
`restore-report.json` and drops the scratch database. Record the outcome in S30 (`RESTORED_OK`,
`RESTORED_WITH_ISSUES` or `FAILED`, with the backup folder name, never credentials).

**Real restore (data loss or corruption):**

1. Incident commander decides the recovery point (the last backup before the damage; RPO with daily logical
   backups is up to 24 h — enable WAL archiving / point-in-time recovery before the general election to
   meet the 15-minute target in blueprint 16.1). Announce read-only time.
2. Stop writers: `$C stop api worker` (Caddy then shows the web app with API errors).
3. Run the drill on the chosen backup first (`restore-drill.sh <folder>` with `RESTORE_KEEP=true`). Do not
   continue unless it passes.
4. Rename the damaged database (`ALTER DATABASE ngao360 RENAME TO ngao360_damaged_<date>`; keep it for the
   investigation), then rename the verified scratch copy to `ngao360` (or `pg_restore` into a fresh
   `ngao360`). Roles must exist first (`infra/postgres/init-roles.sh` or `scripts/db-bootstrap.sql`).
5. Storage: with S3 the originals are versioned and under Object Lock; nothing to restore unless the bucket
   was lost — then restore it from the replica (`mc mirror` from the replicated bucket) and re-run the
   drill's storage sample against it. With the local driver copy `blobs/` from the backup back to the
   storage root (content-addressed; existing files are identical by hash).
6. `$C run --rm migrate` (a backup from an older release gets the newer migrations), then
   `$C up -d worker api`. Verify as after a deploy.
7. Data written after the recovery point is lost from the database: field devices still hold unsent items
   and re-sync idempotently; paper forms are re-uploaded (duplicates are flagged, never discarded).
   Record the restore and its window in the breach register if personal data availability was affected
   (section 5).

**Object Lock bucket missing lock:** Object Lock can only be enabled when a bucket is created. Create a new
bucket with lock (`minio-init` with a new `S3_BUCKET`), copy the objects (`mc mirror --retention-mode
COMPLIANCE --retention-duration <days>d`), switch `S3_BUCKET`, restart, and keep the old bucket read-only
until the drill passes against the new one.
