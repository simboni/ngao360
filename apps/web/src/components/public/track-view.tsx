'use client';

import {
  CITIZEN_FEEDBACK_RESPONSES,
  type CitizenFeedbackResponse,
  PUBLIC_HONEYPOT_FIELD,
  type PublicCaseStage,
  type PublicCaseStatus,
  PublicTrackRequestSchema,
} from '@ngao360/shared';
import {
  Building2,
  CheckCircle2,
  Circle,
  CircleDot,
  Inbox,
  type LucideIcon,
  MessageSquareReply,
  RotateCcw,
  Search,
  Send,
  Share2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { captchaState, CaptchaSlot } from './captcha';
import { isNotFound, portalApi, portalErrorKey } from './portal-api';
import { usePortal } from './portal-context';
import { describedBy, ErrorSummary, Field, fieldIds, Honeypot, Message, PageTitle, Panel, PortalButton, RadioGroup, TextArea, TextInput } from './portal-ui';
import { normaliseReference, publicStageSteps } from './track-model';

const STAGE_ICON: Record<PublicCaseStage, LucideIcon> = {
  RECEIVED: Inbox,
  UNDER_REVIEW: Search,
  IN_PROGRESS: Wrench,
  REFERRED: Share2,
  RESOLUTION_PROPOSED: MessageSquareReply,
  CLOSED: CheckCircle2,
};

/**
 * Track a request with the public reference and the tracking code
 * (API §13.3). The code is kept in memory only and sent by POST, never in the
 * address bar. Only public updates are shown.
 */
export function TrackView() {
  const { info, slug, t } = usePortal();
  const params = useSearchParams();
  const [reference, setReference] = useState('');
  const [code, setCode] = useState('');
  const [website, setWebsite] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ reference?: string; code?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublicCaseStatus | null>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const ref = params?.get('ref');
    if (ref) setReference(normaliseReference(ref).slice(0, 32));
  }, [params]);

  useEffect(() => {
    if (status) resultRef.current?.focus();
  }, [status]);

  if (!info) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = PublicTrackRequestSchema.safeParse({
      publicReference: normaliseReference(reference),
      trackingCode: code.trim().toUpperCase(),
      [PUBLIC_HONEYPOT_FIELD]: website || undefined,
      captchaToken: captchaToken ?? undefined,
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const i of parsed.error.issues) {
        if (i.path[0] === 'publicReference') next.reference = t('track.reference.hint');
        if (i.path[0] === 'trackingCode') next.code = t('track.code.hint');
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      setStatus(await portalApi.track(slug, parsed.data));
    } catch (ex) {
      setFormError(isNotFound(ex) ? t('track.notFound') : t(portalErrorKey(ex)));
    } finally {
      setBusy(false);
    }
  };

  if (status) {
    return (
      <TrackResult
        status={status}
        credentials={{ publicReference: normaliseReference(reference), trackingCode: code.trim().toUpperCase() }}
        headingRef={resultRef}
        onUpdate={setStatus}
        onReset={() => {
          setStatus(null);
          setCode('');
        }}
      />
    );
  }

  const summary = [
    errors.reference ? { field: 'publicReference', message: `${t('track.reference')}: ${errors.reference}` } : null,
    errors.code ? { field: 'trackingCode', message: `${t('track.code')}: ${errors.code}` } : null,
  ].filter((x): x is { field: string; message: string } => x !== null);
  const captcha = captchaState(info.captcha);

  return (
    <>
      <PageTitle title={t('track.title')} intro={t('track.intro')} />
      <ErrorSummary errors={summary} title={t('common.errorSummary')} />
      {formError ? (
        <Message tone="error" className="mb-6">
          {formError}
        </Message>
      ) : null}
      <Panel>
        <form onSubmit={submit} noValidate className="relative">
          <Honeypot name={info.honeypotField} value={website} onChange={setWebsite} />
          <Field name="publicReference" label={t('track.reference')} hint={t('track.reference.hint')} error={errors.reference}>
            <TextInput
              id={fieldIds('publicReference').input}
              value={reference}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              className="font-mono uppercase tracking-wider"
              onChange={(e) => setReference(e.target.value)}
              aria-invalid={errors.reference ? true : undefined}
              aria-describedby={describedBy('publicReference', true, errors.reference)}
            />
          </Field>
          <Field name="trackingCode" label={t('track.code')} hint={t('track.code.hint')} error={errors.code}>
            <TextInput
              id={fieldIds('trackingCode').input}
              value={code}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={16}
              className="font-mono uppercase tracking-wider"
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={describedBy('trackingCode', true, errors.code)}
            />
          </Field>
          <CaptchaSlot captcha={info.captcha} onToken={setCaptchaToken} />
          {captcha === 'unavailable' ? (
            <Message tone="warning" className="mb-5">
              {t('request.captchaUnavailable')}
            </Message>
          ) : null}
          <PortalButton type="submit" busy={busy} disabled={captcha === 'unavailable'} className="w-full sm:w-auto">
            <Search className="h-5 w-5" aria-hidden />
            {t('track.submit')}
          </PortalButton>
        </form>
      </Panel>
    </>
  );
}

