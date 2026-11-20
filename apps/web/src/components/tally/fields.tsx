'use client';

import { type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { cn } from '@/lib/cn';

export interface Option {
  value: string;
  label: string;
}

/** Labelled native select (keyboard and screen-reader friendly by default). */
export function SelectField({
  label,
  options,
  placeholder,
  hint,
  className,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  label: string;
  options: Option[];
  placeholder?: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="ngao-label">
        {label}
      </label>
      <select id={id} className="ngao-input pr-8" aria-describedby={hint ? hintId : undefined} {...rest}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={hintId} className="mt-1 text-meta text-slate">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Small label/value pair for metadata panels. */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-meta text-slate">{label}</dt>
      <dd className="min-w-0 break-words text-body text-ink">{children ?? '—'}</dd>
    </div>
  );
}
