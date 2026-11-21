#!/usr/bin/env bash
# NGAO360 restore drill: restores a backup made by backup.sh into a NEW scratch database and proves it
# is complete and still safe to run:
#
#   1. backup files match their SHA256SUMS
#   2. pg_restore into ngao360_restore_<timestamp> (never touches the live database)
#   3. exact row counts per table equal the counts taken in the backup snapshot
#   4. RLS is enabled on the same tables as in the source, and on every table with a tenant_id
#   5. audit log: every event_hash and payload hash recomputes, the chain digest (seq:event_hash in
#      seq order) equals the backup's, and the append-only trigger still refuses UPDATE
#   6. storage: the restored stored_files manifest equals the backup manifest, and a random sample of
#      originals re-hashes to its SHA-256 (from the backup's blob copy and from live storage)
#   7. as the runtime role ngao_app: not superuser / BYPASSRLS, no tenant setting => no tenant rows,
#      tenant A set => no other tenant's rows in any table, audit UPDATE refused
#
#   DATABASE_URL=... APP_DATABASE_URL=... scripts/ops/restore-drill.sh [backup-dir]
#
# Environment:
#   DATABASE_URL          owner connection (role with CREATEDB); its database is only used to find the host
#   APP_DATABASE_URL      runtime role connection; the drill connects as that role to the scratch database
#   BACKUP_DIR            where backups live (latest one is used when no argument is given)
#   STORAGE_DRIVER / STORAGE_LOCAL_ROOT   live storage to spot-check (local; S3 needs `mc` + MC_ALIAS)
#   RESTORE_SAMPLE        how many originals to re-hash (default 50; "all" for every file)
#   RESTORE_KEEP          true to keep the scratch database for inspection (default false: dropped)
#   RESTORE_JOBS          pg_restore parallel jobs (default 4)
# Writes restore-report.json next to the backup and exits non-zero if any check fails.
set -Eeuo pipefail
umask 077

