import { WifiOff } from 'lucide-react';

export const metadata = { title: 'Offline' };

/** Cached by the service worker as the navigation fallback. Contains no sensitive data. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="ngao-card max-w-md p-8 text-center">
        <WifiOff className="mx-auto mb-3 h-8 w-8 text-slate" aria-hidden />
        <h1 className="text-section font-semibold text-navy">You are offline</h1>
        <p className="mt-2 text-body text-slate">
          NGAO360 needs a connection for this page. Drafts saved on this device stay in the offline queue and will sync when you reconnect.
        </p>
      </div>
    </main>
  );
}
