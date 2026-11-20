'use client';

import {
  ATTENDANCE_ROLE_LABELS,
  ATTENDANCE_ROLES,
  type AttendanceRole,
  CAMPAIGN_EVENT_TYPE_LABELS,
  CAMPAIGN_EVENT_TYPES,
  CAMPAIGN_EVENT_VISIBILITIES,
  CAMPAIGN_EVENT_VISIBILITY_LABELS,
  type CampaignEventDetail,
  type CampaignEventStatus,
  type CampaignEventType,
  type CampaignEventVisibility,
  CHECK_IN_METHOD_LABELS,
  CHECK_IN_METHODS,
  type CheckInMethod,
  type CreateCampaignEvent,
  DEFAULT_CURRENCY,
  EVENT_DOCUMENT_KINDS,
  type EventAfterActionReport,
  type EventAttendance,
  type EventAttendanceContact,
  type EventDocumentKind,
  type EventLogisticsItem,
  formatMoney,
  LOGISTICS_ITEM_TYPE_LABELS,
  LOGISTICS_ITEM_TYPES,
  type LogisticsItemType,
  type LogisticsStatus,
  parseMajorToMinor,
  type RecordAttendance,
  type SaveAfterActionReport,
  type TeamSummary,
  type UpdateCampaignEvent,
} from '@ngao360/shared';
import { Download, Eye, Paperclip, Save, Send, ShieldCheck, UserCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, isoToLocalInput, localInputToIso, textareaClass } from '@/components/office/correspondence/office-common';
import {
  CAMPAIGN_FILE_ACCEPT,
  departmentOptionLabel,
  describeCampaignError,
  EventStatusBadge,
  LogisticsStatusBadge,
  uploadCampaignFile,
  useAssignableUsers,
  useDepartmentOptions,
} from '@/components/org/campaign-common';
import { orgApi } from '@/components/org/org-api';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { EVENT_MOVE_LABELS, eventMoveNeedsReason, LOGISTICS_MOVE_LABELS, logisticsNeedsNotes } from './event-model';
import { eventsApi } from './events-api';

function Actions({ busy, disabled, onCancel, children, danger }: { busy: boolean; disabled?: boolean; onCancel: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy} disabled={disabled}>
        {children}
      </Button>
    </div>
  );
}

function Err({ error }: { error: string | null }) {
  return error ? (
    <Notice tone="error" className="mb-4">
      {error}
    </Notice>
  ) : null;
}

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

/** Money typed in major units ("12,500.50") → minor units; '' → null; invalid → undefined. */
export function moneyInput(value: string, currency = DEFAULT_CURRENCY): number | null | undefined {
  if (!value.trim()) return null;
  return parseMajorToMinor(value, currency) ?? undefined;
}

export function minorToInput(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) return '';
  return formatMoney(amountMinor, DEFAULT_CURRENCY).replace(`${DEFAULT_CURRENCY} `, '').replace(/,/g, '');
}

/* ------------------------------ Create / edit ------------------------------ */

function useVisibleTeams(): TeamSummary[] {
  const { can } = useAuth();
  const allowed = can('org.teams.view');
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    orgApi
      .teams({ status: 'ACTIVE', pageSize: 200 })
      .then((p) => alive && setTeams(p.items))
      .catch(() => alive && setTeams([]));
    return () => {
      alive = false;
    };
  }, [allowed]);
  return teams;
}

