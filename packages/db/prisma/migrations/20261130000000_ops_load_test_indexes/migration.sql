-- Operational readiness (load test, docs/OPERATIONS.md): indexes for hot read paths at 55k-station scale.
-- Additive only; no table, policy or trigger changes.

-- Submission lists show whether a record has duplicates (lookup by duplicate_of_id for the page's ids).
CREATE INDEX IF NOT EXISTS "result_submissions_duplicate_of_id_idx"
  ON "result_submissions" ("duplicate_of_id") WHERE "duplicate_of_id" IS NOT NULL;

-- The verification queue (view=awaiting_me / awaiting_supervisor) excludes records the caller captured or
-- changed: NOT EXISTS lookups by (confirmed_by_id, submission_id) and (actor_id, submission_id), which
-- otherwise scan every result value (340k rows at 45k forms) on each request.
CREATE INDEX IF NOT EXISTS "result_values_confirmed_by_id_submission_id_idx"
  ON "result_values" ("confirmed_by_id", "submission_id") WHERE "confirmed_by_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "result_value_changes_actor_id_submission_id_idx"
  ON "result_value_changes" ("actor_id", "submission_id");
