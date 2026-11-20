'use client';

/**
 * Result forms (blueprint 11.3 "Result form upload"): links into the
 * existing NGAO TALLY intake (S18 inbox and upload dialog), which keeps its
 * own checks (hashing, duplicate detection, station scope). Uploading a form
 * needs a connection; result form images are never kept in the offline queue.
 * The internal parallel tally is never an official result.
 */
import { FileUp } from 'lucide-react';
import Link from 'next/link';
import { stationOptions } from './mobile-model';
import { useMobileSession } from './mobile-session';
import { MobileCard, MobileGate, Notice, PageTitle } from './mobile-ui';
import { useFieldMe } from './use-field-data';

export function FormsScreen() {
  const s = useMobileSession();
  const me = useFieldMe();
  const stations = stationOptions(me.data?.assignments ?? []);
  return (
    <MobileGate anyOf={['tally.submit']} module="tally">
      <PageTitle sub="Upload a clear photo of the official result form for your station into NGAO TALLY.">Result forms</PageTitle>
      <div className="flex flex-col gap-3">
        <Notice>
          The parallel tally is an internal record for verification. It is never an official result; only the electoral commission declares results.
        </Notice>
        {stations.length > 0 ? (
          <MobileCard title="Your station">
            <ul className="text-body text-ink">
              {stations.map((st) => (
                <li key={st.code}>{st.label}</li>
              ))}
            </ul>
            <p className="mt-2 text-meta text-slate">Choose this station in the upload form.</p>
          </MobileCard>
        ) : null}
        {s.online ? (
          <Link href="/tally/inbox?upload=1" className="flex min-h-[60px] items-center justify-center gap-2 rounded-xl bg-teal px-4 text-card font-semibold text-white">
            <FileUp className="h-6 w-6" aria-hidden /> Open NGAO TALLY upload
          </Link>
        ) : (
          <Notice tone="warning" title="Needs a connection">
            Result form photos are uploaded directly and are not stored on this phone. Upload once you are connected; keep the photo in your camera until then.
          </Notice>
        )}
        <p className="text-meta text-slate">In NGAO TALLY, tap “Upload form”, choose the contest and form type, then take or choose the photo. You get a reference once it is received.</p>
      </div>
    </MobileGate>
  );
}
