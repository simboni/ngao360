'use client';

import { HASH_CAVEAT, type OfficeFile, type SignedUrlResponse } from '@ngao360/shared';
import { Download, ExternalLink, FileText, FileWarning, Maximize2, RotateCw, ShieldCheck, ShieldX, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { sha256Hex, shortHash } from '@/components/tally/file-hash';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { describeOfficeError, formatBytes } from './office-common';

type Integrity = 'checking' | 'match' | 'mismatch' | 'unchecked';

export function isPreviewable(mime: string): 'image' | 'pdf' | null {
  if (mime === 'application/pdf') return 'pdf';
  // HEIC does not render in most browsers; offer download instead.
  if (mime.startsWith('image/') && mime !== 'image/heic') return 'image';
  return null;
}

/**
 * Read-only preview of a stored Office file (scan, photo or PDF). The bytes are
 * fetched through the record's audited, short-lived signed URL (every request
 * writes FILE_SOURCE_ACCESSED) and their SHA-256 is compared with the stored
 * hash. Zoom and rotation are display-only; the original is immutable.
 *
 * Mirrors the tally source viewer, but takes the signed-URL loader as a prop
 * so each Office record type uses its own endpoint.
 */
export function OfficeFilePreview({
  file,
  loadUrl,
  alt,
  className,
  compact = false,
}: {
  file: OfficeFile;
  /** Calls the record's `…/url` endpoint; `download` adds `?download=1`. */
  loadUrl: (download: boolean) => Promise<SignedUrlResponse>;
  alt: string;
  className?: string;
  compact?: boolean;
}) {
  const kind = isPreviewable(file.mimeType);
  const [src, setSrc] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<Integrity>('checking');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [requested, setRequested] = useState(!compact);

  useEffect(() => {
    if (!kind || !requested) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);
    setIntegrity('checking');
    (async () => {
      try {
        const signed = await loadUrl(false);
        if (cancelled) return;
        try {
          const res = await fetch(signed.url, { credentials: 'include' });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const hash = await sha256Hex(blob);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: file.mimeType }));
          setSrc(objectUrl);
          setIntegrity(hash === file.sha256 ? 'match' : 'mismatch');
        } catch {
          if (!cancelled) {
            setSrc(signed.url);
            setIntegrity('unchecked');
          }
        }
      } catch (err) {
        if (!cancelled) setError(describeOfficeError(err));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // loadUrl is recreated by parents on every render; the file identity is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.sha256, kind, requested]);

  const download = async () => {
    try {
      const signed = await loadUrl(true);
      window.location.assign(signed.url);
    } catch (err) {
      setError(describeOfficeError(err));
    }
  };

  const toolBtn = 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink hover:bg-cloud disabled:opacity-40';

  return (
    <section aria-label={`Preview of ${file.originalFilename}`} className={cn('flex min-h-0 flex-col overflow-hidden rounded-lg border border-line', className)}>
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1.5" role="toolbar" aria-label="Preview controls">
        <span className="mr-2 min-w-0 flex-1 truncate text-meta font-medium text-ink" title={file.originalFilename}>
          {file.originalFilename}
        </span>
        {kind === 'image' && src ? (
          <>
            <button type="button" className={toolBtn} onClick={() => setScale((s) => Math.max(0.25, s * 0.8))} aria-label="Zoom out">
              <ZoomOut className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-11 text-center text-meta tabular-nums text-slate" aria-live="polite">
              {Math.round(scale * 100)}%
            </span>
            <button type="button" className={toolBtn} onClick={() => setScale((s) => Math.min(6, s * 1.25))} aria-label="Zoom in">
              <ZoomIn className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolBtn} onClick={() => setScale(1)} aria-label="Fit to width">
              <Maximize2 className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolBtn} onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate">
              <RotateCw className="h-4 w-4" aria-hidden />
            </button>
          </>
        ) : null}
        {src ? (
          <a href={src} target="_blank" rel="noopener noreferrer" className={toolBtn} aria-label="Open in a new tab">
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
        <button type="button" className={toolBtn} onClick={() => void download()} aria-label="Download (audited)" title="Download (audited)">
          <Download className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className={cn('relative flex-1 overflow-auto bg-[#e7ecf1] p-2', compact ? 'min-h-[180px]' : 'min-h-[360px]')}>
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-slate">
            <FileWarning className="h-8 w-8" aria-hidden />
            <p>{error}</p>
          </div>
        ) : !kind ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-slate">
            <FileText className="h-8 w-8" aria-hidden />
            <p>This file type cannot be previewed in the browser. Use download.</p>
          </div>
        ) : !requested ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-slate">
            <FileText className="h-8 w-8" aria-hidden />
            <button type="button" className="text-deep-blue underline" onClick={() => setRequested(true)}>
              Show preview
            </button>
            <p className="text-meta">Opening a file issues an audited signed link.</p>
          </div>
        ) : !src ? (
          <div className="flex h-full items-center justify-center text-slate">Loading preview…</div>
        ) : kind === 'pdf' ? (
          <iframe title={`PDF ${file.originalFilename}`} src={`${src}#view=FitH`} className={cn('w-full rounded bg-surface', compact ? 'h-[240px]' : 'h-[60vh]')} />
        ) : (
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="mx-auto block"
            style={{ width: `${scale * 100}%`, maxWidth: 'none', transform: `rotate(${rotation}deg)`, transformOrigin: 'center' }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface px-3 py-2 text-meta text-slate">
        <span>
          {file.mimeType} · {formatBytes(file.sizeBytes)}
        </span>
        <span title={file.sha256} className="font-mono">
          SHA-256 {shortHash(file.sha256, 16)}
        </span>
        {src && integrity === 'match' ? (
          <StatusBadge kind="custom" status="match" label="Hash matches stored record" tone="success" icon={ShieldCheck} size="sm" />
        ) : src && integrity === 'mismatch' ? (
          <StatusBadge kind="custom" status="mismatch" label="Hash mismatch — report this" tone="danger" icon={ShieldX} size="sm" />
        ) : null}
        {!compact ? (
          <details className="w-full">
            <summary className="cursor-pointer">What does the hash prove?</summary>
            <p className="mt-1">{HASH_CAVEAT}</p>
          </details>
        ) : null}
      </div>
    </section>
  );
}
