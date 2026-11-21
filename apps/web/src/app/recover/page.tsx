import { Suspense } from 'react';
import { RecoverAccountForm } from '@/components/auth/recover-account-form';

export const metadata = { title: 'Recover your account' };

/** S01 companion: complete an administrator-approved account recovery (API contract §32.3). */
export default function RecoverAccountPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cloud px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy text-lg font-bold text-white" aria-hidden>
          N
        </span>
        <span className="text-[22px] font-semibold text-navy">NGAO360</span>
      </div>
      <Suspense>
        <RecoverAccountForm />
      </Suspense>
    </main>
  );
}
