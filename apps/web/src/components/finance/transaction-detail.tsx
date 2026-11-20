'use client';

/**
 * Ledger entry detail (S10; API §27.1): amounts, counterparty, approval
 * prerequisites, live limit findings, supporting documents, the append-only
 * timeline and the request → approve → pay workflow. Every workflow button is
 * shown; an unavailable one is disabled with the reason (separation of duties,
 * status, permission or missing prerequisites). Approve, pay and reverse need
 * a fresh re-authentication.
 */
import {
  FINANCE_APPROVAL_BLOCKER_LABELS,
  FINANCE_DOCUMENT_KINDS,
  FINANCE_TRANSACTION_TYPE_LABELS,
  type FinanceDocumentKind,
  type FinanceTransactionDetail,
  type FinanceTransition,
} from '@ngao360/shared';
import { CheckCircle2, Circle, ExternalLink, FileText, Lock, Paperclip, Pencil, RotateCcw, ShieldAlert, ShieldOff, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { Facts, FormField, formatBytes, localInputToIso, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ApiRequestError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { financeApi } from './finance-api';
import { type ActionAvailability, explainAction, type FinanceAction, findingViews, money, WORKFLOW_ACTIONS } from './finance-model';
import { ComplianceFindings, TransactionStatusBadge } from './finance-ui';
import { TransactionFormDialog } from './transaction-form';
import { useFinanceRefs } from './use-finance-refs';

const DOC_KIND_LABELS: Record<FinanceDocumentKind, string> = {
  INVOICE: 'Invoice',
  RECEIPT: 'Receipt',
  CONTRACT: 'Contract',
  BANK_SLIP: 'Bank slip',
  MOBILE_MONEY_STATEMENT: 'Mobile-money statement',
  APPROVAL_MEMO: 'Approval memo',
  DECLARATION: 'Contributor declaration',
  OTHER: 'Other',
};

const EVENT_LABELS: Record<string, string> = {
  CREATED: 'Draft created',
  UPDATED: 'Draft edited',
  DOCUMENT_ADDED: 'Document attached',
  REQUESTED: 'Submitted for approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PAID: 'Payment recorded',
  CANCELLED: 'Cancelled',
  REVERSED: 'Reversed',
  COMPLIANCE_EVALUATED: 'Limit check recorded',
};

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

export function TransactionDetailView({ id }: { id: string }) {
  const { me } = useAuth();
  const router = useRouter();
  const { data: tx, error, loading, reload, setData } = useAsync(() => financeApi.transaction(id), [id]);
  const { refs } = useFinanceRefs();
  const [active, setActive] = useState<FinanceAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [attaching, setAttaching] = useState(false);

  const perms = useMemo(() => new Set<string>(me?.permissions ?? []), [me]);

  if (loading && !tx) return <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" aria-live="polite" />;
  if (error && !tx) {
    return (
      <>
        <PageHeader title="Ledger entry" breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance', href: '/finance' }, { label: 'Entry' }]} />
        <Card>
          <EmptyState icon={ShieldOff} title="This entry could not be opened" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />
        </Card>
      </>
    );
  }
  if (!tx) return null;

  const ctx = { userId: me?.user.id, permissions: perms };
  const actions = WORKFLOW_ACTIONS.map((a) => explainAction(a, tx, ctx));
  const sodReasons = actions.filter((a) => a.sod && a.reason);
  const editable = explainAction('EDIT', tx, ctx);
  const canAttach = explainAction('ADD_DOCUMENT', tx, ctx);
  const frozen = ['APPROVED', 'PAID', 'REVERSED', 'REJECTED', 'CANCELLED'].includes(tx.status);

  return (
    <>
      <PageHeader
        title={`${FINANCE_TRANSACTION_TYPE_LABELS[tx.type]} ${tx.reference}`}
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance', href: '/finance' }, { label: tx.reference }]}
        status={<TransactionStatusBadge status={tx.status} />}
        description={tx.description}
        actions={
          editable.enabled ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit draft
            </Button>
          ) : null
        }
      />

      {tx.reversesId ? (
        <Notice tone="info" className="mb-4" title="Reversing entry">
          This entry reverses <Link className="font-medium text-deep-blue underline" href={`/finance/transactions/${tx.reversesId}`}>the original entry</Link>. When it is approved the original is marked reversed. It needs approval by someone other than its requester.
        </Notice>
      ) : null}
      {tx.reversedById ? (
        <Notice tone="warning" className="mb-4" title="This entry has a reversing entry">
          See <Link className="font-medium text-deep-blue underline" href={`/finance/transactions/${tx.reversedById}`}>the reversal</Link>. The original stays in the ledger unchanged.
        </Notice>
      ) : null}
      {frozen ? (
        <p className="mb-4 flex items-center gap-2 text-meta text-slate">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Amount, account, category and counterparty are frozen at this status. Corrections are made with a reversing entry.
        </p>
      ) : null}

      <section aria-label="Workflow actions" className="ngao-card mb-6 p-4">
        <h2 className="mb-3 text-card font-semibold text-ink">Workflow</h2>
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {actions.map((a) => (
            <ActionTile key={a.action} a={a} onClick={() => setActive(a.action)} />
          ))}
        </ul>
        {sodReasons.length ? (
          <Notice tone="sod" className="mt-3" title="Separation of duties">
            The requester cannot approve or pay their own request; when your organisation separates approval from payment, the approver cannot record the payment.
          </Notice>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Entry" />
            <CardBody>
              <Facts
                items={[
                  { label: 'Amount', value: <span className="text-section font-semibold tabular-nums text-navy">{money(tx.amount)}</span> },
                  { label: 'Transaction date', value: tx.transactionDate },
                  { label: 'Account', value: tx.account.name },
                  ...(tx.counterAccount ? [{ label: 'Counter account', value: tx.counterAccount.name }] : []),
                  { label: 'Category', value: `${tx.category.code} · ${tx.category.name}` },
                  { label: tx.type === 'CONTRIBUTION' ? 'Contributor' : 'Payee', value: tx.counterparty?.name ?? '—' },
                  { label: 'Receipt / invoice reference', value: tx.externalReference ?? '—' },
                  { label: 'Budget line', value: tx.budgetLine ? `${tx.budgetLine.code} · ${tx.budgetLine.name}` : '—' },
                  { label: 'Department', value: tx.department?.name ?? '—' },
                  { label: 'Requested by', value: `${tx.requestedBy.displayName}${tx.requestedAt ? ` · ${formatDateTime(tx.requestedAt)}` : ''}` },
                  { label: 'Approved by', value: tx.approvedBy ? `${tx.approvedBy.displayName} · ${formatDateTime(tx.approvedAt)}` : '—' },
                  { label: 'Paid by', value: tx.paidBy ? `${tx.paidBy.displayName} · ${formatDateTime(tx.paidAt)}` : '—' },
                  { label: 'Payment reference', value: tx.paymentReference ?? '—' },
                  ...(tx.rejectedBy ? [{ label: 'Rejected by', value: `${tx.rejectedBy.displayName}: ${tx.rejectionReason ?? ''}` }] : []),
                  { label: 'Created', value: formatDateTime(tx.createdAt) },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Supporting documents (${tx.documents.length})`}
              description="Append-only: documents are never removed, even after approval."
              actions={
                canAttach.enabled ? (
                  <Button size="sm" variant="secondary" onClick={() => setAttaching(true)}>
                    <Paperclip className="h-4 w-4" aria-hidden />
                    Attach
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {tx.documents.length === 0 ? (
                <p className="text-body text-slate">No documents yet. At least one is required before approval.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {tx.documents.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                      <FileText className="h-4 w-4 text-slate" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">{d.file.originalFilename}</p>
                        <p className="text-meta text-slate">
                          {DOC_KIND_LABELS[d.kind]} · {formatBytes(d.file.sizeBytes)} · {d.addedBy.displayName} · {formatDateTime(d.createdAt)}
                          {d.file.malwareScanStatus !== 'CLEAN' ? ` · scan: ${d.file.malwareScanStatus.toLowerCase()}` : ''}
                        </p>
                        {d.note ? <p className="text-meta text-ink">{d.note}</p> : null}
                      </div>
                      <OpenDocumentButton txId={tx.id} documentId={d.id} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Timeline" description="Append-only record of every change, oldest first." />
            <CardBody>
              <ol className="relative space-y-3 border-l border-line pl-5">
                {tx.timeline.map((e) => (
                  <li key={e.id} className="relative">
                    <span className={cn('absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface', e.type === 'REJECTED' || e.type === 'CANCELLED' ? 'bg-error' : e.type === 'COMPLIANCE_EVALUATED' ? 'bg-gold' : 'bg-deep-blue')} aria-hidden />
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="font-medium text-ink">{EVENT_LABELS[e.type] ?? e.type}</span>
                      <span className="text-meta text-slate">
                        {e.actor.displayName} · <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
                      </span>
                    </div>
                    {e.note ? <p className="text-body text-ink">{e.note}</p> : null}
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6 self-start">
          <Card>
            <CardHeader title="Before approval" description="Every entry needs these before it can be approved." />
            <CardBody>
              <ApprovalChecklist tx={tx} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Limit check" description="Current evaluation against your organisation's limit settings." />
            <CardBody>
              <ComplianceFindings findings={tx.compliance} emptyText="No limit findings for this entry." />
            </CardBody>
          </Card>
        </div>
      </div>

      <TransactionFormDialog open={editing} onClose={() => setEditing(false)} refs={refs} existing={tx} onSaved={setData} />
      <AttachDocumentDialog open={attaching} onClose={() => setAttaching(false)} tx={tx} onAttached={() => void reload()} />
      <ActionDialog
        action={active}
        tx={tx}
        onClose={() => setActive(null)}
        onDone={(next, navigate) => {
          setActive(null);
          if (navigate) router.push(`/finance/transactions/${next.id}`);
          else setData(next);
        }}
      />
    </>
  );
}

function ActionTile({ a, onClick }: { a: ActionAvailability; onClick: () => void }) {
  const descId = `act-${a.action}-why`;
  return (
    <li className={cn('rounded-lg border p-3', a.enabled ? 'border-line' : 'border-dashed border-line bg-cloud/40')}>
      <Button
        size="sm"
        variant={a.spec.tone === 'danger' ? 'danger' : a.spec.tone === 'secondary' ? 'secondary' : 'primary'}
        disabled={!a.enabled}
        aria-describedby={a.reason ? descId : undefined}
        onClick={onClick}
      >
        {a.action === 'REVERSE' ? <RotateCcw className="h-4 w-4" aria-hidden /> : null}
        {a.spec.label}
        {a.spec.reauth ? <Lock className="h-3.5 w-3.5" aria-label="needs password confirmation" /> : null}
      </Button>
      {a.reason ? (
        <p id={descId} className={cn('mt-1.5 flex items-start gap-1 text-meta', a.sod ? 'text-deep-blue' : 'text-slate')}>
          {a.sod ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
          {a.reason}
        </p>
      ) : a.spec.reauth ? (
        <p className="mt-1.5 text-meta text-slate">You will be asked to confirm your password.</p>
      ) : null}
    </li>
  );
}

function ApprovalChecklist({ tx }: { tx: FinanceTransactionDetail }) {
  const items: Array<{ key: string; label: string }> = [
    { key: 'CATEGORY_MISSING', label: 'Category' },
    ...(tx.type === 'CONTRIBUTION'
      ? [{ key: 'CONTRIBUTOR_MISSING', label: 'Contribution source' }]
      : tx.type === 'TRANSFER'
        ? [{ key: 'COUNTER_ACCOUNT_MISSING', label: 'Counter account' }]
        : [{ key: 'PAYEE_MISSING', label: 'Payee' }]),
    { key: 'REFERENCE_MISSING', label: 'Receipt / invoice / payment reference' },
    { key: 'SUPPORTING_DOCUMENT_MISSING', label: 'At least one supporting document' },
  ];
  const missing = new Set(tx.approvalBlockers);
  return (
    <ul className="space-y-2">
      {items.map((i) => {
        const ok = !missing.has(i.key);
        return (
          <li key={i.key} className="flex items-start gap-2 text-body">
            {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 text-error" aria-hidden />}
            <span>
              <span className={ok ? 'text-ink' : 'font-medium text-ink'}>{i.label}</span>
              <span className="sr-only">{ok ? ': done' : ': missing'}</span>
              {!ok ? <span className="block text-meta text-slate">{FINANCE_APPROVAL_BLOCKER_LABELS[i.key]}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function OpenDocumentButton({ txId, documentId }: { txId: string; documentId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end">
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const { url } = await financeApi.documentUrl(txId, documentId);
            window.open(url, '_blank', 'noopener,noreferrer');
          } catch (e) {
            setErr(describeCampaignError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        Open
      </Button>
      {err ? <span className="text-meta text-error">{err}</span> : null}
    </span>
  );
}

function AttachDocumentDialog({ open, onClose, tx, onAttached }: { open: boolean; onClose: () => void; tx: FinanceTransactionDetail; onAttached: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<FinanceDocumentKind>(tx.type === 'CONTRIBUTION' ? 'RECEIPT' : 'INVOICE');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await financeApi.upload(file);
      await financeApi.addDocument(tx.id, { fileId: stored.id, kind, ...(note.trim() ? { note: note.trim() } : {}) });
      setFile(null);
      setNote('');
      onAttached();
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Attach a supporting document" description="PDF or image, up to 25 MB. Stored immutably with its SHA-256; documents are never removed.">
      <form onSubmit={submit}>
        <FormField id="doc-file" label="File" required>
          <input id="doc-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block w-full text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </FormField>
        <FormField id="doc-kind" label="Document type" required>
          <select id="doc-kind" className="ngao-input pr-8" value={kind} onChange={(e) => setKind(e.target.value as FinanceDocumentKind)}>
            {FINANCE_DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOC_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="doc-note" label="Note">
          <input id="doc-note" className="ngao-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!file}>
            <Upload className="h-4 w-4" aria-hidden />
            Upload and attach
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const ACTION_COPY: Record<Exclude<FinanceAction, 'EDIT' | 'ADD_DOCUMENT'>, { title: string; description: string; confirm: string }> = {
  SUBMIT: { title: 'Submit for approval', description: 'The entry is checked against your limit settings and sent to finance approvers. You can no longer edit it.', confirm: 'Submit' },
  APPROVE: { title: 'Approve entry', description: 'Approval freezes the amount and details. You will be asked to confirm your password.', confirm: 'Approve' },
  REJECT: { title: 'Reject entry', description: 'The requester is told the reason.', confirm: 'Reject' },
  PAY: { title: 'Record payment', description: 'Records that the money was paid out, received or moved. Written once. You will be asked to confirm your password.', confirm: 'Record payment' },
  CANCEL: { title: 'Cancel entry', description: 'Cancelled entries stay in the ledger with the reason.', confirm: 'Cancel entry' },
  REVERSE: {
    title: 'Reverse this entry',
    description: 'Creates a reversing entry for the same amount, awaiting approval by someone other than you. The original is unchanged until the reversal is approved. You will be asked to confirm your password.',
    confirm: 'Create reversing entry',
  },
};

function ActionDialog({
  action,
  tx,
  onClose,
  onDone,
}: {
  action: FinanceAction | null;
  tx: FinanceTransactionDetail;
  onClose: () => void;
  onDone: (tx: FinanceTransactionDetail, navigate: boolean) => void;
}) {
  const highRisk = useHighRisk();
  const [note, setNote] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverFindings, setServerFindings] = useState<FinanceTransactionDetail['compliance'] | null>(null);

  if (!action || action === 'EDIT' || action === 'ADD_DOCUMENT') return null;
  const copy = ACTION_COPY[action];
  const warnFindings = findingViews(serverFindings ?? tx.compliance).filter((f) => f.level === 'WARN');
  const needsNote = action === 'REJECT' || action === 'CANCEL' || action === 'REVERSE';

  const close = () => {
    setNote('');
    setPaymentReference('');
    setPaidAt('');
    setAck(false);
    setError(null);
    setServerFindings(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (action === 'REVERSE') {
        const reversal = await highRisk(() => financeApi.reverse(tx.id, { reason: note.trim(), expectedVersion: tx.version }));
        close();
        onDone(reversal, true);
        return;
      }
      const body: FinanceTransition = {
        action,
        expectedVersion: tx.version,
        acknowledgeWarnings: action === 'APPROVE' ? ack : false,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(action === 'PAY' ? { paymentReference: paymentReference.trim(), ...(paidAt ? { paidAt: localInputToIso(paidAt) } : {}) } : {}),
      };
      const run = () => financeApi.transition(tx.id, body);
      const next = action === 'APPROVE' || action === 'PAY' ? await highRisk(run) : await run();
      close();
      onDone(next, false);
    } catch (err) {
      if (isCancelled(err)) return;
      if (err instanceof ApiRequestError && (err.code === 'CONFLICT' || err.code === 'LIMIT_EXCEEDED')) {
        const findings = (err.body.details as { findings?: FinanceTransactionDetail['compliance'] } | undefined)?.findings;
        if (findings) {
          setServerFindings(findings);
          setError(
            err.code === 'LIMIT_EXCEEDED'
              ? 'A verified limit setting configured to block applies. The entry cannot be approved.'
              : 'Limit warnings apply. Read them and confirm you have considered them before approving.',
          );
          return;
        }
      }
      if (err instanceof ApiRequestError && err.code === 'APPROVAL_INCOMPLETE') {
        const blockers = (err.body.details as { blockers?: string[] } | undefined)?.blockers ?? [];
        setError(`Not ready for approval: ${blockers.map((b) => FINANCE_APPROVAL_BLOCKER_LABELS[b] ?? b).join('; ') || err.message}`);
        return;
      }
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    (!needsNote || note.trim().length >= 3) && (action !== 'PAY' || paymentReference.trim().length > 0) && (action !== 'APPROVE' || warnFindings.length === 0 || ack);

  return (
    <Dialog open onClose={close} title={`${copy.title} · ${tx.reference}`} description={copy.description}>
      <form onSubmit={submit}>
        <p className="mb-4 text-body text-ink">
          Amount <span className="font-semibold tabular-nums">{money(tx.amount)}</span> · {tx.counterparty?.name ?? '—'}
        </p>
        {action === 'APPROVE' && (serverFindings ?? tx.compliance).length > 0 ? (
          <div className="mb-4">
            <ComplianceFindings findings={serverFindings ?? tx.compliance} />
            {warnFindings.length > 0 ? (
              <label className="mt-3 flex items-start gap-2 text-body text-ink">
                <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I have read these warnings and approve anyway. The acknowledgement is recorded on the entry.
              </label>
            ) : null}
          </div>
        ) : null}
        {action === 'PAY' ? (
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="pay-ref" label="Payment reference" hint="Bank, cheque or mobile-money transaction reference." required>
              <input id="pay-ref" className="ngao-input" value={paymentReference} maxLength={80} onChange={(e) => setPaymentReference(e.target.value)} required />
            </FormField>
            <FormField id="pay-at" label="Paid at" hint="Africa/Nairobi time. Defaults to now.">
              <input id="pay-at" type="datetime-local" className="ngao-input" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </FormField>
          </div>
        ) : null}
        <FormField id="act-note" label={needsNote ? 'Reason' : 'Note'} required={needsNote} hint={needsNote ? 'At least 3 characters. Recorded on the timeline and in the audit log.' : undefined}>
          <textarea id="act-note" className={textareaClass} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Back
          </Button>
          <Button type="submit" variant={action === 'REJECT' || action === 'REVERSE' ? 'danger' : 'primary'} loading={busy} disabled={!ready}>
            {copy.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
