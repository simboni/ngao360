import { MobilePlaceholder } from '@/components/field/mobile/mobile-placeholder';

export const metadata = { title: 'Result forms' };

/** Mobile PWA: Result forms (blueprint 11.3). API §16–22. */
export default function MobileFormsPage() {
  return (
    <MobilePlaceholder
      title="Result forms"
      description="Upload a photo of the official result form for your station into NGAO TALLY intake (when your role allows it). The internal parallel tally is never an official result."
      anyOf={['tally.submit']}
    />
  );
}
