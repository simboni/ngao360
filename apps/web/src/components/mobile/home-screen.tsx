'use client';

/** Mobile Home (blueprint 11.3): my station(s), urgent notices, sync status and the main tasks. */
import { ClipboardList, FileUp, History, MapPinCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import { AssignmentCard } from './assignment-card';
import { pendingTargets } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { BigLink, MobileCard, Notice, PageTitle, SourceNote, Spinner } from './mobile-ui';
import { QueueStatusCard } from './queue-status';
import { useFieldMe } from './use-field-data';

export function HomeScreen() {
  const s = useMobileSession();
  const me = useFieldMe();
  const data = me.data;
  const pendingCheckIn = pendingTargets(s.entries, 'CHECK_IN');
  const pendingConfirm = pendingTargets(s.entries, 'ASSIGNMENT_CONFIRMATION');
  const can = data?.can ?? {
    submitFieldReport: s.can('field.reports.submit'),
    reportIncident: s.can('field.incidents.report'),
    checkIn: s.can('field.deployment.checkin'),
    uploadResultForm: s.can('tally.submit') && s.moduleEnabled('tally'),
  };

  return (
    <div className="flex flex-col gap-4">
      <PageTitle sub={data?.agent ? `Agent ${data.agent.reference}` : undefined}>Hello{s.displayName ? `, ${s.displayName.split(' ')[0]}` : ''}</PageTitle>

      {data?.notices.map((n) => (
        <Notice key={n.id} tone="warning" title={n.title} role="status">
          <p>{n.body}</p>
          <p className="mt-1 text-meta text-slate">{formatDateTime(n.createdAt)}</p>
        </Notice>
      ))}

      <QueueStatusCard />

      <section aria-labelledby="my-stations" className="flex flex-col gap-2">
        <h2 id="my-stations" className="text-card font-semibold text-navy">
          My station{data && data.assignments.length === 1 ? '' : 's'}
        </h2>
        {me.loading && !data ? <Spinner /> : null}
        {me.error ? <Notice tone={me.errorCode ? 'error' : 'info'}>{me.error}</Notice> : null}
        <SourceNote source={me.source} savedAt={me.savedAt} />
        {data && !data.agent ? (
          <Notice>You are not registered as a field agent, so no station is assigned to you. You can still use the parts of the app your role allows.</Notice>
        ) : null}
        {data?.agent && data.assignments.length === 0 ? (
          <MobileCard>
            <p className="text-body text-ink">No station is assigned to you yet. Your coordinator will assign one; it appears here.</p>
          </MobileCard>
        ) : null}
        {data?.assignments.map((a) => {
          const note = pendingCheckIn.has(a.id)
            ? 'Check-in saved on this phone; see the upload queue.'
            : pendingConfirm.has(a.id)
              ? 'Confirmation saved on this phone; see the upload queue.'
              : null;
          const needsAction = a.allowedActions.includes('confirm') || a.allowedActions.includes('check_in');
          return (
            <AssignmentCard key={a.id} a={a} pendingNote={note}>
              {can.checkIn && needsAction && !note ? (
                <Link href="/m/checkin" className="flex min-h-[52px] items-center justify-center gap-2 rounded-xl bg-teal px-4 font-semibold text-white">
                  <MapPinCheck className="h-5 w-5" aria-hidden />
                  {a.allowedActions.includes('confirm') ? 'Confirm and check in' : 'Check in'}
                </Link>
              ) : null}
            </AssignmentCard>
          );
        })}
      </section>

      <section aria-labelledby="tasks" className="flex flex-col gap-2">
        <h2 id="tasks" className="text-card font-semibold text-navy">
          Tasks
        </h2>
        {can.submitFieldReport ? <BigLink href="/m/report" icon={ClipboardList} title="Field report" hint="Short factual checklist for your station" /> : null}
        {can.reportIncident ? <BigLink href="/m/incident" icon={TriangleAlert} title="Report an incident" hint="What happened, when and where" /> : null}
        {can.uploadResultForm ? <BigLink href="/m/forms" icon={FileUp} title="Upload a result form" hint="Photo of the official form into NGAO TALLY" /> : null}
        <BigLink href="/m/submissions" icon={History} title="My submissions" hint="Status, returned reports and corrections" />
      </section>
    </div>
  );
}
