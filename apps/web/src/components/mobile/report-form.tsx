'use client';

/**
 * S11 field report on the phone (blueprint 6.1, 11.3; contract §19). The
 * form is rendered from the template VERSION's schema (sections and typed
 * questions); answers are checked with the shared `validateFieldAnswers`
 * before saving, then saved encrypted in the queue and uploaded with an
 * idempotency key. A returned report is answered with a NEW report that
 * names it (`supersedesReportId`), never an edit.
 */
import type { FieldQuestion, FieldReportTemplateSchema, GeoPoint } from '@ngao360/shared';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { QueueValidationError } from '@/lib/offline/queue';
import { answerIssues, buildAnswers, fromLocalInputValue, isTooFarInFuture, stationOptions, toLocalInputValue } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigButton, Field, inputCls, MobileCard, MobileGate, Notice, PageTitle, SourceNote, Spinner } from './mobile-ui';
import { PhotoPicker, type PickedPhoto } from './photo-picker';
import { useFieldMe, useReportTemplate } from './use-field-data';

export function ReportScreen() {
  const params = useSearchParams();
  const templateId = params.get('template');
  return <MobileGate anyOf={['field.reports.submit']}>{templateId ? <ReportForm templateId={templateId} supersedesReportId={params.get('supersedes')} /> : <TemplatePicker />}</MobileGate>;
}