log() { printf '%s restore-drill: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS_DIR="$REPO_ROOT/scripts/ops"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
SRC="${1:-$(ls -1d "$BACKUP_DIR"/ngao360-* 2>/dev/null | sort | tail -1)}"
[ -n "$SRC" ] && [ -f "$SRC/db.dump" ] || die "no backup found (pass a backup directory or set BACKUP_DIR)"
SAMPLE="${RESTORE_SAMPLE:-50}"
KEEP="${RESTORE_KEEP:-false}"
JOBS="${RESTORE_JOBS:-4}"
STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
STORAGE_LOCAL_ROOT="${STORAGE_LOCAL_ROOT:-$REPO_ROOT/apps/api/storage}"
case "$STORAGE_LOCAL_ROOT" in /*) ;; *) STORAGE_LOCAL_ROOT="$REPO_ROOT/apps/api/$STORAGE_LOCAL_ROOT" ;; esac

strip_query() { local u="$1"; echo "${u%%\?*}"; }
with_db() { local u; u="$(strip_query "$1")"; echo "${u%/*}/$2"; }
: "${DATABASE_URL:?set DATABASE_URL (owner role)}"
: "${APP_DATABASE_URL:?set APP_DATABASE_URL (runtime role ngao_app)}"
SCRATCH="ngao360_restore_$(date -u +%Y%m%d%H%M%S)"
OWNER_URL="$(with_db "$DATABASE_URL" "$SCRATCH")"
APP_URL="$(with_db "$APP_DATABASE_URL" "$SCRATCH")"
ADMIN_URL="$(with_db "$DATABASE_URL" postgres)"
APP_ROLE="$(strip_query "$APP_DATABASE_URL" | sed -E 's#^[a-z]+://([^:@/]+).*#\1#')"

PSQL=(psql -X -v ON_ERROR_STOP=1 -q -At -F $'\t' -P footer=off)
FAILURES=()
fail() { FAILURES+=("$1"); log "FAIL: $1"; }
pass() { log "ok: $1"; }

T0=$(date +%s)
log "backup $SRC -> scratch database $SCRATCH"

# 1. Integrity of the backup files themselves.
(cd "$SRC" && sha256sum --quiet -c SHA256SUMS) || die "backup files do not match SHA256SUMS"
pass "backup files match SHA256SUMS"

# 2. Restore into a fresh database.
"${PSQL[@]}" "$ADMIN_URL" -c "CREATE DATABASE \"$SCRATCH\"" || die "cannot create $SCRATCH"
cleanup() {
  if [ "$KEEP" != true ]; then
    "${PSQL[@]}" "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null || log "could not drop $SCRATCH"
  else
    log "kept scratch database $SCRATCH"
  fi
}
trap cleanup EXIT
T1=$(date +%s)
pg_restore --exit-on-error --jobs="$JOBS" --dbname="$OWNER_URL" "$SRC/db.dump"
T2=$(date +%s)
pass "pg_restore in $((T2 - T1)) s"

# 3. Row counts per table.
TABLES=$("${PSQL[@]}" "$OWNER_URL" -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
for t in $TABLES; do printf "SELECT '%s', count(*) FROM public.%s;\n" "$t" "\"$t\""; done | "${PSQL[@]}" "$OWNER_URL" > "$SRC/restored-row-counts.tsv"
if diff -u "$SRC/row-counts.tsv" "$SRC/restored-row-counts.tsv" > "$SRC/row-counts.diff"; then
  rm -f "$SRC/row-counts.diff"
  pass "row counts equal for $(wc -l < "$SRC/row-counts.tsv") tables ($(awk -F'\t' '{s+=$2} END {print s}' "$SRC/row-counts.tsv") rows)"
else
  fail "row counts differ (see row-counts.diff)"
fi

# 4. RLS tables.
"${PSQL[@]}" "$OWNER_URL" > "$SRC/restored-rls-tables.tsv" <<'SQL'
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
ORDER BY c.relname;
SQL
if diff -q "$SRC/rls-tables.tsv" "$SRC/restored-rls-tables.tsv" >/dev/null; then
  pass "RLS enabled on the same $(wc -l < "$SRC/rls-tables.tsv") tables"
else
  fail "RLS table list differs from the source"
fi
NO_RLS=$("${PSQL[@]}" "$OWNER_URL" <<'SQL'
SELECT string_agg(c.relname, ',' ORDER BY c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped);
SQL
)
[ -z "$NO_RLS" ] && pass "every table with tenant_id has RLS" || fail "tables with tenant_id but no RLS: $NO_RLS"

# 5. Audit log.
AUDIT_JSON=$("${PSQL[@]}" "$OWNER_URL" <<'SQL' | node "$OPS_DIR/audit-verify.cjs" || true
\set FETCH_COUNT 5000
SELECT json_build_object('seq', seq, 'tenant_id', tenant_id, 'actor_id', actor_id, 'actor_type', actor_type, 'action', action,
  'entity_type', entity_type, 'entity_id', entity_id, 'before_hash', before_hash, 'after_hash', after_hash, 'before', "before",
  'after', "after", 'reason', reason, 'request_id', request_id, 'event_hash', event_hash,
  'occurred_at_ms', (extract(epoch FROM occurred_at) * 1000)::bigint)::text
FROM audit_events ORDER BY seq;
SQL
)
[ -n "$AUDIT_JSON" ] || die "audit verification produced no output"
read -r A_EVENTS A_BAD A_PAYLOAD A_ORDER A_DIGEST < <(node -e '
  const s = JSON.parse(process.argv[1]);
  console.log([s.events, s.eventHashMismatches, s.payloadHashMismatches, s.outOfOrder, s.chainDigest].join(" "));
' "$AUDIT_JSON")
[ "$A_BAD" = 0 ] && [ "$A_PAYLOAD" = 0 ] && [ "$A_ORDER" = 0 ] && pass "$A_EVENTS audit events re-hash correctly" \
  || fail "audit events failed re-hashing: $AUDIT_JSON"
[ "$A_DIGEST" = "$(cat "$SRC/audit-chain.sha256")" ] && pass "audit chain digest matches the backup ($A_DIGEST)" \
  || fail "audit chain digest $A_DIGEST differs from backup $(cat "$SRC/audit-chain.sha256")"
if "${PSQL[@]}" "$OWNER_URL" -c "BEGIN; UPDATE audit_events SET reason = reason WHERE seq = (SELECT min(seq) FROM audit_events); ROLLBACK;" >/dev/null 2>&1 \
  && [ "$A_EVENTS" -gt 0 ]; then
  fail "audit_events accepted an UPDATE from the owner role (append-only trigger missing)"
else
  pass "audit_events append-only trigger refuses UPDATE"
fi

# 6. Storage manifest and sampled originals.
"${PSQL[@]}" "$OWNER_URL" > "$SRC/restored-storage-manifest.tsv" <<'SQL'
SELECT id, tenant_id, storage_driver, storage_key, sha256, size_bytes, malware_scan_status
FROM stored_files ORDER BY storage_key;
SQL
if cmp -s "$SRC/storage-manifest.tsv" "$SRC/restored-storage-manifest.tsv"; then
  pass "stored_files manifest equals the backup ($(wc -l < "$SRC/storage-manifest.tsv") files)"
else
  fail "stored_files manifest differs from the backup"
fi
if [ "$SAMPLE" = all ]; then PICK=(cat); else PICK=(shuf -n "$SAMPLE"); fi
SAMPLED=0; SAMPLE_BAD=0; SAMPLE_LIVE=0; SAMPLE_COPY=0
while IFS=$'\t' read -r _id _tenant driver key sha size _scan; do
  SAMPLED=$((SAMPLED + 1))
  if [ -f "$SRC/blobs/$key" ]; then
    SAMPLE_COPY=$((SAMPLE_COPY + 1))
    [ "$(sha256sum "$SRC/blobs/$key" | cut -d' ' -f1)" = "$sha" ] || { SAMPLE_BAD=$((SAMPLE_BAD + 1)); log "backup copy mismatch $key"; }
    [ "$(stat -c %s "$SRC/blobs/$key")" = "$size" ] || { SAMPLE_BAD=$((SAMPLE_BAD + 1)); log "backup copy size mismatch $key"; }
  fi
  live=""
  if [ "$driver" = LOCAL ] && [ "$STORAGE_DRIVER" = local ] && [ -f "$STORAGE_LOCAL_ROOT/$key" ]; then
    live=$(sha256sum "$STORAGE_LOCAL_ROOT/$key" | cut -d' ' -f1)
  elif [ "$driver" = S3 ] && [ -n "${MC_ALIAS:-}" ] && command -v mc >/dev/null; then
    live=$(mc cat "$MC_ALIAS/${S3_BUCKET:-ngao360}/$key" | sha256sum | cut -d' ' -f1)
  fi
  if [ -n "$live" ]; then
    SAMPLE_LIVE=$((SAMPLE_LIVE + 1))
    [ "$live" = "$sha" ] || { SAMPLE_BAD=$((SAMPLE_BAD + 1)); log "live storage mismatch $key"; }
  fi
  if [ ! -f "$SRC/blobs/$key" ] && [ -z "$live" ]; then
    SAMPLE_BAD=$((SAMPLE_BAD + 1)); log "no readable copy of $key"
  fi
done < <("${PICK[@]}" "$SRC/restored-storage-manifest.tsv")
[ "$SAMPLE_BAD" = 0 ] && pass "$SAMPLED sampled originals re-hash correctly ($SAMPLE_COPY from the backup copy, $SAMPLE_LIVE from live storage)" \
  || fail "$SAMPLE_BAD problem(s) in $SAMPLED sampled originals"

# 7. RLS as the runtime role.
ROLE_FLAGS=$("${PSQL[@]}" "$APP_URL" -c "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
[ "$ROLE_FLAGS" = $'f\tf' ] && pass "$APP_ROLE is neither superuser nor BYPASSRLS" || fail "$APP_ROLE flags (super, bypassrls) = $ROLE_FLAGS"
TENANTS=($("${PSQL[@]}" "$OWNER_URL" -c "SELECT tenant_id FROM stored_files GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 2"))
[ "${#TENANTS[@]}" -ge 1 ] || TENANTS=($("${PSQL[@]}" "$OWNER_URL" -c "SELECT id FROM tenants ORDER BY created_at LIMIT 2"))
RLS_OUT=$("${PSQL[@]}" "$APP_URL" 2>&1 <<SQL || true
DO \$\$
DECLARE
  t record; n bigint; checked int := 0; leaks text := '';
  tenant_a uuid := '${TENANTS[0]}';
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND has_table_privilege(current_user, c.oid, 'SELECT')
    ORDER BY c.relname
  LOOP
    checked := checked + 1;
    PERFORM set_config('app.tenant_id', '', true);
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NOT NULL', t.relname) INTO n;
    IF n > 0 THEN leaks := leaks || format(' %s(no tenant: %s rows)', t.relname, n); END IF;
    PERFORM set_config('app.tenant_id', tenant_a::text, true);
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS DISTINCT FROM %L::uuid AND tenant_id IS NOT NULL', t.relname, tenant_a) INTO n;
    IF n > 0 THEN leaks := leaks || format(' %s(other tenant: %s rows)', t.relname, n); END IF;
  END LOOP;
  IF leaks <> '' THEN RAISE EXCEPTION 'RLS_LEAK:%', leaks; END IF;
  RAISE NOTICE 'RLS_OK:%', checked;
END
\$\$;
SQL
)
if [[ "$RLS_OUT" == *RLS_OK:* ]]; then
  pass "as $APP_ROLE: no rows without a tenant and no other tenant's rows in ${RLS_OUT##*RLS_OK:} tenant tables"
else
  fail "RLS check as $APP_ROLE: $RLS_OUT"
fi
VISIBLE=$("${PSQL[@]}" "$APP_URL" -c "BEGIN; SELECT set_config('app.tenant_id', '${TENANTS[0]}', true); SELECT count(*) FROM stored_files; COMMIT;" | tail -1)
EXPECTED=$("${PSQL[@]}" "$OWNER_URL" -c "SELECT count(*) FROM stored_files WHERE tenant_id = '${TENANTS[0]}'")
[ "$VISIBLE" = "$EXPECTED" ] && pass "tenant ${TENANTS[0]} sees exactly its $EXPECTED stored files" || fail "tenant sees $VISIBLE stored files, expected $EXPECTED"
if "${PSQL[@]}" "$APP_URL" -c "BEGIN; SELECT set_config('app.tenant_id', '${TENANTS[0]}', true); UPDATE audit_events SET reason = reason; ROLLBACK;" >/dev/null 2>&1; then
  fail "$APP_ROLE could UPDATE audit_events"
else
  pass "$APP_ROLE cannot UPDATE audit_events"
fi

T3=$(date +%s)
STATUS=$([ "${#FAILURES[@]}" -eq 0 ] && echo passed || echo failed)
node -e '
  const [src, status, total, restore, events, digest, sampled, failures] = process.argv.slice(1);
  const b = require(src + "/backup.json");
  const report = { format: "ngao360-restore-drill/1", backup: src, backupCreatedAt: b.createdAt, ranAt: new Date().toISOString(),
    status, totalSeconds: Number(total), pgRestoreSeconds: Number(restore), dumpBytes: b.dumpBytes, tables: b.tables, rows: b.rows,
    auditEvents: Number(events), auditChainDigest: digest, storageFiles: b.storage.files, sampledOriginals: Number(sampled),
    failures: failures ? failures.split("\n") : [] };
  require("fs").writeFileSync(src + "/restore-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
' "$SRC" "$STATUS" "$((T3 - T0))" "$((T2 - T1))" "$A_EVENTS" "$A_DIGEST" "$SAMPLED" "$(printf '%s\n' "${FAILURES[@]+"${FAILURES[@]}"}" | sed '/^$/d')"
log "drill $STATUS in $((T3 - T0)) s"
[ "$STATUS" = passed ]
