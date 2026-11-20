import { MobilePlaceholder } from '@/components/field/mobile/mobile-placeholder';

export const metadata = { title: 'Check in' };

/** Mobile PWA: Check in (blueprint 11.3). API §16–22. */
export default function MobileCheckInPage() {
  return (
    <MobilePlaceholder
      title="Check in"
      description="Confirm your assignment and check in at your station. A location is attached only when your organisation has switched it on and you agree; it is never tracked continuously."
      anyOf={['field.deployment.checkin']}
    />
  );
}