function TemplatePicker() {
  const me = useFieldMe();
  return (
    <>
      <PageTitle sub="Choose the report to fill in. Questions are short and factual.">Field report</PageTitle>
      {me.loading && !me.data ? <Spinner /> : null}
      {me.error ? <Notice tone="error">{me.error}</Notice> : null}
      <SourceNote source={me.source} savedAt={me.savedAt} />
      <ul className="mt-2 flex flex-col gap-2">
        {me.data?.templates.map((t) => (
          <li key={t.id}>
            <Link href={`/m/report?template=${encodeURIComponent(t.id)}`} className="flex min-h-[60px] items-center justify-between rounded-xl border border-line bg-surface px-4">
              <span>
                <span className="block text-card font-semibold text-ink">{t.name}</span>
                <span className="text-meta text-slate">Version {t.version}</span>
              </span>
              <ChevronRight className="h-5 w-5 text-slate" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      {me.data && me.data.templates.length === 0 ? (
        <MobileCard>
          <p className="text-body">No report forms are active for you right now.</p>
        </MobileCard>
      ) : null}
    </>
  );
}

function ReportForm({ templateId, supersedesReportId }: { templateId: string; supersedesReportId: string | null }) {
  const s = useMobileSession();
  const router = useRouter();
  const me = useFieldMe();
  const tpl = useReportTemplate(templateId);
  const stations = useMemo(() => stationOptions(me.data?.assignments ?? []), [me.data]);
  const [station, setStation] = useState('');
  const [eventAt, setEventAt] = useState(() => toLocalInputValue(new Date()));
  const [raw, setRaw] = useState<Record<string, unknown>>({});
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (tpl.loading && !tpl.data) return <Spinner label="Loading the form…" />;
  if (!tpl.data) return <Notice tone="error">{tpl.error ?? 'This form is not available.'}</Notice>;
  const template = tpl.data;
  const schema = template.schema as FieldReportTemplateSchema;
  const code = station || stations[0]?.code || '';

  if (saved) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="success" role="status" title="Report saved">
          {s.online ? 'It is uploading now.' : 'It is saved on this phone and uploads when you are back online.'} The reference appears in the upload queue once the server has it.
        </Notice>
        <BigButton onClick={() => router.push('/m')}>Back to home</BigButton>
        <BigButton tone="secondary" onClick={() => router.push('/m/queue')}>
          Open the upload queue
        </BigButton>
      </div>
    );
  }

  const set = (key: string, value: unknown) => setRaw((r) => ({ ...r, [key]: value }));

  const submit = async () => {
    setFormError(null);
    const answers = buildAnswers(schema, raw);
    const found = answerIssues(schema, answers);
    const iso = fromLocalInputValue(eventAt);
    if (!code) found.__station = 'Choose the station';
    if (!iso) found.__eventAt = 'Enter the date and time';
    else if (isTooFarInFuture(iso, new Date())) found.__eventAt = 'The time cannot be in the future';
    setIssues(found);
    if (Object.keys(found).length > 0 || !iso) {
      setFormError('Some answers need attention.');
      return;
    }
    if (template.status !== 'ACTIVE') {
      setFormError('This form version is no longer active. Go back and choose the current form.');
      return;
    }
    if (!me.data?.electionCycleId) {
      setFormError('No election cycle is set up for field operations. Contact your coordinator.');
      return;
    }
    setSaving(true);
    try {
      const label = stations.find((x) => x.code === code)?.label ?? code;
      const point: GeoPoint | null = null;
      await s.enqueue({
        kind: 'FIELD_REPORT',
        summary: `${template.name} · ${label}`,
        payload: {
          templateId: template.id,
          electionCycleId: me.data.electionCycleId,
          location: { pollingStationCode: code, geographicUnitId: null },
          eventAt: iso,
          answers,
          notes: notes.trim() || null,
          point,
          supersedesReportId,
        },
        attachments: schema.allowEvidence === false ? [] : photos.map((p) => ({ bytes: p.bytes, mimeType: p.mimeType })),
      });
      setSaved(true);
    } catch (err) {
      if (err instanceof QueueValidationError) {
        const map: Record<string, string> = {};
        for (const i of err.issues) {
          const key = i.path[0] === 'answers' ? String(i.path[1]) : `__${String(i.path[0])}`;
          map[key] = i.message;
        }
        setIssues(map);
        setFormError(err.message);
      } else setFormError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageTitle sub={`Version ${template.version}${template.description ? ` · ${template.description}` : ''}`}>{template.name}</PageTitle>
      <SourceNote source={tpl.source} savedAt={tpl.savedAt} />
      {supersedesReportId ? (
        <div className="mb-3">
          <Notice>This report answers a report that was returned for clarification. Your earlier report stays on record unchanged.</Notice>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <MobileCard title="Where and when">
          <div className="flex flex-col gap-3">
            <Field label="Station" htmlFor="rep-station" error={issues.__station ?? issues.__location}>
              <select id="rep-station" className={inputCls} value={code} onChange={(e) => setStation(e.target.value)}>
                {stations.length === 0 ? <option value="">No station assigned</option> : null}
                {stations.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Time of the observation" hint="Defaults to now." htmlFor="rep-time" error={issues.__eventAt}>
              <input id="rep-time" type="datetime-local" className={inputCls} value={eventAt} onChange={(e) => setEventAt(e.target.value)} />
            </Field>
          </div>
        </MobileCard>

        {schema.sections.map((sec) => (
          <MobileCard key={sec.key} title={sec.title}>
            <div className="flex flex-col gap-4">
              {sec.questions.map((q) => (
                <QuestionField key={q.key} q={q} value={raw[q.key]} error={issues[q.key]} onChange={(v) => set(q.key, v)} />
              ))}
            </div>
          </MobileCard>
        ))}

        <MobileCard title="Notes and photos">
          <div className="flex flex-col gap-3">
            <Field label="Notes (optional)" hint="Facts only. No names, phone or ID numbers." htmlFor="rep-notes">
              <textarea id="rep-notes" className={`${inputCls} min-h-[96px] py-2`} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {schema.allowEvidence !== false ? <PhotoPicker photos={photos} onChange={setPhotos} /> : null}
          </div>
        </MobileCard>

        {formError ? (
          <Notice tone="error" role="alert">
            {formError}
          </Notice>
        ) : null}
        <BigButton type="submit" loading={saving} disabled={!s.queue}>
          {s.online ? 'Save and upload' : 'Save on this phone'}
        </BigButton>
      </form>
    </>
  );
}

/** One question rendered by type (YES_NO, NUMBER, TIME, SINGLE/MULTI_CHOICE, SHORT/LONG_TEXT). */
export function QuestionField({ q, value, error, onChange }: { q: FieldQuestion; value: unknown; error?: string; onChange: (v: unknown) => void }) {
  const id = `q-${q.key}`;
  const label = (
    <>
      {q.label}
      {q.required ? <span className="text-error"> *</span> : <span className="font-normal text-slate"> (optional)</span>}
    </>
  );
  switch (q.type) {
    case 'YES_NO':
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-body font-medium text-ink">{label}</legend>
          {q.helpText ? <p className="text-meta text-slate">{q.helpText}</p> : null}
          <div className="mt-1 grid grid-cols-2 gap-2">
            {[
              { v: true, t: 'Yes' },
              { v: false, t: 'No' },
            ].map((o) => (
              <button
                key={o.t}
                type="button"
                aria-pressed={value === o.v}
                onClick={() => onChange(value === o.v ? null : o.v)}
                className={`min-h-[52px] rounded-xl border text-card font-semibold ${value === o.v ? 'border-teal bg-teal text-white' : 'border-line bg-surface text-ink'}`}
              >
                {o.t}
              </button>
            ))}
          </div>
          {error ? (
            <p className="text-meta font-medium text-error" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE': {
      const multi = q.type === 'MULTI_CHOICE';
      const selected = new Set(multi ? ((value as string[] | undefined) ?? []) : value ? [String(value)] : []);
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-body font-medium text-ink">{label}</legend>
          {q.helpText ? <p className="text-meta text-slate">{q.helpText}</p> : null}
          <div className="mt-1 flex flex-col gap-2">
            {(q.options ?? []).map((o) => (
              <label key={o.value} className={`flex min-h-[48px] items-center gap-3 rounded-xl border px-3 text-body ${selected.has(o.value) ? 'border-teal bg-teal/5' : 'border-line bg-surface'}`}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={id}
                  className="h-5 w-5 accent-teal"
                  checked={selected.has(o.value)}
                  onChange={() => {
                    if (!multi) return onChange(o.value);
                    const next = new Set(selected);
                    if (next.has(o.value)) next.delete(o.value);
                    else next.add(o.value);
                    onChange([...next]);
                  }}
                />
                {o.label}
              </label>
            ))}
          </div>
          {error ? (
            <p className="text-meta font-medium text-error" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    }
    case 'NUMBER':
      return (
        <Field label={label} hint={q.helpText} htmlFor={id} error={error}>
          <input id={id} type="number" inputMode="numeric" step={1} min={q.min} max={q.max} className={inputCls} value={(value as string | number | undefined) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    case 'TIME':
      return (
        <Field label={label} hint={q.helpText} htmlFor={id} error={error}>
          <input id={id} type="time" className={inputCls} value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    case 'LONG_TEXT':
      return (
        <Field label={label} hint={q.helpText} htmlFor={id} error={error}>
          <textarea id={id} className={`${inputCls} min-h-[96px] py-2`} maxLength={q.maxLength ?? 4000} value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={q.helpText} htmlFor={id} error={error}>
          <input id={id} className={inputCls} maxLength={q.maxLength ?? 200} value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
  }
}
