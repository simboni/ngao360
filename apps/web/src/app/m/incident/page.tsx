import { MobilePlaceholder } from '@/components/field/mobile/mobile-placeholder';

export const metadata = { title: 'Report an incident' };

/** Mobile PWA: Report an incident (blueprint 11.3). API §16–22. */
export default function MobileIncidentPage() {
  return (
    <MobilePlaceholder
      title="Report an incident"
      description="S17 on the phone: category, time, station, a neutral factual description and optional evidence, with a privacy warning. You get a reference once it reaches the server."
      anyOf={['field.incidents.report']}
    />
  );
}
