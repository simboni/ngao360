-- Campaign and organisation review fixes.

-- 1. Limit settings: who last changed the verified flag (maker-checker on verification).
ALTER TABLE "finance_limit_settings"
  ADD COLUMN "verification_changed_by_id" UUID,
  ADD COLUMN "verification_changed_at" TIMESTAMPTZ(3);
ALTER TABLE "finance_limit_settings" ADD CONSTRAINT "finance_limit_settings_verification_changed_by_id_fkey"
  FOREIGN KEY ("verification_changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A setting is never verified by the person who entered it (NOT VALID: earlier rows are left as they are).
ALTER TABLE finance_limit_settings
  ADD CONSTRAINT finance_limit_settings_second_verifier_check CHECK (NOT verified OR verified_by_id <> created_by_id) NOT VALID;

-- 2. Contribution sources: who recorded the declaration.
ALTER TABLE "contribution_sources" ADD COLUMN "declared_by_id" UUID;
ALTER TABLE "contribution_sources" ADD CONSTRAINT "contribution_sources_declared_by_id_fkey"
  FOREIGN KEY ("declared_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Reversals: one LIVE reversal per entry. A rejected or cancelled reversal no
--    longer blocks a new one.
DROP INDEX IF EXISTS "finance_transactions_reverses_id_key";
CREATE INDEX "finance_transactions_reverses_id_idx" ON "finance_transactions"("reverses_id");
CREATE UNIQUE INDEX "finance_transactions_live_reversal_key" ON "finance_transactions"("reverses_id")
  WHERE reverses_id IS NOT NULL AND status NOT IN ('REJECTED', 'CANCELLED');

-- 4. Supporting documents: one file backs one live ledger entry (a reversal may
--    cite the document of the entry it reverses), never an infected file.
CREATE OR REPLACE FUNCTION ngao_finance_transaction_documents_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx_reverses uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fin-doc:' || NEW.tenant_id::text || ':' || NEW.file_id::text));
  SELECT reverses_id INTO tx_reverses FROM finance_transactions WHERE id = NEW.transaction_id;
  IF EXISTS (
    SELECT 1
      FROM finance_transaction_documents d
      JOIN finance_transactions t ON t.id = d.transaction_id
     WHERE d.file_id = NEW.file_id
       AND d.transaction_id <> NEW.transaction_id
       AND t.status NOT IN ('REJECTED', 'CANCELLED')
       AND t.id IS DISTINCT FROM tx_reverses
       AND t.reverses_id IS DISTINCT FROM NEW.transaction_id
  ) THEN
    RAISE EXCEPTION 'DOCUMENT_IN_USE: this file already supports another ledger entry'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM stored_files f WHERE f.id = NEW.file_id AND f.malware_scan_status = 'INFECTED') THEN
    RAISE EXCEPTION 'FILE_INFECTED: an infected file cannot support a ledger entry'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_transaction_documents_insert_guard BEFORE INSERT ON finance_transaction_documents
  FOR EACH ROW EXECUTE FUNCTION ngao_finance_transaction_documents_insert_guard();

-- Ledger entries (replaces the campaign_organisation version): approval also needs a
-- supporting document whose file is not flagged INFECTED, and no infected document.
CREATE OR REPLACE FUNCTION ngao_finance_transactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
     OR NEW.reverses_id IS DISTINCT FROM OLD.reverses_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a ledger entry keeps its reference, type, requester and reversal link'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status IN ('APPROVED', 'PAID', 'REVERSED', 'REJECTED', 'CANCELLED') AND (
       NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.counter_account_id IS DISTINCT FROM OLD.counter_account_id
       OR NEW.category_id IS DISTINCT FROM OLD.category_id
       OR NEW.budget_line_id IS DISTINCT FROM OLD.budget_line_id
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
       OR NEW.payee_id IS DISTINCT FROM OLD.payee_id
       OR NEW.contribution_source_id IS DISTINCT FROM OLD.contribution_source_id
       OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.department_id IS DISTINCT FROM OLD.department_id
       OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.election_cycle_id IS DISTINCT FROM OLD.election_cycle_id
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
       OR NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.rejected_by_id IS DISTINCT FROM OLD.rejected_by_id
       OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.compliance_flags IS DISTINCT FROM OLD.compliance_flags
       OR NEW.compliance_evaluated_at IS DISTINCT FROM OLD.compliance_evaluated_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: an approved ledger entry cannot change; record a reversing entry'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IN ('APPROVED', 'PAID', 'REVERSED', 'REJECTED', 'CANCELLED')
     AND NOT ((OLD.status = 'APPROVED' AND NEW.status IN ('PAID', 'REVERSED')) OR (OLD.status = 'PAID' AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: ledger entry status % cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.paid_at IS NOT NULL AND (NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.paid_by_id IS DISTINCT FROM OLD.paid_by_id OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: payment details are recorded once'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a reversal is recorded once'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    IF NEW.external_reference IS NULL OR btrim(NEW.external_reference) = '' THEN
      RAISE EXCEPTION 'APPROVAL_INCOMPLETE: a ledger entry needs a receipt, invoice or payment reference before approval'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM finance_transaction_documents d JOIN stored_files f ON f.id = d.file_id
       WHERE d.transaction_id = NEW.id AND f.malware_scan_status <> 'INFECTED'
    ) THEN
      RAISE EXCEPTION 'APPROVAL_INCOMPLETE: a ledger entry needs a supporting document before approval'
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM finance_transaction_documents d JOIN stored_files f ON f.id = d.file_id
       WHERE d.transaction_id = NEW.id AND f.malware_scan_status = 'INFECTED'
    ) THEN
      RAISE EXCEPTION 'APPROVAL_INCOMPLETE: a supporting document is flagged as infected'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 5. Counterparty identity is frozen once an approved, paid or reversed entry names it
--    (ledger views and registers read these names).
CREATE OR REPLACE FUNCTION ngao_finance_payees_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a payee keeps its tenant and creator' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.name IS DISTINCT FROM OLD.name
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.tax_pin_masked IS DISTINCT FROM OLD.tax_pin_masked
      OR NEW.tax_pin_hash IS DISTINCT FROM OLD.tax_pin_hash)
     AND EXISTS (SELECT 1 FROM finance_transactions t WHERE t.payee_id = OLD.id AND t.status IN ('APPROVED', 'PAID', 'REVERSED')) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: this payee is named on posted ledger entries; its name, kind and tax PIN cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_payees_guard BEFORE UPDATE ON finance_payees
  FOR EACH ROW EXECUTE FUNCTION ngao_finance_payees_guard();

CREATE OR REPLACE FUNCTION ngao_contribution_sources_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: a contribution source keeps its tenant and creator' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.display_name IS DISTINCT FROM OLD.display_name
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.identifier_masked IS DISTINCT FROM OLD.identifier_masked
      OR NEW.identifier_hash IS DISTINCT FROM OLD.identifier_hash
      OR (OLD.declared AND NOT NEW.declared))
     AND EXISTS (SELECT 1 FROM finance_transactions t WHERE t.contribution_source_id = OLD.id AND t.status IN ('APPROVED', 'PAID', 'REVERSED')) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: this contributor is named on posted ledger entries; its identity and declaration cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contribution_sources_guard BEFORE UPDATE ON contribution_sources
  FOR EACH ROW EXECUTE FUNCTION ngao_contribution_sources_guard();

-- 6. Content: the approver is neither the author nor the editorial reviewer
--    (NOT VALID: earlier rows are left as they are).
ALTER TABLE content_items
  ADD CONSTRAINT content_items_approver_not_editor_check CHECK (approver_id IS NULL OR editor_id IS NULL OR approver_id <> editor_id) NOT VALID;

-- 7. Critical alerts: each notification copy is escalated at most once.
CREATE OR REPLACE FUNCTION ngao_notification_acknowledgements_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'ESCALATED' THEN
    PERFORM pg_advisory_xact_lock(hashtext('notif-esc:' || NEW.notification_id::text));
    IF EXISTS (SELECT 1 FROM notification_acknowledgements a WHERE a.notification_id = NEW.notification_id AND a.action = 'ESCALATED') THEN
      RAISE EXCEPTION 'ALREADY_ESCALATED: this alert was already escalated'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notification_acknowledgements_insert_guard BEFORE INSERT ON notification_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION ngao_notification_acknowledgements_insert_guard();
