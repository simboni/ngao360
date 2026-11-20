'use client';

import { HASH_CAVEAT, type StoredFile } from '@ngao360/shared';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileWarning,
  Maximize2,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  ShieldX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';
import { describeError } from './errors';
import { formatBytes, sha256Hex, shortHash } from './file-hash';
import { tallyApi } from './tally-api';

const MIN_SCALE = 0.1;
const MAX_SCALE = 6;

type Integrity = 'checking' | 'match' | 'mismatch' | 'unchecked';

interface Loaded {
  objectUrl: string | null;
  remoteUrl: string;
  integrity: Integrity;
}

/**
 * Read-only viewer for the original uploaded form (blueprint 11.1): zoom,
 * rotate, fit-to-width and page navigation; PDFs open in the browser's PDF
 * viewer. The bytes are fetched through an audited, short-lived signed URL
 * and their SHA-256 is compared with the stored hash. The original is never
 * modified; rotation and zoom are display-only.
 */
export function SourceViewer({
  submissionId,
  file,
  pageCount,
  canDownload,
  className,
}: {
  submissionId: string;
  file: StoredFile;
  pageCount?: number | null;
  canDownload: boolean;
  className?: string;
}) {
  const isPdf = file.mimeType === 'application/pdf';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [page, setPage] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, pageCount ?? file.pageCount ?? 1);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoaded(null);
    setError(null);
    (async () => {
      try {
        const signed = await tallyApi.sourceUrl(submissionId);
        if (cancelled) return;
        setLoaded({ objectUrl: null, remoteUrl: signed.url, integrity: 'checking' });
        try {
          const res = await fetch(signed.url, { credentials: 'include' });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const hash = await sha256Hex(blob);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: file.mimeType }));
          setLoaded({ objectUrl, remoteUrl: signed.url, integrity: hash === file.sha256 ? 'match' : 'mismatch' });
        } catch {
          // Cross-origin storage without CORS: show the signed URL directly; integrity not checked in the browser.
          if (!cancelled) setLoaded({ objectUrl: null, remoteUrl: signed.url, integrity: 'unchecked' });
        }
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [submissionId, file.sha256, file.mimeType]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rotated = rotation % 180 !== 0;
  const effectiveScale =
    fit && natural && containerWidth > 0 ? Math.max(MIN_SCALE, (containerWidth - 16) / (rotated ? natural.h : natural.w)) : scale;

  const zoom = useCallback(
    (factor: number) => {
      setFit(false);
      setScale(() => Math.min(MAX_SCALE, Math.max(MIN_SCALE, effectiveScale * factor)));
    },
    [effectiveScale],
  );

  const download = async () => {
    try {
      const signed = await tallyApi.sourceUrl(submissionId, true);
      window.location.assign(signed.url);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const src = loaded ? (loaded.objectUrl ?? loaded.remoteUrl) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isPdf) return;
    if (e.key === '+' || e.key === '=') zoom(1.25);
    else if (e.key === '-') zoom(0.8);
    else if (e.key === '0') setFit(true);
    else if (e.key.toLowerCase() === 'r') setRotation((r) => (r + 90) % 360);
    else return;
    e.preventDefault();
  };

  const toolBtn = 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink hover:bg-cloud disabled:opacity-40';

  return (
    <section aria-label="Original form" className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1.5" role="toolbar" aria-label="Image controls">
        {!isPdf ? (
          <>
            <button type="button" className={toolBtn} onClick={() => zoom(0.8)} aria-label="Zoom out" title="Zoom out (-)">
              <ZoomOut className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-12 text-center text-meta tabular-nums text-slate" aria-live="polite">
              {Math.round(effectiveScale * 100)}%
            </span>
            <button type="button" className={toolBtn} onClick={() => zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)">
              <ZoomIn className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className={cn(toolBtn, fit && 'bg-cloud')}
              onClick={() => setFit(true)}
              aria-pressed={fit}
              aria-label="Fit to width"
              title="Fit to width (0)"
            >
              <Maximize2 className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolBtn} onClick={() => setRotation((r) => (r + 270) % 360)} aria-label="Rotate left">
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolBtn} onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate right" title="Rotate (R)">
              <RotateCw className="h-4 w-4" aria-hidden />
            </button>
          </>
        ) : null}
        {pages > 1 || isPdf ? (
          <div className="flex items-center gap-1" aria-label="Page navigation">
            <button type="button" className={toolBtn} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <span className="text-meta tabular-nums text-slate" aria-live="polite">
              Page {page} of {pages}
            </span>
            <button type="button" className={toolBtn} onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label="Next page">
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {src ? (
            <a href={src} target="_blank" rel="noopener noreferrer" className={toolBtn} aria-label="Open original in a new tab" title="Open in new tab">
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          ) : null}
          {canDownload ? (
            <button type="button" className={toolBtn} onClick={() => void download()} aria-label="Download original" title="Download original (audited)">
              <Download className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={`Original ${file.originalFilename}. Use plus and minus to zoom, 0 to fit, R to rotate.`}
        className="relative min-h-[320px] flex-1 overflow-auto bg-[#e7ecf1] p-2"
      >
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-slate">
            <FileWarning className="h-8 w-8" aria-hidden />
            <p>{error}</p>
          </div>
        ) : !src ? (
          <div className="flex h-full items-center justify-center text-slate">Loading original…</div>
        ) : isPdf ? (
          <iframe
            key={page}
            title={`Original PDF, page ${page}`}
            src={`${src}#page=${page}&view=FitH`}
            className="h-full min-h-[70vh] w-full rounded bg-surface"
          />
        ) : (
          <div
            className="relative mx-auto"
            style={
              natural
                ? {
                    width: (rotated ? natural.h : natural.w) * effectiveScale,
                    height: (rotated ? natural.w : natural.h) * effectiveScale,
                  }
                : undefined
            }
          >
            <img
              src={src}
              alt={`Original result form ${file.originalFilename}`}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={
                natural
                  ? {
                      position: 'absolute',
                      left: '50%',
                      top: '50%',
                      width: natural.w * effectiveScale,
                      height: natural.h * effectiveScale,
                      maxWidth: 'none',
                      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                    }
                  : { maxWidth: '100%' }
              }
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface px-3 py-2 text-meta text-slate">
        <span>
          {file.mimeType} · {formatBytes(file.sizeBytes)}
        </span>
        <span title={file.sha256} className="font-mono">
          SHA-256 {shortHash(file.sha256, 16)}
        </span>
        {loaded?.integrity === 'match' ? (
          <StatusBadge kind="custom" status="match" label="Hash matches stored record" tone="success" icon={ShieldCheck} size="sm" />
        ) : loaded?.integrity === 'mismatch' ? (
          <StatusBadge kind="custom" status="mismatch" label="Hash mismatch — report this" tone="danger" icon={ShieldX} size="sm" />
        ) : loaded?.integrity === 'checking' ? (
          <span>Checking hash…</span>
        ) : null}
        <details className="w-full">
          <summary className="cursor-pointer">What does the hash prove?</summary>
          <p className="mt-1">{HASH_CAVEAT}</p>
        </details>
      </div>
    </section>
  );
}
