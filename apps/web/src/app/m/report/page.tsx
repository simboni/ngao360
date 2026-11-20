import { MobilePlaceholder } from '@/components/field/mobile/mobile-placeholder';

export const metadata = { title: 'Field report' };

/** Mobile PWA: Field report (blueprint 11.3). API §16–22. */
export default function MobileReportPage() {
  return (
    <MobilePlaceholder
      title="Field report"
      description="S11 on the phone: choose a template, answer the short factual questions, add a photo, save a draft and upload now or when back online."
      anyOf={['field.reports.submit']}
    />
  );
}
