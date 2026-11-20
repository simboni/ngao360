import { Suspense } from 'react';
import { AcceptInvitationForm } from '@/components/auth/accept-invitation-form';

export const metadata = { title: 'Accept invitation' };

/** S01 companion: redeem a single-use invitation and set your own password. */
export default function AcceptInvitationPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cloud px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy text-lg font-bold text-white" aria-hidden>
          N
        </span>
        <span className="text-[22px] font-semibold text-navy">NGAO360</span>
      </div>
      <Suspense>
        <AcceptInvitationForm />
      </Suspense>
    </main>
  );
}
