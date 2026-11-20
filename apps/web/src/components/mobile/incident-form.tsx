'use client';

/**
 * S17 incident intake on the phone (blueprint 7.3, 11.3; contract §20).
 * A factual record: category, time (defaults to now), station, a neutral
 * description, optional photos and an optional one-off location. The report
 * is saved encrypted on the phone with its idempotency key and uploads
 * through the queue; the reference appears once the server confirms it. The
 * original report is never edited afterwards: corrections are new events.
 */
import { INCIDENT_CATEGORIES, INCIDENT_CATEGORY_LABELS, type GeoPoint, type IncidentCategory } from '@ngao360/shared';
import { LocateFixed, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { geolocationAvailable, readLocationOnce } from '@/lib/offline/geo';
import { QueueValidationError } from '@/lib/offline/queue';
import { descriptionHints, fromLocalInputValue, incidentSummary, isTooFarInFuture, stationOptions, toLocalInputValue } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigButton, Field, inputCls, MobileGate, Notice, PageTitle, Spinner } from './mobile-ui';
import { PhotoPicker, type PickedPhoto } from './photo-picker';
import { useFieldMe } from './use-field-data';

const OTHER = '__other__';

export function IncidentForm() {
  const s = useMobileSession();
  const me = useFieldMe();
  const stations = useMemo(() => stationOptions(me.data?.assignments ?? []), [me.data]);
  const [station, setStation] = useState<string>('');
  const [otherCode, setOtherCode] = useState('');
  const [category, setCategory] = useState<IncidentCategory | ''>('');
  const [occurredAt, setOccurredAt] = useState(() => toLocalInputValue(new Date()));
  const [locationDescription, setLocationDescription] = useState('');
  const [description, setDescription] = useState('');
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedStation = station || stations[0]?.code || '';
  const code = selectedStation === OTHER ? otherCode.trim() : selectedStation;
  const hints = descriptionHints(description);

  const locate = async () => {
    setLocating(true);
    try {
      setPoint(await readLocationOnce());
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No location');
    } finally {
      setLocating(false);
    }
  };

  const submit = async () => {
    const e: Record<string, string> = {};
    const iso = fromLocalInputValue(occurredAt);
    if (!code) e.station = 'Choose the station';
    if (!category) e.category = 'Choose what kind of incident this is';
    if (!iso) e.occurredAt = 'Enter the date and time';
    else if (isTooFarInFuture(iso, new Date())) e.occurredAt = 'The time cannot be in the future';
    if (description.trim().length < 10) e.description = 'Describe what happened (at least 10 characters)';
    if (!ack) e.ack = 'Confirm the privacy note';
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length > 0 || !category || !iso) return;
    if (!me.data?.electionCycleId) {
      setFormError('No election cycle is set up for field operations. Contact your coordinator.');
      return;
    }
    setSaving(true);
    try {
      const label = stations.find((x) => x.code === code)?.label ?? code;
      await s.enqueue({
        kind: 'INCIDENT',
        summary: incidentSummary(category, label),
        payload: {
          electionCycleId: me.data.electionCycleId,
          category,
          occurredAt: iso,
          location: { pollingStationCode: code, geographicUnitId: null },
          locationDescription: locationDescription.trim() || null,
          description: description.trim(),
          point,
          privacyWarningAcknowledged: true,
        },
        attachments: photos.map((p) => ({ bytes: p.bytes, mimeType: p.mimeType })),
      });
      setSaved(s.online ? 'Saved and uploading. The reference appears in the upload queue once the server has it.' : 'Saved on this phone. It uploads when you are back online; then you get a reference.');
      setCategory('');
      setDescription('');
      setLocationDescription('');
      setPoint(null);
      setPhotos([]);
      setAck(false);
      setOccurredAt(toLocalInputValue(new Date()));
    } catch (err) {
      if (err instanceof QueueValidationError) {
        const map: Record<string, string> = {};
        for (const i of err.issues) map[String(i.path[0] ?? 'form')] = i.message;
        setErrors(map);
        setFormError(err.message);
      } else setFormError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <MobileGate anyOf={['field.incidents.report']}>
      <PageTitle sub="Record what you observed: facts, time and place. The incident desk reviews every report.">Report an incident</PageTitle>
      {me.loading && !me.data ? <Spinner /> : null}
      {saved ? (
        <div className="mb-4">
          <Notice tone="success" role="status" title="Incident saved">
            {saved}{' '}
            <Link href="/m/queue" className="font-semibold underline">
              Open the queue
            </Link>
          </Notice>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit();
        }}
      >
        <Field label="Station" htmlFor="inc-station" error={errors.station}>
          <select id="inc-station" className={inputCls} value={selectedStation} onChange={(e) => setStation(e.target.value)}>
            {stations.length === 0 ? <option value="">Choose…</option> : null}
            {stations.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
            <option value={OTHER}>Another station (enter the code)</option>
          </select>
          {selectedStation === OTHER ? (
            <input className={`${inputCls} mt-2`} inputMode="numeric" placeholder="Station code" value={otherCode} onChange={(e) => setOtherCode(e.target.value)} aria-label="Station code" />
          ) : null}
        </Field>

        <Field label="What kind of incident?" htmlFor="inc-category" error={errors.category}>
          <select id="inc-category" className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as IncidentCategory)}>
            <option value="">Choose…</option>
            {INCIDENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {INCIDENT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="When did it happen?" hint="Defaults to now. Change it if it happened earlier." htmlFor="inc-time" error={errors.occurredAt}>
          <input id="inc-time" type="datetime-local" className={inputCls} value={occurredAt} max={toLocalInputValue(new Date(Date.now() + 5 * 60_000))} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>

        <Field label="Where exactly? (optional)" hint="E.g. queue outside stream 2. No names." htmlFor="inc-where" error={errors.locationDescription}>
          <input id="inc-where" className={inputCls} maxLength={300} value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} />
        </Field>

        <Field label="What happened?" hint="What you saw or heard, in order. Facts, not conclusions." htmlFor="inc-desc" error={errors.description}>
          <textarea id="inc-desc" className={`${inputCls} min-h-[140px] py-2`} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          {hints.map((h) => (
            <p key={h} className="text-meta text-deep-blue">
              {h}
            </p>
          ))}
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-body font-medium text-ink">Photos</p>
          <PhotoPicker photos={photos} onChange={setPhotos} />
        </div>

        {geolocationAvailable() ? (
          <div className="flex flex-col gap-1">
            <p className="text-body font-medium text-ink">Your location (optional)</p>
            {point ? (
              <div className="flex items-center justify-between rounded-lg bg-cloud p-3 text-body">
                <span>Location attached{point.accuracyMetres ? ` (about ${point.accuracyMetres} m)` : ''}</span>
                <button type="button" className="min-h-[44px] px-2 font-semibold text-teal" onClick={() => setPoint(null)}>
                  Remove
                </button>
              </div>
            ) : (
              <BigButton tone="secondary" loading={locating} onClick={locate}>
                <LocateFixed className="h-5 w-5" aria-hidden /> Attach my current location once
              </BigButton>
            )}
            <p className="text-meta text-slate">Only if it helps locate the incident. It is read once, never tracked.</p>
          </div>
        ) : null}

        <div className="rounded-xl border border-gold/50 bg-gold/10 p-3">
          <p className="flex items-center gap-2 text-body font-semibold text-ink">
            <ShieldAlert className="h-5 w-5" aria-hidden /> Before you save
          </p>
          <ul className="mt-1 list-disc pl-5 text-body text-ink">
            <li>Describe what happened, not who is to blame.</li>
            <li>Do not name people or write phone or ID numbers. If someone must be identified, tell the incident desk.</li>
            <li>Do not photograph voters’ faces or marked ballots.</li>
          </ul>
          <label className="mt-2 flex min-h-[48px] items-center gap-3 text-body font-medium">
            <input type="checkbox" className="h-6 w-6 accent-teal" checked={ack} onChange={(e) => setAck(e.target.checked)} />I have read this and my report is factual
          </label>
          {errors.ack ? (
            <p className="text-meta font-medium text-error" role="alert">
              {errors.ack}
            </p>
          ) : null}
        </div>

        {formError ? (
          <Notice tone="error" role="alert">
            {formError}
          </Notice>
        ) : null}
        <BigButton type="submit" loading={saving} disabled={!s.queue}>
          {s.online ? 'Save and upload' : 'Save on this phone'}
        </BigButton>
      </form>
    </MobileGate>
  );
}
