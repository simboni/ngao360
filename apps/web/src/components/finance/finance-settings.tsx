'use client';

/**
 * Finance limit settings (blueprint 15.3; API §27.6). Single-source caps,
 * spending limits and reporting deadlines are versioned rows with effective
 * dates, a mandatory legal source note, a verified flag and warn / block
 * enforcement. Nothing is built in: the 2026 regulations are contested, so an
 * organisation configures each value to the law that applies to it, and a
 * block only takes effect once a setting is verified. Changing a value creates
 * a new version (supersede); earlier versions are kept.
 */
import {
  type CreateFinanceLimitSetting,
  CreateFinanceLimitSettingSchema,
  type ElectionCycle,
  FINANCE_CAP_BASES,
  FINANCE_LIMIT_KINDS,
  type FinanceCapBasis,
  type FinanceLimitKind,
  type FinanceLimitSetting,
  LIMIT_ENFORCEMENT_LABELS,
  type LimitEnforcement,
  OFFICE_TYPE_LABELS,
  OFFICE_TYPES,
  type OfficeType,
  type Paginated,
  type SupersedeFinanceLimitSetting,
  UNVERIFIED_LIMIT_LABEL,
} from '@ngao360/shared';
import { History, Plus, Scale, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { financeApi } from './finance-api';
import { CAP_BASIS_LABELS, effectiveEnforcement, LIMIT_STATE_LABELS, limitKindLabel, limitState, limitValueLabel, minorToInput, parseAmount, todayInNairobi } from './finance-model';
import { UnverifiedBadge, VerifiedBadge } from './finance-ui';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

export function FinanceSettings() {
  const { can, me } = useAuth();
  const canManage = can('finance.settings.manage');
  const [showSuperseded, setShowSuperseded] = useState(true);
  const [kind, setKind] = useState<FinanceLimitKind | ''>('');
  const limits = useAsync(() => financeApi.limits({ includeSuperseded: showSuperseded, ...(kind ? { kind } : {}) }), [showSuperseded, kind]);
  const cycles = useAsync(
    () =>
      api
        .get<Paginated<ElectionCycle>>('/reference/election-cycles', { query: { pageSize: 100 } })
        .then((p) => p.items)
        .catch(() => [] as ElectionCycle[]),
    [],
  );
  const [creating, setCreating] = useState(false);
  const [superseding, setSuperseding] = useState<FinanceLimitSetting | null>(null);
  const [verifying, setVerifying] = useState<FinanceLimitSetting | null>(null);
  const today = todayInNairobi();

  const cycleName = (id: string | null) => (id ? (cycles.data?.find((c) => c.id === id)?.name ?? 'Election cycle') : 'Every election cycle');
  const grouped = useMemo(() => {
    const out = new Map<FinanceLimitKind, FinanceLimitSetting[]>();
    for (const k of FINANCE_LIMIT_KINDS) out.set(k, []);
    for (const s of limits.data ?? []) out.get(s.kind)?.push(s);
    for (const list of out.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    return out;
  }, [limits.data]);

  return (
    <>
      <PageHeader
        title="Finance limit settings"
        breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance', href: '/finance' }, { label: 'Settings' }]}
        description="Caps, spending limits and reporting deadlines your organisation applies, each with effective dates and its legal source. Changes create a new version; earlier versions are kept."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New setting
            </Button>
          ) : null
        }
      />
      <Notice tone="warning" className="mb-4" title="No limit is built into NGAO360">
        Campaign-finance rules for the 2026 cycle are contested. Configure each value to the law that applies to you and record its source. A setting stays
        “{UNVERIFIED_LIMIT_LABEL}” until someone with finance settings rights verifies it, and an unverified setting only ever warns, even when set to block.
      </Notice>
      {!canManage ? (
        <Notice tone="info" className="mb-4">
          You can view settings. Creating, superseding or verifying them needs the finance.settings.manage permission and a password confirmation.
        </Notice>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="ls-kind" className="ngao-label">
            Kind
          </label>
          <select id="ls-kind" className="ngao-input pr-8" value={kind} onChange={(e) => setKind(e.target.value as FinanceLimitKind | '')}>
            <option value="">All kinds</option>
            {FINANCE_LIMIT_KINDS.map((k) => (
              <option key={k} value={k}>
                {limitKindLabel(k)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-10 items-center gap-2 text-body text-ink">
          <input type="checkbox" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />
          Show superseded versions
        </label>
      </div>

      {limits.error ? <Notice tone="error" className="mb-4">{describeCampaignError(limits.error)}</Notice> : null}
      {limits.loading && !limits.data ? <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" /> : null}

      {limits.data && limits.data.length === 0 ? (
        <Card>
          <EmptyState icon={Scale} title="No limit settings yet" description="Without settings, no limit findings are produced. Add the caps, limits and deadlines that apply to your organisation." />
        </Card>
      ) : null}

      <div className="space-y-6">
        {[...grouped.entries()]
          .filter(([, list]) => list.length > 0)
          .map(([k, list]) => (
            <section key={k} aria-label={limitKindLabel(k)}>
              <h2 className="mb-2 text-card font-semibold text-ink">{limitKindLabel(k)}</h2>
              <ul className="space-y-3">
                {list.map((s) => {
                  const state = limitState(s, today);
                  const enf = effectiveEnforcement(s);
                  return (
                    <li key={s.id} className={cn('ngao-card p-4', state === 'ENDED' && 'opacity-80')}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-ink">{s.label}</span>
                            {s.verified ? <VerifiedBadge /> : <UnverifiedBadge />}
                            <StatusBadge
                              kind="custom"
                              status={state}
                              label={LIMIT_STATE_LABELS[state]}
                              tone={state === 'ACTIVE' ? 'info' : 'muted'}
                              icon={state === 'ACTIVE' ? ShieldCheck : History}
                              size="sm"
                            />
                          </div>
                          <p className="mt-1 text-section font-semibold tabular-nums text-navy">{limitValueLabel(s)}</p>
                          <p className="text-meta text-slate">
                            {s.periodLabel} · {cycleName(s.electionCycleId)} · {s.officeType ? OFFICE_TYPE_LABELS[s.officeType] : 'Every position'}
                          </p>
                          <p className="text-meta text-slate">
                            Effective {s.effectiveFrom} to {s.effectiveTo ?? 'further notice'} · {LIMIT_ENFORCEMENT_LABELS[s.enforcement]}
                            {enf.note ? ` (${enf.note})` : ''}
                          </p>
                        </div>
                        {canManage && state !== 'ENDED' ? (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="secondary" onClick={() => setSuperseding(s)}>
                              New version
                            </Button>
                            {s.verified || s.createdBy.id !== me?.user.id ? (
                              <Button size="sm" variant="secondary" onClick={() => setVerifying(s)}>
                                {s.verified ? <ShieldQuestion className="h-4 w-4" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
                                {s.verified ? 'Mark unverified' : 'Verify'}
                              </Button>
                            ) : (
                              <span className="self-center text-meta text-slate">You entered this setting: another person verifies it.</span>
                            )}
                          </div>
                        ) : null}
                      </div>
                      <p className="mt-2 flex items-start gap-1 rounded-lg bg-cloud px-3 py-2 text-body text-ink">
                        <Scale className="mt-1 h-3.5 w-3.5 shrink-0 text-slate" aria-hidden />
                        <span>
                          <span className="font-medium">Legal source: </span>
                          {s.legalSourceNote}
                        </span>
                      </p>
                      <p className="mt-1 text-meta text-slate">
                        Created by {s.createdBy.displayName} · {formatDateTime(s.createdAt)}
                        {s.verifiedBy ? ` · verified by ${s.verifiedBy.displayName} ${formatDateTime(s.verifiedAt)}` : ''}
                        {s.supersedesId ? ' · replaces an earlier version' : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
      </div>

      {creating ? <LimitFormDialog cycles={cycles.data ?? []} onClose={() => setCreating(false)} onSaved={() => void limits.reload()} /> : null}
      {superseding ? <LimitFormDialog cycles={cycles.data ?? []} existing={superseding} onClose={() => setSuperseding(null)} onSaved={() => void limits.reload()} /> : null}
      {verifying ? <VerifyDialog setting={verifying} onClose={() => setVerifying(null)} onSaved={() => void limits.reload()} /> : null}
    </>
  );
}

export interface LimitForm {
  kind: FinanceLimitKind;
  label: string;
  percent: string;
  capBasis: FinanceCapBasis;
  amount: string;
  currency: string;
  deadlineDate: string;
  electionCycleId: string;
  periodLabel: string;
  officeType: OfficeType | '';
  effectiveFrom: string;
  effectiveTo: string;
  legalSourceNote: string;
  verified: boolean;
  enforcement: LimitEnforcement;
  reason: string;
}

/** "20" / "20.5" / "20.25" % → basis points without floating point; null when not a valid percentage. */
export function percentToBasisPoints(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bp >= 1 && bp <= 10000 ? bp : null;
}

export function basisPointsToPercentInput(bp: number | null): string {
  if (bp == null) return '';
  const frac = bp % 100;
  return frac ? `${Math.trunc(bp / 100)}.${String(frac).padStart(2, '0')}` : String(bp / 100);
}

/** Build the create / supersede body from the form (kind-specific value columns only). */
export function buildLimitBody(f: LimitForm): { body: CreateFinanceLimitSetting } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  let valueBasisPoints: number | null = null;
  let valueMinor: number | null = null;
  if (f.kind === 'SINGLE_SOURCE_CAP_PCT') {
    valueBasisPoints = percentToBasisPoints(f.percent);
    if (valueBasisPoints === null) errors.percent = 'Enter a percentage between 0.01 and 100 (up to two decimals)';
  } else if (f.kind === 'SPENDING_LIMIT') {
    const a = parseAmount(f.amount, f.currency);
    if ('error' in a) errors.amount = a.error;
    else valueMinor = a.minor;
  } else if (!f.deadlineDate) errors.deadlineDate = 'Choose the deadline date';
  const candidate = {
    kind: f.kind,
    label: f.label.trim(),
    valueBasisPoints: f.kind === 'SINGLE_SOURCE_CAP_PCT' ? valueBasisPoints : null,
    capBasis: f.kind === 'SINGLE_SOURCE_CAP_PCT' ? f.capBasis : null,
    valueMinor: f.kind === 'SPENDING_LIMIT' ? valueMinor : null,
    currency: f.kind === 'SPENDING_LIMIT' ? f.currency : null,
    deadlineDate: f.kind === 'REPORTING_DEADLINE' ? f.deadlineDate || null : null,
    electionCycleId: f.electionCycleId || null,
    periodLabel: f.periodLabel.trim(),
    officeType: f.officeType || null,
    effectiveFrom: f.effectiveFrom,
    effectiveTo: f.effectiveTo || null,
    legalSourceNote: f.legalSourceNote.trim(),
    verified: f.verified,
    enforcement: f.enforcement,
  };
  const parsed = CreateFinanceLimitSettingSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const key = String(i.path[0] ?? 'form');
      if (['valueBasisPoints', 'valueMinor', 'kind'].includes(key) && Object.keys(errors).length) continue;
      errors[key] ??= i.message;
    }
  }
  if (Object.keys(errors).length || !parsed.success) return { errors };
  return { body: parsed.data };
}

export function formFrom(s?: FinanceLimitSetting): LimitForm {
  return {
    kind: s?.kind ?? 'SINGLE_SOURCE_CAP_PCT',
    label: s?.label ?? '',
    percent: basisPointsToPercentInput(s?.valueBasisPoints ?? null),
    capBasis: s?.capBasis ?? 'TOTAL_CONTRIBUTIONS',
    amount: minorToInput(s?.valueMinor ?? null),
    currency: s?.currency ?? 'KES',
    deadlineDate: s?.deadlineDate ?? '',
    electionCycleId: s?.electionCycleId ?? '',
    periodLabel: s?.periodLabel ?? '',
    officeType: s?.officeType ?? '',
    effectiveFrom: s ? todayInNairobi() : '',
    effectiveTo: '',
    legalSourceNote: s?.legalSourceNote ?? '',
    verified: false,
    enforcement: s?.enforcement ?? 'WARN',
    reason: '',
  };
}

function LimitFormDialog({ existing, cycles, onClose, onSaved }: { existing?: FinanceLimitSetting; cycles: ElectionCycle[]; onClose: () => void; onSaved: () => void }) {
  const highRisk = useHighRisk();
  const [f, setF] = useState<LimitForm>(() => formFrom(existing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setF(formFrom(existing)), [existing]);
  const set = <K extends keyof LimitForm>(k: K, v: LimitForm[K]) => setF((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildLimitBody(f);
    if (existing && f.reason.trim().length < 3) {
      setErrors({ ...('errors' in built ? built.errors : {}), reason: 'Give the reason for the new version' });
      return;
    }
    if ('errors' in built) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        const { kind: _kind, ...rest } = built.body;
        const body: SupersedeFinanceLimitSetting = { ...rest, reason: f.reason.trim() };
        await highRisk(() => financeApi.supersedeLimit(existing.id, body));
      } else {
        await highRisk(() => financeApi.createLimit(built.body));
      }
      onSaved();
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={existing ? `New version of “${existing.label}”` : 'New limit setting'}
      description={
        existing
          ? 'The current version ends the day before the new effective date. Its values are kept unchanged in the history.'
          : 'Record the value exactly as the applicable instrument states it, with the instrument and section in the legal source note.'
      }
    >
      <form onSubmit={submit} noValidate>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="lf-kind" label="Kind" required>
            <select id="lf-kind" className="ngao-input pr-8" value={f.kind} disabled={!!existing} onChange={(e) => set('kind', e.target.value as FinanceLimitKind)}>
              {FINANCE_LIMIT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {limitKindLabel(k)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="lf-label" label="Label" required error={errors.label}>
            <input id="lf-label" className="ngao-input" value={f.label} maxLength={160} onChange={(e) => set('label', e.target.value)} />
          </FormField>
          {f.kind === 'SINGLE_SOURCE_CAP_PCT' ? (
            <>
              <FormField id="lf-pct" label="Cap (%)" required error={errors.percent ?? errors.valueBasisPoints}>
                <input id="lf-pct" inputMode="decimal" className="ngao-input tabular-nums" value={f.percent} onChange={(e) => set('percent', e.target.value)} placeholder="e.g. 20" />
              </FormField>
              <FormField id="lf-basis" label="Measured against" required error={errors.capBasis}>
                <select id="lf-basis" className="ngao-input pr-8" value={f.capBasis} onChange={(e) => set('capBasis', e.target.value as FinanceCapBasis)}>
                  {FINANCE_CAP_BASES.map((b) => (
                    <option key={b} value={b}>
                      {CAP_BASIS_LABELS[b].replace(/^of /, '')}
                    </option>
                  ))}
                </select>
              </FormField>
            </>
          ) : null}
          {f.kind === 'SPENDING_LIMIT' ? (
            <>
              <FormField id="lf-amount" label={`Limit (${f.currency})`} required error={errors.amount ?? errors.valueMinor}>
                <input id="lf-amount" inputMode="decimal" className="ngao-input tabular-nums" value={f.amount} onChange={(e) => set('amount', e.target.value)} />
              </FormField>
              <FormField id="lf-ccy" label="Currency" required error={errors.currency}>
                <input id="lf-ccy" className="ngao-input uppercase" value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
              </FormField>
            </>
          ) : null}
          {f.kind === 'REPORTING_DEADLINE' ? (
            <FormField id="lf-deadline" label="Deadline" required error={errors.deadlineDate}>
              <input id="lf-deadline" type="date" className="ngao-input" value={f.deadlineDate} onChange={(e) => set('deadlineDate', e.target.value)} />
            </FormField>
          ) : null}
          <FormField id="lf-period" label="Election period" required error={errors.periodLabel} hint="e.g. “2027 general election campaign period”">
            <input id="lf-period" className="ngao-input" value={f.periodLabel} maxLength={120} onChange={(e) => set('periodLabel', e.target.value)} />
          </FormField>
          <FormField id="lf-cycle" label="Election cycle" hint={cycles.length ? undefined : 'No cycles available to you; the setting applies to every cycle.'}>
            <select id="lf-cycle" className="ngao-input pr-8" value={f.electionCycleId} onChange={(e) => set('electionCycleId', e.target.value)}>
              <option value="">Every election cycle</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="lf-office" label="Elective position">
            <select id="lf-office" className="ngao-input pr-8" value={f.officeType} onChange={(e) => set('officeType', e.target.value as OfficeType | '')}>
              <option value="">Every position</option>
              {OFFICE_TYPES.map((o) => (
                <option key={o} value={o}>
                  {OFFICE_TYPE_LABELS[o]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="lf-enf" label="Enforcement" required hint="A block only applies once the setting is verified.">
            <select id="lf-enf" className="ngao-input pr-8" value={f.enforcement} onChange={(e) => set('enforcement', e.target.value as LimitEnforcement)}>
              <option value="WARN">{LIMIT_ENFORCEMENT_LABELS.WARN}</option>
              <option value="BLOCK">{LIMIT_ENFORCEMENT_LABELS.BLOCK}</option>
            </select>
          </FormField>
          <FormField id="lf-from" label="Effective from" required error={errors.effectiveFrom}>
            <input id="lf-from" type="date" className="ngao-input" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />
          </FormField>
          <FormField id="lf-to" label="Effective to" error={errors.effectiveTo} hint="Leave empty until further notice.">
            <input id="lf-to" type="date" className="ngao-input" value={f.effectiveTo} min={f.effectiveFrom || undefined} onChange={(e) => set('effectiveTo', e.target.value)} />
          </FormField>
        </div>
        <FormField
          id="lf-source"
          label="Legal source note"
          required
          error={errors.legalSourceNote}
          hint="Act, regulation or gazette notice and section, or “pending legal advice”. At least 10 characters. Shown wherever a finding uses this setting."
        >
          <textarea id="lf-source" className={textareaClass} value={f.legalSourceNote} maxLength={2000} onChange={(e) => set('legalSourceNote', e.target.value)} />
        </FormField>
        <p className="mb-4 text-body text-slate">
          The setting starts as “{UNVERIFIED_LIMIT_LABEL}”. Once legal review confirms the value and that the instrument is in force, another person with finance settings rights verifies it.
        </p>
        {existing ? (
          <FormField id="lf-reason" label="Reason for the new version" required error={errors.reason}>
            <textarea id="lf-reason" className={textareaClass} value={f.reason} maxLength={2000} onChange={(e) => set('reason', e.target.value)} />
          </FormField>
        ) : null}
        {errors.form || errors.kind ? <Notice tone="error" className="mb-4">{errors.form ?? errors.kind}</Notice> : null}
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {existing ? 'Confirm and save version' : 'Confirm and save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function VerifyDialog({ setting, onClose, onSaved }: { setting: FinanceLimitSetting; onClose: () => void; onSaved: () => void }) {
  const highRisk = useHighRisk();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = !setting.verified;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await highRisk(() => financeApi.verifyLimit(setting.id, { verified: target, reason: reason.trim() }));
      onSaved();
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={target ? 'Verify this setting' : 'Mark this setting unverified'}
      description={
        target
          ? 'Confirm that legal review has checked the value against the instrument cited and that it is in force. Verified block settings will stop approvals that exceed them.'
          : 'The setting will show as unverified again and will only warn.'
      }
    >
      <form onSubmit={submit}>
        <p className="mb-2 font-medium text-ink">
          {setting.label}: {limitValueLabel(setting)}
        </p>
        <p className="mb-4 text-meta text-slate">Legal source: {setting.legalSourceNote}</p>
        <FormField id="vf-reason" label="Reason" required hint="Recorded in the audit log.">
          <textarea id="vf-reason" className={textareaClass} value={reason} minLength={3} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={reason.trim().length < 3}>
            Confirm
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
