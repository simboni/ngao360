import { Suspense } from 'react';
import { PortalGate } from '@/components/public/portal-ui';
import { TrackView } from '@/components/public/track-view';

export const metadata = { title: 'Track a request' };

/** Track a request by public reference and tracking code. API §13.3. */
export default function PublicTrackPage() {
  return (
    <PortalGate>
      <Suspense>
        <TrackView />
      </Suspense>
    </PortalGate>
  );
}
