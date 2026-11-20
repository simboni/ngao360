'use client';

/**
 * Photo evidence for reports and incidents. Each photo is resized on the
 * phone (long edge 1600 px, JPEG) and re-encoded, which removes EXIF
 * metadata such as the GPS position, before it is encrypted into the queue.
 */
import { Camera, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PhotoError, preparePhoto, type PreparedPhoto } from '@/lib/offline/image';
import { formatBytes } from './mobile-model';

export interface PickedPhoto extends PreparedPhoto {
  id: string;
}

export function PhotoPicker({ photos, onChange, max = 3 }: { photos: PickedPhoto[]; onChange: (p: PickedPhoto[]) => void; max?: number }) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...photos];
    try {
      for (const f of Array.from(files).slice(0, Math.max(0, max - photos.length))) {
        const p = await preparePhoto(f);
        next.push({ ...p, id: `${Date.now()}-${next.length}` });
      }
      onChange(next);
    } catch (err) {
      setError(err instanceof PhotoError ? err.message : 'The photo could not be prepared');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <ul className="grid grid-cols-3 gap-2">
        {photos.map((p) => (
          <li key={p.id} className="relative">
            <Thumb photo={p} />
            <button
              type="button"
              className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full bg-navy/80 text-white"
              aria-label="Remove photo"
              onClick={() => onChange(photos.filter((x) => x.id !== p.id))}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            <p className="text-[11px] text-slate">{formatBytes(p.bytes.byteLength)}</p>
          </li>
        ))}
      </ul>
      {photos.length < max ? (
        <label
          htmlFor={inputId}
          className="flex min-h-[52px] cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-teal bg-surface px-4 font-semibold text-teal"
          aria-busy={busy || undefined}
        >
          <Camera className="h-5 w-5" aria-hidden /> {busy ? 'Preparing photo…' : photos.length ? 'Add another photo' : 'Add a photo (optional)'}
          <input id={inputId} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void add(e.target.files).finally(() => (e.target.value = ''))} />
        </label>
      ) : null}
      <p className="text-meta text-slate">Photos are made smaller and their hidden data (such as GPS position) is removed on this phone before saving.</p>
      {error ? (
        <p className="text-meta font-medium text-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Thumb({ photo }: { photo: PickedPhoto }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([photo.bytes], { type: photo.mimeType }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo]);
  return url ? <img src={url} alt="Selected evidence" className="aspect-square w-full rounded-lg object-cover" /> : <div className="aspect-square rounded-lg bg-cloud" />;
}
