-- NGAO360 load-test data (SYNTHETIC). Run ONLY against a dedicated load database that was migrated and
-- seeded with `pnpm db:seed` (scripts/load/setup-load-db.sh does all of it). Never run it on a real
-- deployment: it supersedes the demo organisation's approved registry.
--
-- psql variables: :stations (target station count, default 55000)
--
-- Shape (organisation `demo`, cycle "2027 General Election", synthetic provenance unchanged):
--   * registry version LOAD-55K, APPROVED (the seed's SYNTHETIC-2027-R1 is SUPERSEDED): 290 constituencies,
--     1,450 wards, ~22,000 polling centres and :stations stations. Every station sits under Bungoma county so
--     that the single seeded Governor contest (forms 37A/B/C) spans the whole registry: the aggregate, the
--     War Room and the queues therefore run at the size of a national presidential tally. The 153 seed
--     station codes are kept (re-homed to the first load ward) so station-scoped demo users still resolve.
--   * result forms (37A) for ~82% of stations: ~64% VERIFIED (canonical, with a PASS verification),
--     ~7% SECOND_REVIEW_PENDING (the verification queue), ~5% DATA_ENTRY_REVIEWED, ~4% SUBMITTED, ~2%
--     DISPUTED, plus ~1% duplicates (non-canonical). Values: 4 candidates, totals consistent.
--     Source files are stored_files rows WITHOUT blobs (hash of the row id); do not open their source URLs.
--   * field: one agent and one chief-agent deployment for ~90% of stations (ASSIGNED / CONFIRMED /
--     CHECKED_IN / CHECKED_OUT), opening-of-polls reports for ~70% and closing reports for ~45%, and
--     ~2,500 incidents across severities and statuses, and 200 field-app accounts (load.agentN@) for 200 stations.
\set ON_ERROR_STOP on
\if :{?stations}
\else
  \set stations 55000
\endif

BEGIN;
SET LOCAL synchronous_commit = off;

CREATE TEMP TABLE ctx ON COMMIT DROP AS
SELECT t.id AS tenant_id,
       c.id AS cycle_id,
       county.id AS county_id,
       county.path AS county_path,
       ct.id AS contest_id,
       ft.id AS template_id,
       (SELECT id FROM users WHERE email = 'clerk@demo.example.org') AS clerk_id,
       (SELECT id FROM users WHERE email = 'verifier@demo.example.org') AS verifier_id,
       (SELECT id FROM users WHERE email = 'supervisor@demo.example.org') AS approver_id,
       (SELECT id FROM users WHERE email = 'agent1@demo.example.org') AS agent_user_id,
       (SELECT id FROM users WHERE email = 'planner@demo.example.org') AS planner_id,
       (SELECT id FROM registry_versions r WHERE r.tenant_id = t.id AND r.election_cycle_id = c.id AND r.status = 'APPROVED') AS old_registry_id,
       gen_random_uuid() AS registry_id
FROM tenants t
JOIN election_cycles c ON c.tenant_id = t.id AND c.name = '2027 General Election'
JOIN geographic_units county ON county.tenant_id = t.id AND county.type = 'COUNTY' AND county.official_code = '039'
JOIN contests ct ON ct.tenant_id = t.id AND ct.election_cycle_id = c.id AND ct.office_type = 'GOVERNOR'
JOIN form_templates ft ON ft.tenant_id = t.id AND ft.election_cycle_id = c.id AND ft.form_number = '37A' AND ft.approval_state = 'APPROVED'
WHERE t.slug = 'demo';

DO $$
BEGIN
  IF (SELECT count(*) FROM ctx) <> 1 THEN RAISE EXCEPTION 'load seed: demo organisation, cycle, contest or 37A template not found (run pnpm db:seed first)'; END IF;
  IF EXISTS (SELECT 1 FROM registry_versions r JOIN ctx ON r.tenant_id = ctx.tenant_id WHERE r.version = 'LOAD-55K') THEN
    RAISE EXCEPTION 'load seed: already applied to this database';
  END IF;
END $$;

-- Registry version (DRAFT while stations are added; approved at the end).
INSERT INTO registry_versions (id, tenant_id, election_cycle_id, version, source, status, station_count, notes)
SELECT registry_id, tenant_id, cycle_id, 'LOAD-55K', 'synthetic load test (scripts/load/seed-load.sql)', 'DRAFT', 0,
       'SYNTHETIC load-test registry. Not real stations.'
FROM ctx;

-- Constituencies (290) and wards (1,450).
CREATE TEMP TABLE l_const ON COMMIT DROP AS
SELECT g AS idx, gen_random_uuid() AS id FROM generate_series(0, 289) g;
INSERT INTO geographic_units (id, tenant_id, election_cycle_id, registry_version_id, type, parent_id, official_code, official_name, path, source_version, updated_at)
SELECT k.id, ctx.tenant_id, ctx.cycle_id, ctx.registry_id, 'CONSTITUENCY', ctx.county_id,
       format('LD-C%s', lpad((k.idx + 1)::text, 3, '0')), format('Load Constituency %s (synthetic)', k.idx + 1),
       ctx.county_path || k.id || '/', 'LOAD-55K', now()
FROM l_const k, ctx;

CREATE TEMP TABLE l_ward ON COMMIT DROP AS
SELECT g AS idx, g / 5 AS const_idx, gen_random_uuid() AS id FROM generate_series(0, 1449) g;
INSERT INTO geographic_units (id, tenant_id, election_cycle_id, registry_version_id, type, parent_id, official_code, official_name, path, source_version, updated_at)
SELECT w.id, ctx.tenant_id, ctx.cycle_id, ctx.registry_id, 'WARD', k.id,
       format('LD-C%s-W%s', lpad((k.idx + 1)::text, 3, '0'), (w.idx % 5) + 1), format('Load Ward %s (synthetic)', w.idx + 1),
       ctx.county_path || k.id || '/' || w.id || '/', 'LOAD-55K', now()
FROM l_ward w JOIN l_const k ON k.idx = w.const_idx, ctx;

-- Stations: generated codes, plus the seed's station codes (kept for station-scoped demo users).
CREATE TEMP TABLE l_station ON COMMIT DROP AS
WITH gen AS (
  SELECT g AS i, (g::bigint * 1450 / :stations)::int AS ward_idx, false AS legacy, NULL::text AS legacy_code, NULL::text AS legacy_name
  FROM generate_series(0, :stations - 1 - (SELECT count(*) FROM polling_stations ps JOIN ctx ON ps.registry_version_id = ctx.old_registry_id)) g
  UNION ALL
  SELECT -row_number() OVER (ORDER BY ps.code), 0, true, ps.code, ps.name
  FROM polling_stations ps JOIN ctx ON ps.registry_version_id = ctx.old_registry_id
)
SELECT gen.*, row_number() OVER (PARTITION BY ward_idx ORDER BY legacy DESC, i) AS rn_in_ward, gen_random_uuid() AS id
FROM gen;
ALTER TABLE l_station ADD COLUMN centre_key int;
UPDATE l_station SET centre_key = ward_idx * 100 + ((rn_in_ward - 1) / 3)::int;  -- ~2.5 to 3 streams per centre

CREATE TEMP TABLE l_centre ON COMMIT DROP AS
SELECT centre_key, min(ward_idx) AS ward_idx, gen_random_uuid() AS id FROM l_station GROUP BY centre_key;
INSERT INTO geographic_units (id, tenant_id, election_cycle_id, registry_version_id, type, parent_id, official_code, official_name, path, source_version, updated_at)
SELECT p.id, ctx.tenant_id, ctx.cycle_id, ctx.registry_id, 'POLLING_CENTRE', w.id,
       format('LD-W%s-P%s', lpad((w.idx + 1)::text, 4, '0'), (p.centre_key % 100) + 1),
       format('Load Centre %s/%s (synthetic)', w.idx + 1, (p.centre_key % 100) + 1),
       ctx.county_path || k.id || '/' || w.id || '/' || p.id || '/', 'LOAD-55K', now()
FROM l_centre p JOIN l_ward w ON w.idx = p.ward_idx JOIN l_const k ON k.idx = w.const_idx, ctx;

INSERT INTO polling_stations (id, tenant_id, election_cycle_id, registry_version_id, geographic_unit_id, county_id, constituency_id, ward_id,
                              polling_centre_id, code, name, stream_number, registered_voters, status, updated_at)
SELECT s.id, ctx.tenant_id, ctx.cycle_id, ctx.registry_id, p.id, ctx.county_id, k.id, w.id, p.id,
       CASE WHEN s.legacy THEN s.legacy_code ELSE format('LD-%s', lpad((s.i + 1)::text, 6, '0')) END,
       CASE WHEN s.legacy THEN s.legacy_name ELSE format('Load Station %s (synthetic)', s.i + 1) END,
       ((s.rn_in_ward - 1) % 3) + 1, 300 + (hashtext(s.id::text) & 255) + 140, 'ACTIVE', now()
FROM l_station s
JOIN l_centre p ON p.centre_key = s.centre_key
JOIN l_ward w ON w.idx = s.ward_idx
JOIN l_const k ON k.idx = w.const_idx, ctx;

UPDATE registry_versions r SET station_count = (SELECT count(*) FROM polling_stations ps WHERE ps.registry_version_id = r.id)
FROM ctx WHERE r.id = ctx.registry_id;
UPDATE registry_versions r SET status = 'SUPERSEDED' FROM ctx WHERE r.id = ctx.old_registry_id;
UPDATE registry_versions r SET status = 'APPROVED', approved_by_id = ctx.approver_id, approved_at = now()
FROM ctx WHERE r.id = ctx.registry_id;

-- ------------------------------------------------------------------------------------------------
-- Result forms (37A)
-- ------------------------------------------------------------------------------------------------
CREATE TEMP TABLE l_sub ON COMMIT DROP AS
SELECT ps.id AS station_id, ps.geographic_unit_id AS unit_id, ps.code, ps.registered_voters, gen_random_uuid() AS id, gen_random_uuid() AS file_id,
       abs(hashtext('sub:' || ps.code)) % 100 AS bucket, false AS duplicate
FROM polling_stations ps JOIN ctx ON ps.registry_version_id = ctx.registry_id
WHERE abs(hashtext('sub:' || ps.code)) % 100 < 82;
-- ~1% duplicates of verified forms (second upload of the same station form; non-canonical)
INSERT INTO l_sub
SELECT station_id, unit_id, code, registered_voters, gen_random_uuid(), gen_random_uuid(), 99, true
FROM l_sub WHERE bucket < 64 AND abs(hashtext('dup:' || code)) % 64 = 0;
ALTER TABLE l_sub ADD COLUMN status "SubmissionStatus";
UPDATE l_sub SET status = (CASE
  WHEN duplicate THEN 'SUBMITTED'
  WHEN bucket < 64 THEN 'VERIFIED'
  WHEN bucket < 71 THEN 'SECOND_REVIEW_PENDING'
  WHEN bucket < 76 THEN 'DATA_ENTRY_REVIEWED'
  WHEN bucket < 80 THEN 'SUBMITTED'
  ELSE 'DISPUTED' END)::"SubmissionStatus";

INSERT INTO stored_files (id, tenant_id, sha256, mime_type, size_bytes, original_filename, purpose, storage_driver, storage_key,
                          page_count, malware_scan_status, scanned_at, scan_engine, uploaded_by_id)
SELECT s.file_id, ctx.tenant_id, h.sha, 'image/jpeg', 180000 + (hashtext(s.file_id::text) & 65535),
       format('37A-%s.jpg', s.code), 'RESULT_FORM', 'LOCAL',
       format('tenants/%s/sha256/%s/%s', ctx.tenant_id, left(h.sha, 2), h.sha), 1, 'CLEAN', now(), 'load-seed', ctx.clerk_id
FROM l_sub s CROSS JOIN ctx CROSS JOIN LATERAL (SELECT encode(sha256(convert_to('load:' || s.file_id::text, 'UTF8')), 'hex') AS sha) h;

INSERT INTO result_submissions (id, tenant_id, reference, election_cycle_id, contest_id, form_template_id, form_number, polling_station_id,
                                geographic_unit_id, registry_version_id, submitter_id, source_file_id, source_type, status, is_canonical,
                                duplicate_flag, duplicate_of_id, image_quality, page_count, idempotency_key, submitted_at, verified_at,
                                created_at, updated_at)
SELECT s.id, ctx.tenant_id, format('LOAD-SUB-%s', lpad(row_number() OVER (ORDER BY s.code, s.duplicate)::text, 6, '0')),
       ctx.cycle_id, ctx.contest_id, ctx.template_id, '37A', s.station_id, s.unit_id, ctx.registry_id, ctx.clerk_id, s.file_id,
       'AGENT_UPLOAD', s.status, NOT s.duplicate, s.duplicate, NULL, 'GOOD', 1, gen_random_uuid(),
       now() - interval '2 hours' + (s.bucket || ' seconds')::interval,
       CASE WHEN s.status = 'VERIFIED' THEN now() - interval '30 minutes' END,
       now() - interval '2 hours', now()
FROM l_sub s, ctx;
UPDATE result_submissions d SET duplicate_of_id = o.id
FROM l_sub ds JOIN l_sub os ON os.code = ds.code AND NOT os.duplicate
JOIN result_submissions o ON o.id = os.id
WHERE ds.duplicate AND d.id = ds.id;

-- Values: 4 candidates (ballot order), consistent totals, for every form past capture.
CREATE TEMP TABLE l_votes ON COMMIT DROP AS
SELECT s.id AS submission_id, cr.id AS candidate_id, cr.ballot_order,
       (abs(hashtext(s.id::text || cr.id::text)) % greatest(1, (s.registered_voters / (cr.ballot_order + 1)))) AS votes
FROM l_sub s JOIN result_submissions rs ON rs.id = s.id
JOIN candidate_references cr ON cr.contest_id = rs.contest_id
WHERE s.status <> 'SUBMITTED';
INSERT INTO result_values (id, tenant_id, submission_id, field_key, candidate_reference_id, numeric_value, confirmed_by_id, confirmed_at, change_version, updated_at)
SELECT gen_random_uuid(), ctx.tenant_id, v.submission_id, 'candidate_votes', v.candidate_id, v.votes, ctx.clerk_id, now() - interval '1 hour', 1, now()
FROM l_votes v, ctx;
INSERT INTO result_values (id, tenant_id, submission_id, field_key, numeric_value, confirmed_by_id, confirmed_at, change_version, updated_at)
SELECT gen_random_uuid(), ctx.tenant_id, t.submission_id, f.key, f.val, ctx.clerk_id, now() - interval '1 hour', 1, now()
FROM (SELECT submission_id, sum(votes) AS valid, (abs(hashtext(submission_id::text)) % 6) AS rejected FROM l_votes GROUP BY submission_id) t
JOIN l_sub s ON s.id = t.submission_id
CROSS JOIN LATERAL (VALUES ('total_valid_votes', t.valid), ('rejected_ballots', t.rejected), ('total_votes_cast', t.valid + t.rejected),
                           ('registered_voters', s.registered_voters::bigint)) AS f(key, val), ctx;

INSERT INTO verifications (id, tenant_id, submission_id, round, reviewer_id, decision, checklist, independent_values, mismatched_field_keys, reviewed_at)
SELECT gen_random_uuid(), ctx.tenant_id, s.id, 1, ctx.verifier_id, 'PASS', '{"imageLegible": true, "stationMatches": true, "totalsChecked": true}'::jsonb,
       '{}'::jsonb, '{}', now() - interval '35 minutes'
FROM l_sub s, ctx WHERE s.status = 'VERIFIED';

-- ------------------------------------------------------------------------------------------------
-- Field operations
-- ------------------------------------------------------------------------------------------------
CREATE TEMP TABLE l_dep ON COMMIT DROP AS
SELECT ps.code, ps.county_id, ps.constituency_id, ps.ward_id, ps.polling_centre_id, gen_random_uuid() AS agent_id,
       row_number() OVER (ORDER BY ps.code) AS n, abs(hashtext('dep:' || ps.code)) % 100 AS bucket
FROM polling_stations ps JOIN ctx ON ps.registry_version_id = ctx.registry_id
WHERE ps.code LIKE 'LD-%' AND abs(hashtext('dep:' || ps.code)) % 100 < 90;

INSERT INTO agents (id, tenant_id, reference, given_name, family_name, home_ward_id, home_constituency_id, home_county_id, status,
                    phone_masked, national_id_masked, created_by_id, updated_at)
SELECT d.agent_id, ctx.tenant_id, format('LOAD-AGT-%s', lpad(d.n::text, 6, '0')), 'Load', format('Agent %s (synthetic)', d.n),
       d.ward_id, d.constituency_id, d.county_id, 'ACTIVE', '+254 7** *** 0' || lpad((d.n % 100)::text, 2, '0'), '99******', ctx.planner_id, now()
FROM l_dep d, ctx;

INSERT INTO deployments (id, tenant_id, election_cycle_id, agent_id, polling_station_code, county_id, constituency_id, ward_id, polling_centre_id,
                         role, shift, status, confirmed_at, checked_in_at, checked_out_at, created_by_id, updated_at)
SELECT gen_random_uuid(), ctx.tenant_id, ctx.cycle_id, d.agent_id, d.code, d.county_id, d.constituency_id, d.ward_id, d.polling_centre_id,
       'CHIEF_AGENT', 'FULL_DAY', st.status::"DeploymentStatus",
       CASE WHEN st.status <> 'ASSIGNED' THEN now() - interval '1 day' END,
       CASE WHEN st.status IN ('CHECKED_IN', 'CHECKED_OUT') THEN now() - interval '10 hours' END,
       CASE WHEN st.status = 'CHECKED_OUT' THEN now() - interval '1 hour' END,
       ctx.planner_id, now()
FROM l_dep d
CROSS JOIN LATERAL (SELECT CASE WHEN d.bucket < 8 THEN 'ASSIGNED' WHEN d.bucket < 18 THEN 'CONFIRMED' WHEN d.bucket < 75 THEN 'CHECKED_IN' ELSE 'CHECKED_OUT' END AS status) st,
ctx;

-- Opening (~70% of stations) and closing (~45%) reports, cloned from the seed's report answers.
INSERT INTO field_reports (id, tenant_id, reference, template_id, template_version, report_type, election_cycle_id, polling_station_code,
                           geographic_unit_id, county_id, constituency_id, ward_id, polling_centre_id, event_at, received_at, answers,
                           author_id, submitted_offline, client_idempotency_key, updated_at)
SELECT gen_random_uuid(), ctx.tenant_id, format('LOAD-FRP-%s-%s', left(r.report_type::text, 1), lpad(d.n::text, 6, '0')), r.template_id, r.template_version,
       r.report_type, ctx.cycle_id, d.code, d.polling_centre_id, d.county_id, d.constituency_id, d.ward_id, d.polling_centre_id,
       now() - CASE WHEN r.report_type = 'OPENING_OF_POLLS' THEN interval '10 hours' ELSE interval '50 minutes' END,
       now() - CASE WHEN r.report_type = 'OPENING_OF_POLLS' THEN interval '9 hours 55 minutes' ELSE interval '45 minutes' END,
       r.answers, ctx.agent_user_id, (d.n % 7 = 0), gen_random_uuid(), now()
FROM l_dep d
JOIN LATERAL (
  SELECT DISTINCT ON (fr.report_type) fr.template_id, fr.template_version, fr.report_type, fr.answers
  FROM field_reports fr JOIN ctx c2 ON fr.tenant_id = c2.tenant_id
  ORDER BY fr.report_type, fr.received_at
) r ON (r.report_type = 'OPENING_OF_POLLS' AND d.bucket < 70) OR (r.report_type = 'CLOSING_AND_COUNTING' AND d.bucket < 45),
ctx;

-- Incidents (~2,500), severities and statuses mixed; descriptions are neutral synthetic text.
INSERT INTO incidents (id, tenant_id, reference, election_cycle_id, reported_category, category, initial_severity, severity, status, occurred_at,
                       reported_at, polling_station_code, geographic_unit_id, county_id, constituency_id, ward_id, polling_centre_id,
                       description, reporter_id, client_idempotency_key, updated_at)
SELECT gen_random_uuid(), ctx.tenant_id, format('LOAD-INC-%s', lpad(d.n::text, 6, '0')), ctx.cycle_id, cat.c, cat.c,
       sev.s, sev.s, stat.s, now() - interval '5 hours', now() - interval '4 hours 50 minutes', d.code, d.polling_centre_id,
       d.county_id, d.constituency_id, d.ward_id, d.polling_centre_id,
       'Synthetic load-test incident report (no real event).', ctx.agent_user_id, gen_random_uuid(), now()
FROM l_dep d
CROSS JOIN LATERAL (SELECT (ARRAY['MATERIALS','EQUIPMENT','AGENT_ACCESS','PROCEDURE','LOGISTICS','COUNTING_AND_FORMS','SECURITY','OTHER'])[1 + (d.n % 8)]::"IncidentCategory" AS c) cat
CROSS JOIN LATERAL (SELECT (ARRAY['LOW','LOW','MEDIUM','MEDIUM','HIGH','CRITICAL'])[1 + (d.n % 6)]::"IncidentSeverity" AS s) sev
CROSS JOIN LATERAL (SELECT (ARRAY['REPORTED','TRIAGED','ASSIGNED','RESOLVED','CLOSED'])[1 + (d.n % 5)]::"IncidentStatus" AS s) stat,
ctx
WHERE d.n % 20 = 0;

-- Field-app accounts for the sync scenario: 200 synthetic polling agents, each linked to the agent record
-- of one deployed load station and holding a POLLING_AGENT grant for that station only (same password as
-- the seed's agent1@; no MFA, like the seed's polling agents). Sync load is then spread over 200 stations
-- instead of every request reporting for one station.
CREATE TEMP TABLE l_agent_user ON COMMIT DROP AS
SELECT d.agent_id, d.code, ps.id AS station_id, gen_random_uuid() AS user_id, row_number() OVER (ORDER BY d.n) AS k
FROM l_dep d JOIN polling_stations ps ON ps.code = d.code JOIN ctx ON ps.registry_version_id = ctx.registry_id
ORDER BY d.n LIMIT 200;
INSERT INTO users (id, tenant_id, email, display_name, password_hash, status, mfa_enabled, updated_at)
SELECT au.user_id, ctx.tenant_id, format('load.agent%s@demo.example.org', au.k), format('Load agent %s (synthetic)', au.k),
       (SELECT password_hash FROM users WHERE id = ctx.agent_user_id), 'ACTIVE', false, now()
FROM l_agent_user au, ctx;
UPDATE agents a SET user_id = au.user_id FROM l_agent_user au WHERE a.id = au.agent_id;
INSERT INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, polling_station_id, polling_station_code, election_cycle_id, reason)
SELECT gen_random_uuid(), ctx.tenant_id, au.user_id, ra.role_id, 'POLLING_STATION', au.station_id, au.code, ctx.cycle_id, 'Synthetic load test'
FROM l_agent_user au, ctx
JOIN role_assignments ra ON ra.user_id = ctx.agent_user_id AND ra.revoked_at IS NULL;

