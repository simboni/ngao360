-- Platform infrastructure: ledger approval needs a CLEAN supporting document (platform-infra).
--
-- Until now a supporting document counted unless it was flagged INFECTED, because no scanner
-- existed. With the malware-scanning worker in place the rule is fail closed (API contract §34):
-- approval needs at least one supporting document whose scan came back CLEAN (PENDING, ERROR and
-- SKIPPED do not count) and still no INFECTED one. Same function as
-- 20261126000000_campaign_review_fixes otherwise.

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
       WHERE d.transaction_id = NEW.id AND f.malware_scan_status = 'CLEAN'
    ) THEN
      RAISE EXCEPTION 'APPROVAL_INCOMPLETE: a ledger entry needs a supporting document with a clean malware scan before approval'
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
