import { Suspense } from 'react';
import { ReportScreen } from '@/components/mobile/report-form';
import { Spinner } from '@/components/mobile/mobile-ui';

export const metadata = { title: 'Field report' };

/** Mobile PWA: S11 field report (blueprint 11.3). API §19, §22. */
export default function MobileReportPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReportScreen />
    </Suspense>
  );
}
