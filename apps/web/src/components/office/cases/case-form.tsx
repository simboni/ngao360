'use client';

import type { ReactNode } from 'react';
import { describeError as describeGeneric } from '@/components/tally/errors';
import { ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/cn';

/** Case-specific wording for API decisions (API §11). The API stays the authority. */
export function describeCaseError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'SEPARATION_OF_DUTIES':
        return 'Separation of duties: you proposed this resolution, so a different authorised officer must close the case.';
      case 'OUT_OF_SCOPE':
        return 'This case is outside the wards or constituencies you are assigned to.';
      case 'MODULE_DISABLED':
        return 'NGAO360 Office is switched off for your organisation.';
      case 'INVALID_TRANSITION':
        return 'The case is no longer at a stage that allows this action. Refresh to see its current stage.';
      default:
        break;
    }
  }
  return describeGeneric(err);
}

export function FormField({
  id,
  label,
  hint,
  required,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4', className)}>
      <label htmlFor={id} className="ngao-label">
        {label}
        {required ? (
          <span className="ml-0.5 text-error" aria-hidden>
            *
          </span>
        ) : (
          <span className="ml-1 font-normal text-slate">(optional)</span>
        )}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-meta text-slate">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const textareaClass = 'ngao-input h-auto min-h-[84px] py-2';

/** Today's date in Africa/Nairobi as YYYY-MM-DD (for date inputs). */
export function todayNairobi(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
