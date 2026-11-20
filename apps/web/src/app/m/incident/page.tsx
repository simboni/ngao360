import { IncidentForm } from '@/components/mobile/incident-form';

export const metadata = { title: 'Report an incident' };

/** Mobile PWA: S17 incident intake (blueprint 11.3). API §20, §22. */
export default function MobileIncidentPage() {
  return <IncidentForm />;
}
