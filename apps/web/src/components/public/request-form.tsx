'use client';

import { CONTACT_PREFERENCES, type ContactPreference, type PublicCaseReceipt } from '@ngao360/shared';
import { Camera, Send, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError } from '@/lib/api-client';
import { CaptchaSlot, captchaState } from './captcha';
import './captcha-widgets';
import { formatBytes } from './i18n';
import { photoType, checkPhoto, needsConversion, preparePhoto, type PreparedPhoto } from './photo';
import { portalApi, portalErrorKey, serverFieldErrors } from './portal-api';
import { usePortal } from './portal-context';
import {
  Checkbox,
  describedBy,
  ErrorSummary,
  Field,
  fieldIds,
  Honeypot,
  Message,
  PageTitle,
  Panel,
  PortalButton,
  RadioGroup,
  Select,
  TextArea,
  TextInput,
} from './portal-ui';
import { PrivacyNoticeView } from './privacy-notice';
import { Receipt } from './receipt';
import {
  draftKey,
  draftOf,
  EMPTY_REQUEST,
  FIELD_MESSAGE,
  type FieldErrors,
  isEmptyDraft,
  orderedErrors,
  parseDraft,
  type RequestField,
  type RequestFormState,
  validateRequest,
} from './request-model';

const DESCRIPTION_MAX = 4000;