function TrackResult({
  status,
  credentials,
  headingRef,
  onUpdate,
  onReset,
}: {
  status: PublicCaseStatus;
  credentials: { publicReference: string; trackingCode: string };
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onUpdate: (s: PublicCaseStatus) => void;
  onReset: () => void;
}) {
  const { t } = usePortal();
  const steps = publicStageSteps(status.stage);
  const StageIcon = STAGE_ICON[status.stage];

  return (
    <div className="space-y-5">
      <div>
        <h1 ref={headingRef} tabIndex={-1} className="text-[24px] font-semibold leading-8 text-navy focus:outline-none sm:text-page">
          {t('track.title')}
        </h1>
        <p className="mt-1 font-mono text-base font-semibold tracking-wider text-slate">{status.publicReference}</p>
      </div>

      <Panel>
        <p className="text-body font-medium text-slate">{t('track.stage')}</p>
        <p className="mt-1 flex items-center gap-2 text-section font-semibold text-navy">
          <StageIcon className="h-6 w-6 shrink-0 text-teal" aria-hidden />
          {status.stageLabel || t(`stage.${status.stage}`)}
        </p>
        <ol className="mt-4 space-y-2" aria-label={t('track.stage')}>
          {steps.map((s) => {
            const Icon = s.state === 'done' ? CheckCircle2 : s.state === 'current' ? CircleDot : Circle;
            return (
              <li
                key={s.stage}
                aria-current={s.state === 'current' ? 'step' : undefined}
                className={cn('flex items-center gap-2 text-base', s.state === 'upcoming' ? 'text-slate' : 'text-ink', s.state === 'current' && 'font-semibold')}
              >
                <Icon className={cn('h-5 w-5 shrink-0', s.state === 'done' ? 'text-success' : s.state === 'current' ? 'text-teal' : 'text-slate/60')} aria-hidden />
                <span>{t(`stage.${s.stage}`)}</span>
                <span className="sr-only">({s.state === 'done' ? 'done' : s.state === 'current' ? 'current stage' : 'not reached yet'})</span>
              </li>
            );
          })}
        </ol>
        <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-base sm:grid-cols-2">
          <div>
            <dt className="text-body text-slate">{t('track.category')}</dt>
            <dd className="text-ink">{status.categoryLabel}</dd>
          </div>
          {status.locationName ? (
            <div>
              <dt className="text-body text-slate">{t('track.location')}</dt>
              <dd className="text-ink">{status.locationName}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-body text-slate">{t('track.submittedAt')}</dt>
            <dd className="text-ink">{formatDateTime(status.submittedAt)}</dd>
          </div>
          <div>
            <dt className="text-body text-slate">{t('track.updatedAt')}</dt>
            <dd className="text-ink">{formatDateTime(status.lastUpdatedAt)}</dd>
          </div>
        </dl>
      </Panel>

      {status.referredTo.length ? (
        <Panel title={t('track.referredTo')} id="referred">
          <ul className="space-y-2">
            {status.referredTo.map((name) => (
              <li key={name} className="flex items-center gap-2 text-base text-ink">
                <Building2 className="h-5 w-5 shrink-0 text-deep-blue" aria-hidden />
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-body text-slate">{t('track.referred.note')}</p>
        </Panel>
      ) : null}

      <Panel title={t('track.updates')} id="updates">
        {status.updates.length === 0 ? (
          <p className="text-base text-slate">{t('track.updates.none')}</p>
        ) : (
          <ol className="relative space-y-4 border-l-2 border-line pl-5">
            {[...status.updates].reverse().map((u, i) => (
              <li key={`${u.at}-${i}`} className="relative">
                <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-surface bg-teal" aria-hidden />
                <p className="text-body text-slate">
                  <time dateTime={u.at}>{formatDateTime(u.at)}</time>
                </p>
                <p className="mt-0.5 whitespace-pre-line text-base text-ink">{u.message}</p>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-4 text-body text-slate">{t('track.privacy')}</p>
      </Panel>

      {status.feedbackAllowed ? <FeedbackForm credentials={credentials} onUpdate={onUpdate} /> : null}

      <PortalButton type="button" variant="secondary" onClick={onReset}>
        <RotateCcw className="h-5 w-5" aria-hidden />
        {t('track.another')}
      </PortalButton>
    </div>
  );
}

function FeedbackForm({ credentials, onUpdate }: { credentials: { publicReference: string; trackingCode: string }; onUpdate: (s: PublicCaseStatus) => void }) {
  const { info, slug, t } = usePortal();
  const [response, setResponse] = useState<CitizenFeedbackResponse>('CONFIRM_RESOLVED');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'sent' | 'closed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!info) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await portalApi.feedback(slug, {
        ...credentials,
        response,
        message: message.trim() || undefined,
        [PUBLIC_HONEYPOT_FIELD]: website || undefined,
        captchaToken: captchaToken ?? undefined,
      });
      setDone('sent');
      onUpdate(next);
    } catch (ex) {
      if (ex instanceof ApiRequestError && ex.code === 'CONFLICT') setDone('closed');
      else setError(t(portalErrorKey(ex)));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Message tone={done === 'sent' ? 'success' : 'info'}>{done === 'sent' ? t('track.feedback.thanks') : t('track.feedback.closed')}</Message>
    );
  }

  return (
    <Panel title={t('track.feedback.title')} id="feedback">
      <p className="mb-4 text-base text-slate">{t('track.feedback.body')}</p>
      {error ? (
        <Message tone="error" className="mb-4">
          {error}
        </Message>
      ) : null}
      <form onSubmit={submit} noValidate className="relative">
        <Honeypot name={`${info.honeypotField}-fb`} value={website} onChange={setWebsite} />
        <RadioGroup<CitizenFeedbackResponse>
          name="feedbackResponse"
          legend={t('track.feedback.legend')}
          value={response}
          onChange={setResponse}
          options={CITIZEN_FEEDBACK_RESPONSES.map((r) => ({
            value: r,
            label: (
              <span className="inline-flex items-center gap-2">
                {r === 'CONFIRM_RESOLVED' ? (
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                ) : r === 'DISPUTE' ? (
                  <XCircle className="h-4 w-4 text-error" aria-hidden />
                ) : (
                  <MessageSquareReply className="h-4 w-4 text-deep-blue" aria-hidden />
                )}
                {t(`track.feedback.${r}`)}
              </span>
            ),
          }))}
        />
        <Field name="feedbackMessage" label={t('track.feedback.message')} optional>
          <TextArea id={fieldIds('feedbackMessage').input} value={message} maxLength={2000} rows={4} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <CaptchaSlot captcha={info.captcha} onToken={setCaptchaToken} />
        <PortalButton type="submit" busy={busy} className="w-full sm:w-auto">
          <Send className="h-5 w-5" aria-hidden />
          {t('track.feedback.submit')}
        </PortalButton>
      </form>
    </Panel>
  );
}
