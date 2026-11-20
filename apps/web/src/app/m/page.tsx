import { MobilePlaceholder } from '@/components/field/mobile/mobile-placeholder';

export const metadata = { title: 'Home' };

/** Mobile PWA: Home (blueprint 11.3). API §16–22. */
export default function MobileHomePage() {
  return (
    <MobilePlaceholder
      title="Home"
      description="My station and assignment, supervisor contact hint, check-in state, urgent notices, and the offline queue: saved on this phone, uploading, confirmed, or needing review."
      anyOf={[]}
    />
  );
}
