'use client';

import { DEPLOYMENT_ROLE_LABELS, DEPLOYMENT_SHIFT_LABELS, DEPLOYMENT_STATUS_LABELS, type MyAssignment } from '@ngao360/shared';
import { MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { assignmentTitle } from './mobile-model';

const STATUS_CLS: Record<string, string> = {
  ASSIGNED: 'bg-gold/15 text-navy',
  CONFIRMED: 'bg-deep-blue/10 text-deep-blue',
  CHECKED_IN: 'bg-success/10 text-success',
  CHECKED_OUT: 'bg-cloud text-slate',
};

/** One of my assignments (blueprint 11.3 "My assignment"): station, role, shift, instructions, supervisor hint. */
export function AssignmentCard({ a, pendingNote, children }: { a: MyAssignment; pendingNote?: string | null; children?: ReactNode }) {
  const loc = a.location;
  return (
    <section className="ngao-card p-4" aria-label={assignmentTitle(a)}>
      <div className="flex items-start gap-3">
        <MapPin className="mt-0.5 h-6 w-6 shrink-0 text-teal" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-card font-semibold text-navy">{loc.station ? loc.station.name : 'Area assignment'}</p>
          {loc.station ? <p className="text-meta text-slate">Station code {loc.station.code}</p> : null}
          <p className="text-meta text-slate">{[loc.ward?.name, loc.constituency?.name, loc.county?.name].filter(Boolean).join(' · ')}</p>
          {loc.station && !loc.station.inApprovedRegistry ? (
            <p className="mt-1 text-meta font-medium text-error">This station code is no longer in the approved register. Contact your coordinator.</p>
          ) : null}
        </div>
        <span className={cn('shrink-0 rounded-full px-2 py-1 text-meta font-semibold', STATUS_CLS[a.status] ?? 'bg-cloud text-slate')}>
          {DEPLOYMENT_STATUS_LABELS[a.status]}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-body">
        <dt className="text-slate">Role</dt>
        <dd className="text-ink">{DEPLOYMENT_ROLE_LABELS[a.role]}</dd>
        <dt className="text-slate">Shift</dt>
        <dd className="text-ink">{DEPLOYMENT_SHIFT_LABELS[a.shift]}</dd>
        {a.supervisor ? (
          <>
            <dt className="text-slate">Supervisor</dt>
            <dd className="text-ink">{a.supervisor.displayName}</dd>
          </>
        ) : null}
        {a.checkedInAt ? (
          <>
            <dt className="text-slate">Checked in</dt>
            <dd className="text-ink">{formatDateTime(a.checkedInAt)}</dd>
          </>
        ) : null}
      </dl>
      {a.supervisorContactHint ? <p className="mt-2 text-meta text-slate">Contact: {a.supervisorContactHint}</p> : null}
      {a.instructions ? (
        <div className="mt-3 rounded-lg bg-cloud p-3">
          <p className="text-meta font-semibold text-ink">Instructions</p>
          <p className="whitespace-pre-line text-body text-ink">{a.instructions}</p>
        </div>
      ) : null}
      {pendingNote ? (
        <p className="mt-3 text-body font-medium text-deep-blue" role="status">
          {pendingNote}
        </p>
      ) : null}
      {children ? <div className="mt-3 flex flex-col gap-2">{children}</div> : null}
    </section>
  );
}
