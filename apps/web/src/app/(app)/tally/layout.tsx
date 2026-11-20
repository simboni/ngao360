import type { ReactNode } from 'react';
import { ParallelTallyBanner } from '@/components/ui/parallel-tally-banner';

/** Every NGAO TALLY screen carries the non-official parallel-tally banner. */
export default function TallyLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ParallelTallyBanner />
      {children}
    </>
  );
}
