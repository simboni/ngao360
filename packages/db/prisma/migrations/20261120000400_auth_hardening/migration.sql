-- Auth hardening (review findings):
--  * per-user TOTP failure counter and lockout, separate from the password lockout;
--  * single-use invitation tokens so administrators never choose another
--    person's password (blueprint 3.2 separation of duties).
ALTER TABLE "users"
  ADD COLUMN "failed_mfa_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mfa_locked_until" TIMESTAMPTZ(3),
  ADD COLUMN "invitation_token_hash" TEXT,
  ADD COLUMN "invitation_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "invited_by_id" UUID;

CREATE UNIQUE INDEX "users_invitation_token_hash_key" ON "users"("invitation_token_hash");

ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
