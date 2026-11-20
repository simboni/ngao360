'use client';

import type { PublicCaseReceipt } from '@ngao360/shared';
import { AlertTriangle, CheckCircle2, Copy, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { usePortal } from './portal-context';
import { Panel, PortalButton } from './portal-ui';

/**
 * Success screen after a submission. The tracking code is shown once (only
 * its hash is stored), so the page says so plainly and offers copy buttons.
 * The code is never put in a URL; the "track" link carries the reference only.
 */
export function Receipt({ receipt, onAnother }: { receipt: PublicCaseReceipt; onAnother: () => void }) {
  const { t, base } = usePortal();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const trackHref = `${receipt.trackPath || `${base}/track`}?ref=${encodeURIComponent(receipt.publicReference)}`;

  return (
    <Panel className="border-success/40">
      <h1 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-[24px] font-semibold leading-8 text-navy focus:outline-none">
        <CheckCircle2 className="h-7 w-7 shrink-0 text-success" aria-hidden />
        {t('receipt.title')}
      </h1>
      <p className="mt-2 text-base text-ink">{receipt.acknowledgement || t('receipt.body')}</p>
      <p className="mt-1 text-body text-slate">{t('receipt.submittedAt', { date: formatDateTime(receipt.submittedAt) })}</p>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <CopyValue label={t('receipt.reference')} value={receipt.publicReference} />
        <CopyValue label={t('receipt.code')} value={receipt.trackingCode} />
      </dl>

      <div role="note" className="mt-4 flex items-start gap-3 rounded-lg border-2 border-gold/70 bg-gold/10 p-3 text-base text-ink">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#7a5a17]" aria-hidden />
        <p className="font-medium">{t('receipt.warning')}</p>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link href={trackHref} className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-teal px-5 text-base font-semibold text-white hover:bg-teal/90">
          <Search className="h-5 w-5" aria-hidden />
          {t('receipt.track')}
        </Link>
        <PortalButton type="button" variant="secondary" onClick={onAnother}>
          {t('receipt.another')}
        </PortalButton>
      </div>
    </Panel>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = usePortal();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable: the value stays visible to write down */
    }
  };
  return (
    <div className="rounded-lg border border-line bg-cloud p-3">
      <dt className="text-body font-medium text-slate">{label}</dt>
      <dd className="mt-1 flex items-center justify-between gap-2">
        <span className="select-all break-all font-mono text-[22px] font-semibold tracking-wider text-navy">{value}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-slate/40 bg-surface px-3 text-body font-medium text-ink hover:bg-cloud"
          aria-label={`${t('common.copy')} ${label}`}
        >
          <Copy className="h-4 w-4" aria-hidden />
          <span aria-live="polite">{copied ? t('common.copied') : t('common.copy')}</span>
        </button>
      </dd>
    </div>
  );
}