/** S24 Citizen portal: report an issue without an account (API §13.2). */
export function RequestForm() {
  const { info, slug, t, reload } = usePortal();
  const [state, setState] = useState<RequestFormState>(EMPTY_REQUEST);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [noticeChanged, setNoticeChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<{ file: File; prepared: PreparedPhoto | null; previewUrl: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [receipt, setReceipt] = useState<PublicCaseReceipt | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  // Restore the issue part of a draft (never contact details).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const d = parseDraft(window.sessionStorage.getItem(draftKey(slug)));
      if (d) {
        setState((s) => ({ ...s, ...d }));
        setDraftRestored(true);
      }
    } catch {
      /* storage unavailable */
    }
  }, [slug]);

  useEffect(() => {
    if (receipt) return;
    try {
      const d = draftOf(state);
      if (isEmptyDraft(d)) window.sessionStorage.removeItem(draftKey(slug));
      else window.sessionStorage.setItem(draftKey(slug), JSON.stringify(d));
    } catch {
      /* ignore */
    }
  }, [state, slug, receipt]);

  // Release the preview URL when the page is left.
  const previewRef = useRef<string>('');
  previewRef.current = photo?.previewUrl ?? '';
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const wards = useMemo(() => (info ? info.wards.filter((w) => w.constituencyId === state.constituencyId) : []), [info, state.constituencyId]);

  if (!info) return null;
  if (receipt) {
    return (
      <Receipt
        receipt={receipt}
        onAnother={() => {
          setReceipt(null);
          setState(EMPTY_REQUEST);
          setErrors({});
        }}
      />
    );
  }

  const captcha = captchaState(info.captcha);
  const set = <K extends keyof RequestFormState>(key: K, value: RequestFormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    const field = (key === 'wardId' ? 'constituencyId' : key) as RequestField;
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };
  const err = (field: RequestField) => (errors[field] ? t(errors[field]!) : null);

  const choosePhoto = async (file: File | undefined) => {
    setPhotoError(null);
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    if (!file) return;
    const check = checkPhoto(file, info.maxPhotoBytes, info.acceptedPhotoTypes);
    if (!check.ok) {
      setPhotoError(check.reason === 'size' ? t('request.photo.tooLarge', { size: formatBytes(info.maxPhotoBytes) }) : t('request.photo.badType'));
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    const previewUrl = photoType(file) === 'image/heic' ? '' : URL.createObjectURL(file);
    setPhoto({ file, prepared: null, previewUrl });
    const prepared = await preparePhoto(file);
    if (needsConversion(file, prepared)) {
      setPhoto((p) => (p && p.file === file ? null : p));
      setPhotoError(t('request.photo.heicUnsupported'));
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setPhoto((p) => (p && p.file === file ? { ...p, prepared } : p));
  };

  const removePhoto = () => {
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    setPhotoError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const result = validateRequest(state, info.privacyNotice.version, { requireLocation: true });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (photoError) {
      setErrors({ photo: 'request.error.photo' });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const upload = photo ? (photo.prepared ?? { blob: photo.file, name: photo.file.name, processed: false }) : null;
      const r = await portalApi.submit(slug, result.payload, upload?.blob ?? null, upload?.name);
      try {
        window.sessionStorage.removeItem(draftKey(slug));
      } catch {
        /* ignore */
      }
      removePhoto();
      setState(EMPTY_REQUEST);
      setReceipt(r);
      window.scrollTo({ top: 0 });
    } catch (ex) {
      if (ex instanceof ApiRequestError && ex.code === 'CONFLICT') {
        // The privacy notice changed: show the new text and ask again.
        await reload();
        setState((s) => ({ ...s, privacyAcknowledged: false }));
        setNoticeChanged(true);
        setErrors({ privacyAcknowledged: 'request.error.privacy' });
      } else {
        const fieldErrs = serverFieldErrors(ex);
        const mapped: FieldErrors = {};
        const pathMap: Record<string, RequestField> = {
          category: 'category',
          description: 'description',
          geographicUnitId: 'constituencyId',
          locationDescription: 'landmark',
          phone: 'phone',
          email: 'email',
          name: 'name',
          consentToContact: 'consentToContact',
          photo: 'photo',
        };
        for (const k of Object.keys(fieldErrs)) {
          const f = pathMap[k];
          if (f) mapped[f] = FIELD_MESSAGE[f];
        }
        if (Object.keys(mapped).length) setErrors(mapped);
        setFormError(t(portalErrorKey(ex)));
      }
    } finally {
      setBusy(false);
    }
  };

  const summary = orderedErrors(errors).map((e) => ({ field: e.field, message: t(e.key) }));
  const wantsContact = state.contactPreference !== 'NONE';
  const ids = (name: string) => fieldIds(name);

  return (
    <>
      <PageTitle title={t('request.title')} intro={t('request.intro')} />
      <ErrorSummary errors={summary} title={t('common.errorSummary')} />
      {formError ? (
        <Message tone="error" className="mb-6">
          {formError}
        </Message>
      ) : null}
      {draftRestored ? (
        <Message tone="info" className="mb-6">
          {t('request.draftRestored')}{' '}
          <button
            type="button"
            className="font-semibold text-deep-blue underline"
            onClick={() => {
              setState(EMPTY_REQUEST);
              setDraftRestored(false);
            }}
          >
            {t('request.draftClear')}
          </button>
        </Message>
      ) : null}

      <form onSubmit={submit} noValidate className="relative space-y-5">
        <Honeypot name={info.honeypotField} value={state.website} onChange={(v) => set('website', v)} />

        <Panel title={t('request.step.what')} id="step-what">
          <Field name="category" label={t('request.category')} error={err('category')}>
            <Select
              id={ids('category').input}
              value={state.category}
              onChange={(e) => set('category', e.target.value)}
              aria-invalid={errors.category ? true : undefined}
              aria-describedby={describedBy('category', undefined, err('category'))}
            >
              <option value="">{t('request.category.placeholder')}</option>
              {info.categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field name="description" label={t('request.description')} hint={t('request.description.hint')} error={err('description')} className="mb-1">
            <TextArea
              id={ids('description').input}
              value={state.description}
              maxLength={DESCRIPTION_MAX}
              rows={6}
              onChange={(e) => set('description', e.target.value)}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={[describedBy('description', true, err('description')), 'description-count'].filter(Boolean).join(' ')}
            />
          </Field>
          <p id="description-count" className="text-meta text-slate" aria-live="polite">
            {t('request.description.count', { count: state.description.length, max: DESCRIPTION_MAX })}
          </p>
        </Panel>

        <Panel title={t('request.step.where')} id="step-where">
          <Field name="constituencyId" label={t('request.constituency')} error={err('constituencyId')}>
            <Select
              id={ids('constituencyId').input}
              value={state.constituencyId}
              onChange={(e) => {
                set('constituencyId', e.target.value);
                setState((s) => ({ ...s, wardId: '' }));
              }}
              aria-invalid={errors.constituencyId ? true : undefined}
              aria-describedby={describedBy('constituencyId', undefined, err('constituencyId'))}
            >
              <option value="">{t('request.constituency.placeholder')}</option>
              {info.constituencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field name="wardId" label={t('request.ward')} hint={t('request.ward.hint')} optional>
            <Select
              id={ids('wardId').input}
              value={state.wardId}
              disabled={!state.constituencyId}
              onChange={(e) => set('wardId', e.target.value)}
              aria-describedby={describedBy('wardId', true)}
            >
              <option value="">{t('request.ward.placeholder')}</option>
              {wards.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field name="landmark" label={t('request.landmark')} hint={t('request.landmark.hint')} error={err('landmark')} optional className="mb-0">
            <TextInput
              id={ids('landmark').input}
              value={state.landmark}
              maxLength={300}
              onChange={(e) => set('landmark', e.target.value)}
              aria-invalid={errors.landmark ? true : undefined}
              aria-describedby={describedBy('landmark', true, err('landmark'))}
            />
          </Field>
        </Panel>

        <Panel title={t('request.step.photo')} id="step-photo">
          <Field
            name="photo"
            label={t('request.photo')}
            hint={t('request.photo.hint', { size: formatBytes(info.maxPhotoBytes) })}
            error={photoError ?? err('photo')}
            optional
            className="mb-0"
          >
            {photo ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {photo.previewUrl ? (
                  <img src={photo.previewUrl} alt="" className="h-28 w-28 rounded-lg border border-line object-cover" />
                ) : null}
                <div className="space-y-2">
                  <p className="text-base text-ink">
                    {t('request.photo.selected', { name: photo.file.name, size: formatBytes(photo.prepared?.blob.size ?? photo.file.size) })}
                  </p>
                  {photo.prepared?.processed ? <p className="text-body text-slate">{t('request.photo.resized')}</p> : null}
                  <PortalButton type="button" variant="secondary" onClick={removePhoto}>
                    <Trash2 className="h-5 w-5" aria-hidden />
                    {t('request.photo.remove')}
                  </PortalButton>
                </div>
              </div>
            ) : (
              <label
                htmlFor={ids('photo').input}
                className="flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate/40 bg-cloud px-4 py-3 text-base font-medium text-deep-blue hover:border-teal focus-within:ring-2 focus-within:ring-teal/40"
              >
                <Camera className="h-5 w-5" aria-hidden />
                {t('request.photo')}
                <input
                  ref={fileRef}
                  id={ids('photo').input}
                  type="file"
                  accept={info.acceptedPhotoTypes.join(',')}
                  className="sr-only"
                  aria-describedby={describedBy('photo', true, photoError ?? err('photo'))}
                  onChange={(e) => void choosePhoto(e.target.files?.[0])}
                />
              </label>
            )}
          </Field>
        </Panel>

        <Panel title={t('request.step.contact')} id="step-contact">
          <RadioGroup<ContactPreference>
            name="contactPreference"
            legend={t('request.contact.legend')}
            hint={t('request.contact.hint')}
            value={state.contactPreference}
            onChange={(v) => set('contactPreference', v)}
            options={CONTACT_PREFERENCES.map((p) => ({ value: p, label: t(`request.contact.${p}`) }))}
          />
          {wantsContact ? (
            <div className="rounded-lg border border-line bg-cloud/60 p-3 sm:p-4">
              <Field name="name" label={t('request.name')} error={err('name')} optional>
                <TextInput
                  id={ids('name').input}
                  autoComplete="name"
                  value={state.name}
                  maxLength={200}
                  onChange={(e) => set('name', e.target.value)}
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={describedBy('name', undefined, err('name'))}
                />
              </Field>
              {state.contactPreference === 'PHONE' || state.contactPreference === 'SMS' ? (
                <Field name="phone" label={t('request.phone')} hint={t('request.phone.hint')} error={err('phone')}>
                  <TextInput
                    id={ids('phone').input}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={state.phone}
                    maxLength={20}
                    onChange={(e) => set('phone', e.target.value)}
                    aria-invalid={errors.phone ? true : undefined}
                    aria-describedby={describedBy('phone', true, err('phone'))}
                  />
                </Field>
              ) : null}
              {state.contactPreference === 'EMAIL' ? (
                <Field name="email" label={t('request.email')} error={err('email')}>
                  <TextInput
                    id={ids('email').input}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={state.email}
                    maxLength={200}
                    onChange={(e) => set('email', e.target.value)}
                    aria-invalid={errors.email ? true : undefined}
                    aria-describedby={describedBy('email', undefined, err('email'))}
                  />
                </Field>
              ) : null}
              <Checkbox name="consentToContact" label={t('request.consent')} checked={state.consentToContact} onChange={(v) => set('consentToContact', v)} error={err('consentToContact')} />
            </div>
          ) : null}
        </Panel>

        <Panel title={t('request.step.privacy')} id="step-privacy">
          {noticeChanged ? (
            <Message tone="warning" className="mb-4">
              {t('request.noticeChanged')}
            </Message>
          ) : null}
          <PrivacyNoticeView
            id="privacy-notice"
            notice={info.privacyNotice}
            headingLevel={3}
            versionLabel={t('request.privacy.version', { version: info.privacyNotice.version })}
            className="mb-5"
          />
          <Checkbox name="privacyAcknowledged" label={t('request.privacy.read')} checked={state.privacyAcknowledged} onChange={(v) => set('privacyAcknowledged', v)} error={err('privacyAcknowledged')} />
          <CaptchaSlot captcha={info.captcha} onToken={(token) => set('captchaToken', token)} />
          {captcha === 'unavailable' ? (
            <Message tone="warning" className="mb-5">
              {t('request.captchaUnavailable')}
            </Message>
          ) : null}
          <PortalButton type="submit" busy={busy} disabled={captcha === 'unavailable'} className="w-full sm:w-auto">
            <Send className="h-5 w-5" aria-hidden />
            {busy ? t('request.submitting') : t('request.submit')}
          </PortalButton>
        </Panel>
      </form>
    </>
  );
}
