import type { ReactNode } from 'react';
import { TallyActionProvider } from '@/components/tally/action-provider';
import { ParallelTallyBanner } from '@/components/ui/parallel-tally-banner';

/**
 * Every NGAO TALLY screen carries the non-official parallel-tally banner, and
 * shares the reason / re-authentication prompts used by high-risk actions.
 */
export default function TallyLayout({ children }: { children: ReactNode }) {
  return (
    <TallyActionProvider>
      <ParallelTallyBanner />
      {children}
    </TallyActionProvider>
  );
}
