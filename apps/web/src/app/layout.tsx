import '@fontsource-variable/inter';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorkerRegister } from '@/components/pwa/sw-register';

export const metadata: Metadata = {
  title: { default: 'NGAO360', template: '%s · NGAO360' },
  description: 'Operations, field and parallel recordkeeping platform.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon.svg' },
  applicationName: 'NGAO360',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#102B46',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-KE">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