export function EventFormDialog({ open, onClose, event, onSaved }: { open: boolean; onClose: () => void; event: CampaignEventDetail | null; onSaved: (e: CampaignEventDetail) => void }) {
  const { me } = useAuth();
  const departments = useDepartmentOptions();
  const teams = useVisibleTeams();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<CampaignEventType>('MEETING');
  const [purpose, setPurpose] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [venueName, setVenueName] = useState('');
  const [venueAddress, setVenueAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [organiserId, setOrganiserId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [budget, setBudget] = useState('');
  const [invited, setInvited] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<CampaignEventVisibility>('INTERNAL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const users = useAssignableUsers(departmentId ? { departmentId } : {}, [event?.organiser]);

  useEffect(() => {
    if (!open) return;
    setTitle(event?.title ?? '');
    setType(event?.type ?? 'MEETING');
    setPurpose(event?.purpose ?? '');
    setStartsAt(isoToLocalInput(event?.startsAt));
    setEndsAt(isoToLocalInput(event?.endsAt));
    setVenueName(event?.venueName ?? '');
    setVenueAddress(event?.venueAddress ?? '');
    setLat(event?.latitude?.toString() ?? '');
    setLng(event?.longitude?.toString() ?? '');
    setOrganiserId(event?.organiser.id ?? me?.user.id ?? '');
    setDepartmentId(event?.department?.id ?? '');
    setBudget(minorToInput(event?.budget?.amountMinor));
    setInvited(event?.invitedTeams.map((t) => t.id) ?? []);
    setVisibility(event?.visibility ?? 'INTERNAL');
    setError(null);
  }, [open, event, me]);

  const budgetMinor = moneyInput(budget);
  const latN = lat.trim() ? Number(lat) : null;
  const lngN = lng.trim() ? Number(lng) : null;
  const coordsBad = (latN === null) !== (lngN === null) || (latN !== null && (Number.isNaN(latN) || Math.abs(latN) > 90)) || (lngN !== null && (Number.isNaN(lngN) || Math.abs(lngN) > 180));
  const timesBad = !!startsAt && !!endsAt && startsAt > endsAt;
  const invalid = title.trim().length < 3 || !startsAt || !endsAt || timesBad || coordsBad || budgetMinor === undefined || !organiserId;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fields: CreateCampaignEvent = {
        title: title.trim(),
        type,
        purpose: purpose.trim() || null,
        startsAt: localInputToIso(startsAt)!,
        endsAt: localInputToIso(endsAt)!,
        venueName: venueName.trim() || null,
        venueAddress: venueAddress.trim() || null,
        latitude: latN,
        longitude: lngN,
        organiserId,
        departmentId: departmentId || null,
        budgetMinor: budgetMinor ?? null,
        currency: DEFAULT_CURRENCY,
        invitedTeamIds: invited,
        visibility,
      };
      if (event) {
        const body: UpdateCampaignEvent = { ...fields, expectedVersion: event.version };
        onSaved(await eventsApi.update(event.id, body));
      } else {
        onSaved(await eventsApi.create(fields));
      }
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title={event ? `Edit ${event.reference}` : 'New event'} description="Times are Africa/Nairobi. Events start as drafts; invited team coordinators are notified once the event is planned.">
      <form onSubmit={submit}>
        <FormField id="ev-title" label="Title" required>
          <input id="ev-title" className="ngao-input" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ev-type" label="Type" required>
            <select id="ev-type" className="ngao-input" value={type} onChange={(e) => setType(e.target.value as CampaignEventType)}>
              {CAMPAIGN_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CAMPAIGN_EVENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ev-vis" label="Visibility" required>
            <select id="ev-vis" className="ngao-input" value={visibility} onChange={(e) => setVisibility(e.target.value as CampaignEventVisibility)}>
              {CAMPAIGN_EVENT_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {CAMPAIGN_EVENT_VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ev-start" label="Starts" required>
            <input id="ev-start" type="datetime-local" className="ngao-input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
          </FormField>
          <FormField id="ev-end" label="Ends" required error={timesBad ? 'The end must be after the start.' : null}>
            <input id="ev-end" type="datetime-local" className="ngao-input" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
          </FormField>
        </div>
        <FormField id="ev-purpose" label="Purpose">
          <textarea id="ev-purpose" className={textareaClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={2000} />
        </FormField>
        <fieldset className="mb-4 rounded-lg border border-line p-3">
          <legend className="px-1 text-meta font-semibold text-slate">Venue</legend>
          <FormField id="ev-venue" label="Venue name">
            <input id="ev-venue" className="ngao-input" value={venueName} onChange={(e) => setVenueName(e.target.value)} maxLength={200} />
          </FormField>
          <FormField id="ev-address" label="Address">
            <input id="ev-address" className="ngao-input" value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} maxLength={500} />
          </FormField>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="ev-lat" label="Latitude" hint="Decimal degrees, e.g. 0.5636" error={coordsBad ? 'Give both latitude and longitude as valid decimal degrees, or neither.' : null}>
              <input id="ev-lat" inputMode="decimal" className="ngao-input" value={lat} onChange={(e) => setLat(e.target.value)} />
            </FormField>
            <FormField id="ev-lng" label="Longitude" hint="e.g. 34.5606">
              <input id="ev-lng" inputMode="decimal" className="ngao-input" value={lng} onChange={(e) => setLng(e.target.value)} />
            </FormField>
          </div>
          <p className="text-meta text-slate">Coordinates locate the venue only, never a person.</p>
        </fieldset>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ev-organiser" label="Organiser" required>
            <select id="ev-organiser" className="ngao-input" value={organiserId} onChange={(e) => setOrganiserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ev-dept" label="Department">
            <select id="ev-dept" className="ngao-input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Organisation-level</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentOptionLabel(d)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ev-budget" label={`Planned budget (${DEFAULT_CURRENCY})`} hint="Whole shillings or with cents, e.g. 45000 or 45,000.50" error={budgetMinor === undefined ? 'Enter an amount like 45000 or 45,000.50.' : null}>
            <input id="ev-budget" inputMode="decimal" className="ngao-input" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </FormField>
        </div>
        <FormField id="ev-teams" label="Invited teams">
          <fieldset id="ev-teams" className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            <legend className="sr-only">Invited teams</legend>
            {teams.length === 0 ? <p className="text-meta text-slate">No teams you can invite.</p> : null}
            {teams.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-body">
                <input type="checkbox" checked={invited.includes(t.id)} onChange={(e) => setInvited((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} />
                {t.name} <span className="text-meta text-slate">({t.department.code})</span>
              </label>
            ))}
          </fieldset>
        </FormField>
        <Err error={error} />
        <Actions busy={busy} disabled={invalid} onCancel={onClose}>
          <Save className="h-4 w-4" aria-hidden />
          {event ? 'Save event' : 'Create event'}
        </Actions>
      </form>
    </Dialog>
  );
}

/* ---------------------------------- Status --------------------------------- */

export function EventStatusDialog({ to, onClose, event, onSaved }: { to: CampaignEventStatus | null; onClose: () => void; event: CampaignEventDetail; onSaved: (e: CampaignEventDetail) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [to]);
  if (!to) return null;
  const needs = eventMoveNeedsReason(to);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await eventsApi.status(event.id, { toStatus: to, reason: reason.trim() || undefined, expectedVersion: event.version }));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`${EVENT_MOVE_LABELS[to]}?`}
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          From <EventStatusBadge status={event.status} size="sm" /> to <EventStatusBadge status={to} size="sm" />
        </span>
      }
    >
      <form onSubmit={submit}>
        {to === 'PLANNED' && event.invitedTeams.length ? <p className="mb-3 text-body text-slate">Coordinators of the {event.invitedTeams.length} invited teams will be notified in the app.</p> : null}
        <FormField id="es-reason" label={needs ? 'Reason' : 'Note'} required={needs}>
          <textarea id="es-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </FormField>
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={needs && reason.trim().length < 3} danger={to === 'CANCELLED'}>
          {EVENT_MOVE_LABELS[to]}
        </Actions>
      </form>
    </Dialog>
  );
}

/* --------------------------------- Logistics -------------------------------- */

export function LogisticsDialog({ open, onClose, event, onSaved }: { open: boolean; onClose: () => void; event: CampaignEventDetail; onSaved: () => void }) {
  const users = useAssignableUsers();
  const [itemType, setItemType] = useState<LogisticsItemType>('EQUIPMENT');
  const [description, setDescription] = useState('');
  const [assetReference, setAssetReference] = useState('');
  const [supplier, setSupplier] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [custodian, setCustodian] = useState('');
  const [collectionAt, setCollectionAt] = useState('');
  const [returnDueAt, setReturnDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setItemType('EQUIPMENT');
    setDescription('');
    setAssetReference('');
    setSupplier('');
    setQuantity('1');
    setCustodian('');
    setCollectionAt('');
    setReturnDueAt('');
    setError(null);
  }, [open]);
  const qty = Number(quantity);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await eventsApi.addLogistics(event.id, {
        itemType,
        description: description.trim(),
        assetReference: assetReference.trim() || null,
        supplierName: supplier.trim() || null,
        quantity: qty,
        custodianId: custodian || null,
        collectionAt: localInputToIso(collectionAt) ?? null,
        returnDueAt: localInputToIso(returnDueAt) ?? null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a logistics item" description="Vehicles, equipment and services with a named custodian. Supplier payments stay in finance.">
      <form onSubmit={submit}>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="lg-type" label="Type" required>
            <select id="lg-type" className="ngao-input" value={itemType} onChange={(e) => setItemType(e.target.value as LogisticsItemType)}>
              {LOGISTICS_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LOGISTICS_ITEM_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="lg-qty" label="Quantity" required>
            <input id="lg-qty" type="number" min={1} max={100000} className="ngao-input" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </FormField>
        </div>
        <FormField id="lg-desc" label="Description" required>
          <input id="lg-desc" className="ngao-input" value={description} onChange={(e) => setDescription(e.target.value)} minLength={2} maxLength={300} required />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="lg-asset" label="Asset tag or registration">
            <input id="lg-asset" className="ngao-input" value={assetReference} onChange={(e) => setAssetReference(e.target.value)} maxLength={80} />
          </FormField>
          <FormField id="lg-supplier" label="Supplier">
            <input id="lg-supplier" className="ngao-input" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={200} />
          </FormField>
          <FormField id="lg-custodian" label="Custodian">
            <select id="lg-custodian" className="ngao-input" value={custodian} onChange={(e) => setCustodian(e.target.value)}>
              <option value="">Not assigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </FormField>
          <span />
          <FormField id="lg-collect" label="Collection">
            <input id="lg-collect" type="datetime-local" className="ngao-input" value={collectionAt} onChange={(e) => setCollectionAt(e.target.value)} />
          </FormField>
          <FormField id="lg-return" label="Return due">
            <input id="lg-return" type="datetime-local" className="ngao-input" value={returnDueAt} onChange={(e) => setReturnDueAt(e.target.value)} />
          </FormField>
        </div>
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={description.trim().length < 2 || !Number.isInteger(qty) || qty < 1}>
          <Save className="h-4 w-4" aria-hidden />
          Add item
        </Actions>
      </form>
    </Dialog>
  );
}

export function LogisticsStatusDialog({
  item,
  to,
  onClose,
  event,
  onSaved,
}: {
  item: EventLogisticsItem | null;
  to: LogisticsStatus | null;
  onClose: () => void;
  event: CampaignEventDetail;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNotes('');
    setError(null);
  }, [item, to]);
  if (!item || !to) return null;
  const needs = logisticsNeedsNotes(to);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await eventsApi.updateLogistics(event.id, item.id, {
        status: to,
        expectedVersion: item.version,
        ...(needs ? { damageNotes: notes.trim() } : {}),
        ...(to === 'RETURNED' ? { returnedAt: new Date().toISOString() } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`${LOGISTICS_MOVE_LABELS[to]}: ${item.description}`}
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          From <LogisticsStatusBadge status={item.status} size="sm" /> to <LogisticsStatusBadge status={to} size="sm" />
        </span>
      }
    >
      <form onSubmit={submit}>
        {needs ? (
          <FormField id="lg-notes" label={to === 'LOST' ? 'What happened' : 'Describe the damage'} required>
            <textarea id="lg-notes" className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </FormField>
        ) : (
          <p className="mb-4 text-body text-slate">The change is recorded in the audit log.</p>
        )}
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={needs && notes.trim().length < 3} danger={needs}>
          {LOGISTICS_MOVE_LABELS[to]}
        </Actions>
      </form>
    </Dialog>
  );
}

/* -------------------------------- Attendance -------------------------------- */

export const ATTENDANCE_NOTICE_VERSION = 'event-attendance-v1';

export function CheckInDialog({ open, onClose, event, onSaved }: { open: boolean; onClose: () => void; event: CampaignEventDetail; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AttendanceRole>('PARTICIPANT');
  const [method, setMethod] = useState<CheckInMethod>('MANUAL');
  const [teamId, setTeamId] = useState('');
  const [withContact, setWithContact] = useState(false);
  const [consent, setConsent] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [purpose, setPurpose] = useState('Follow-up about this event only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<EventAttendance | null>(null);
  useEffect(() => {
    if (!open) return;
    setLast(null);
    setError(null);
  }, [open]);
  const reset = () => {
    setName('');
    setRole('PARTICIPANT');
    setTeamId('');
    setWithContact(false);
    setConsent(false);
    setPhone('');
    setEmail('');
  };
  const contactBad = withContact && (!consent || (!phone.trim() && !email.trim()) || purpose.trim().length < 3);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: RecordAttendance = {
        participantName: name.trim(),
        role,
        checkInMethod: method,
        teamId: teamId || null,
        contact: withContact
          ? { phone: phone.trim() || null, email: email.trim() || null, consent: true, consentNoticeVersion: ATTENDANCE_NOTICE_VERSION, purpose: purpose.trim() }
          : null,
      };
      setLast(await eventsApi.recordAttendance(event.id, body));
      reset();
      onSaved();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Check in attendees" description="Record names, roles and check-in method. Contact details are optional and only with the person's consent.">
      <form onSubmit={submit}>
        {last ? (
          <Notice tone="success" className="mb-4">
            {last.participantName} checked in. Add the next person or close.
          </Notice>
        ) : null}
        <FormField id="ci-name" label="Name" required>
          <input id="ci-name" className="ngao-input" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={160} required autoComplete="off" />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="ci-role" label="Role" required>
            <select id="ci-role" className="ngao-input" value={role} onChange={(e) => setRole(e.target.value as AttendanceRole)}>
              {ATTENDANCE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ATTENDANCE_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ci-method" label="Check-in method" required>
            <select id="ci-method" className="ngao-input" value={method} onChange={(e) => setMethod(e.target.value as CheckInMethod)}>
              {CHECK_IN_METHODS.map((m) => (
                <option key={m} value={m}>
                  {CHECK_IN_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </FormField>
          {event.invitedTeams.length ? (
            <FormField id="ci-team" label="Team">
              <select id="ci-team" className="ngao-input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">Not in an invited team</option>
                {event.invitedTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
        </div>
        <label className="mb-3 flex items-center gap-2 text-body">
          <input type="checkbox" checked={withContact} onChange={(e) => setWithContact(e.target.checked)} />
          The person wants to leave contact details
        </label>
        {withContact ? (
          <fieldset className="mb-4 rounded-lg border border-line p-3">
            <legend className="px-1 text-meta font-semibold text-slate">Consent-based contact</legend>
            <p className="mb-3 text-meta text-slate">
              Stored separately, visible only to authorised staff after an audited reveal, never used for outreach lists, bulk messages or targeting. Read the notice ({ATTENDANCE_NOTICE_VERSION}) to the person
              first.
            </p>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField id="ci-phone" label="Phone">
                <input id="ci-phone" type="tel" className="ngao-input" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
              </FormField>
              <FormField id="ci-email" label="Email">
                <input id="ci-email" type="email" className="ngao-input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </FormField>
            </div>
            <FormField id="ci-purpose" label="Purpose the person agreed to" required>
              <input id="ci-purpose" className="ngao-input" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />
            </FormField>
            <label className="flex items-start gap-2 text-body">
              <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              The person was read the notice and agreed to their details being kept for this purpose.
            </label>
          </fieldset>
        ) : null}
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={name.trim().length < 2 || contactBad}>
          <UserCheck className="h-4 w-4" aria-hidden />
          Check in
        </Actions>
      </form>
    </Dialog>
  );
}

/** Audited, re-authenticated reveal of consent-based contact details. */
export function RevealContactDialog({ row, onClose, event }: { row: EventAttendance | null; onClose: () => void; event: CampaignEventDetail }) {
  const highRisk = useHighRisk();
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState<EventAttendanceContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setContact(null);
    setError(null);
  }, [row]);
  if (!row) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setContact(await highRisk(() => eventsApi.revealContact(event.id, row.id, reason.trim())));
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`Contact details: ${row.participantName}`} description="Viewing contact details is recorded in the audit log with your reason. Use them only for the purpose the person agreed to.">
      {contact ? (
        <div className="space-y-3">
          <dl className="space-y-2 text-body">
            <div>
              <dt className="text-meta text-slate">Phone</dt>
              <dd>{contact.phone ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-meta text-slate">Email</dt>
              <dd>{contact.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-meta text-slate">Agreed purpose</dt>
              <dd>{contact.purpose}</dd>
            </div>
            <div>
              <dt className="text-meta text-slate">Consent</dt>
              <dd>
                Notice {contact.consentNoticeVersion}, {new Date(contact.consentedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}
              </dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <FormField id="rv-reason" label="Reason" required hint="At least 3 characters. Recorded in the audit log.">
            <textarea id="rv-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </FormField>
          <Err error={error} />
          <Actions busy={busy} onCancel={onClose} disabled={reason.trim().length < 3}>
            <Eye className="h-4 w-4" aria-hidden />
            Show contact details
          </Actions>
        </form>
      )}
    </Dialog>
  );
}

/** Attendance export (names, roles, methods and times only), re-authenticated and audited. */
export function ExportAttendanceDialog({ open, onClose, event }: { open: boolean; onClose: () => void; event: CampaignEventDetail }) {
  const highRisk = useHighRisk();
  const [format, setFormat] = useState<'CSV' | 'PDF'>('CSV');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await highRisk(() => eventsApi.exportAttendance(event.id, format, reason.trim()));
      window.open(res.url, '_blank', 'noopener,noreferrer');
      onClose();
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Export attendance" description="The file lists names, roles, check-in methods and times only (no contact details), with the generation time and classification Internal. Exports are logged.">
      <form onSubmit={submit}>
        <FormField id="ex-format" label="Format" required>
          <select id="ex-format" className="ngao-input" value={format} onChange={(e) => setFormat(e.target.value as 'CSV' | 'PDF')}>
            <option value="CSV">CSV</option>
            <option value="PDF">PDF</option>
          </select>
        </FormField>
        <FormField id="ex-reason" label="Reason" required>
          <textarea id="ex-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </FormField>
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={reason.trim().length < 3}>
          <Download className="h-4 w-4" aria-hidden />
          Export
        </Actions>
      </form>
    </Dialog>
  );
}

/* --------------------------------- Documents -------------------------------- */

const DOC_KIND_LABELS: Record<EventDocumentKind, string> = {
  AGENDA: 'Agenda',
  PERMIT: 'Permit',
  BRIEFING: 'Briefing',
  PHOTO: 'Photo',
  AFTER_ACTION_EVIDENCE: 'After-action evidence',
  OTHER: 'Other',
};
export { DOC_KIND_LABELS };

export function AddDocumentDialog({ open, onClose, event, onSaved }: { open: boolean; onClose: () => void; event: CampaignEventDetail; onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<EventDocumentKind>('BRIEFING');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setFile(null);
      setNote('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await uploadCampaignFile('/events/files', file);
      await eventsApi.addDocument(event.id, { fileId: stored.id, kind, note: note.trim() || undefined });
      onSaved();
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Add a document" description="Images or PDF up to 25 MB. Documents are kept unchanged and cannot be removed.">
      <form onSubmit={submit}>
        <FormField id="ed-file" label="File" required>
          <input id="ed-file" type="file" accept={CAMPAIGN_FILE_ACCEPT} className="block w-full text-body" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </FormField>
        <FormField id="ed-kind" label="Kind" required>
          <select id="ed-kind" className="ngao-input" value={kind} onChange={(e) => setKind(e.target.value as EventDocumentKind)}>
            {EVENT_DOCUMENT_KINDS.filter((k) => k !== 'AFTER_ACTION_EVIDENCE').map((k) => (
              <option key={k} value={k}>
                {DOC_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="ed-note" label="Note">
          <input id="ed-note" className="ngao-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </FormField>
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={!file || (file?.size ?? 0) > 25 * 1024 * 1024}>
          <Paperclip className="h-4 w-4" aria-hidden />
          Upload
        </Actions>
      </form>
    </Dialog>
  );
}

/* ------------------------------- After-action ------------------------------- */

export function AfterActionDialog({
  open,
  onClose,
  event,
  report,
  defaultTotal,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  event: CampaignEventDetail;
  report: EventAfterActionReport | null;
  defaultTotal: number;
  onSaved: (r: EventAfterActionReport) => void;
}) {
  const [whatOccurred, setWhatOccurred] = useState('');
  const [total, setTotal] = useState('0');
  const [breakdown, setBreakdown] = useState<Partial<Record<AttendanceRole, string>>>({});
  const [spend, setSpend] = useState('');
  const [issues, setIssues] = useState('');
  const [lessons, setLessons] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setWhatOccurred(report?.whatOccurred ?? '');
    setTotal(String(report?.attendanceTotal ?? defaultTotal));
    setBreakdown(Object.fromEntries(Object.entries(report?.attendanceBreakdown ?? {}).map(([k, v]) => [k, String(v)])));
    setSpend(minorToInput(report?.actualSpend?.amountMinor));
    setIssues(report?.issues ?? '');
    setLessons(report?.lessons ?? '');
    setFiles([]);
    setError(null);
  }, [open, report, defaultTotal]);
  const spendMinor = moneyInput(spend);
  const totalN = Number(total);
  const invalid = whatOccurred.trim().length < 10 || !Number.isInteger(totalN) || totalN < 0 || spendMinor === undefined;

  const save = async (submit: boolean) => {
    setBusy(submit ? 'submit' : 'save');
    setError(null);
    try {
      const evidenceFileIds: string[] = [];
      for (const f of files) evidenceFileIds.push((await uploadCampaignFile('/events/files', f)).id);
      const body: SaveAfterActionReport = {
        whatOccurred: whatOccurred.trim(),
        attendanceTotal: totalN,
        attendanceBreakdown: Object.fromEntries(
          Object.entries(breakdown)
            .filter(([, v]) => v && v.trim() !== '' && Number.isInteger(Number(v)))
            .map(([k, v]) => [k, Number(v)]),
        ) as SaveAfterActionReport['attendanceBreakdown'],
        actualSpendMinor: spendMinor ?? null,
        currency: DEFAULT_CURRENCY,
        issues: issues.trim() || null,
        lessons: lessons.trim() || null,
        evidenceFileIds,
        ...(report ? { expectedVersion: report.version } : {}),
      };
      onSaved(await eventsApi.saveAfterAction(event.id, body, submit));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" title="After-action report" description="Write what happened, attendance and spend. Once submitted, a reviewer other than you approves it and it is then locked.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        {report?.status === 'RETURNED' && report.reviewNote ? (
          <Notice tone="warning" className="mb-4" title="Returned by the reviewer">
            {report.reviewNote}
          </Notice>
        ) : null}
        <FormField id="aa-what" label="What occurred" required hint="At least 10 characters.">
          <textarea id="aa-what" className={`${textareaClass} min-h-[140px]`} value={whatOccurred} onChange={(e) => setWhatOccurred(e.target.value)} maxLength={10000} />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField id="aa-total" label="Total attendance" required>
            <input id="aa-total" type="number" min={0} className="ngao-input" value={total} onChange={(e) => setTotal(e.target.value)} />
          </FormField>
          <FormField id="aa-spend" label={`Actual spend (${DEFAULT_CURRENCY})`} hint="Reported figure; the finance ledger stays authoritative." error={spendMinor === undefined ? 'Enter an amount like 45000 or 45,000.50.' : null}>
            <input id="aa-spend" inputMode="decimal" className="ngao-input" value={spend} onChange={(e) => setSpend(e.target.value)} />
          </FormField>
        </div>
        <fieldset className="mb-4 rounded-lg border border-line p-3">
          <legend className="px-1 text-meta font-semibold text-slate">Attendance by role (counts only)</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {ATTENDANCE_ROLES.map((r) => (
              <label key={r} className="text-meta text-slate">
                {ATTENDANCE_ROLE_LABELS[r]}
                <input type="number" min={0} className="ngao-input mt-1" value={breakdown[r] ?? ''} onChange={(e) => setBreakdown((b) => ({ ...b, [r]: e.target.value }))} />
              </label>
            ))}
          </div>
        </fieldset>
        <FormField id="aa-issues" label="Issues">
          <textarea id="aa-issues" className={textareaClass} value={issues} onChange={(e) => setIssues(e.target.value)} maxLength={5000} />
        </FormField>
        <FormField id="aa-lessons" label="Lessons">
          <textarea id="aa-lessons" className={textareaClass} value={lessons} onChange={(e) => setLessons(e.target.value)} maxLength={5000} />
        </FormField>
        <FormField id="aa-files" label="Evidence files" hint={report?.evidence.length ? `${report.evidence.length} already attached; new files are added.` : 'Images or PDF, up to 25 MB each.'}>
          <input id="aa-files" type="file" multiple accept={CAMPAIGN_FILE_ACCEPT} className="block w-full text-body" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </FormField>
        <Err error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="secondary" loading={busy === 'save'} disabled={invalid || !!busy}>
            <Save className="h-4 w-4" aria-hidden />
            Save draft
          </Button>
          <Button type="button" loading={busy === 'submit'} disabled={invalid || !!busy} onClick={() => void save(true)}>
            <Send className="h-4 w-4" aria-hidden />
            Save and submit for approval
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function AfterActionReviewDialog({
  decision,
  onClose,
  event,
  report,
  onSaved,
}: {
  decision: 'APPROVE' | 'RETURN' | null;
  onClose: () => void;
  event: CampaignEventDetail;
  report: EventAfterActionReport;
  onSaved: (r: EventAfterActionReport) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNote('');
    setError(null);
  }, [decision]);
  if (!decision) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await eventsApi.reviewAfterAction(event.id, { decision, note: note.trim() || undefined, expectedVersion: report.version }));
      onClose();
    } catch (err) {
      setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={decision === 'APPROVE' ? 'Approve the after-action report' : 'Return the report'}
      description={decision === 'APPROVE' ? 'Approval locks the report. You cannot approve a report you wrote.' : 'The author is asked to revise it.'}
    >
      <form onSubmit={submit}>
        <FormField id="ar-note" label={decision === 'RETURN' ? 'What needs to change' : 'Note'} required={decision === 'RETURN'}>
          <textarea id="ar-note" className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FormField>
        <Err error={error} />
        <Actions busy={busy} onCancel={onClose} disabled={decision === 'RETURN' && note.trim().length < 3}>
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {decision === 'APPROVE' ? 'Approve report' : 'Return report'}
        </Actions>
      </form>
    </Dialog>
  );
}
