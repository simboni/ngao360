import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/login-form';

export const metadata = { title: 'Sign in' };

/** S01 Login / MFA. */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cloud px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy text-lg font-bold text-white" aria-hidden>
          N
        </span>
        <span className="text-[22px] font-semibold text-navy">NGAO360</span>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
      <footer className="mt-6 flex gap-4 text-meta text-slate">
        <a href="/legal/privacy" className="hover:underline">Privacy notice</a>
        <a href="/legal/terms" className="hover:underline">Terms of use</a>
      </footer>
    </main>
  );
}