COMMIT;

ANALYZE geographic_units, polling_stations, registry_versions, stored_files, result_submissions, result_values, verifications,
        agents, deployments, field_reports, incidents;

SELECT 'stations' AS what, count(*) FROM polling_stations ps JOIN registry_versions r ON r.id = ps.registry_version_id WHERE r.version = 'LOAD-55K'
UNION ALL SELECT 'submissions', count(*) FROM result_submissions WHERE reference LIKE 'LOAD-SUB-%'
UNION ALL SELECT 'result_values', count(*) FROM result_values rv JOIN result_submissions rs ON rs.id = rv.submission_id WHERE rs.reference LIKE 'LOAD-SUB-%'
UNION ALL SELECT 'verifications', count(*) FROM verifications v JOIN result_submissions rs ON rs.id = v.submission_id WHERE rs.reference LIKE 'LOAD-SUB-%'
UNION ALL SELECT 'agents', count(*) FROM agents WHERE reference LIKE 'LOAD-AGT-%'
UNION ALL SELECT 'deployments', count(*) FROM deployments WHERE polling_station_code LIKE 'LD-%'
UNION ALL SELECT 'field_reports', count(*) FROM field_reports WHERE reference LIKE 'LOAD-FRP-%'
UNION ALL SELECT 'incidents', count(*) FROM incidents WHERE reference LIKE 'LOAD-INC-%'
UNION ALL SELECT 'agent_users', count(*) FROM users WHERE email LIKE 'load.agent%';
