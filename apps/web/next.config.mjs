import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=()' },
];

const nextConfig = {
  output: 'standalone',
  // Monorepo: trace workspace packages from the repository root.
  outputFileTracingRoot: path.join(here, '../../'),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@ngao360/shared'],
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // Same-origin API so httpOnly auth cookies are first-party.
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ];
  },
};

export default nextConfig;
