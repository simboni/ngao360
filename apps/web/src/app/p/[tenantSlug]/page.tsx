import { PublicPlaceholder } from '@/components/office/public/public-shell';

export const metadata = { title: 'Public service portal' };

/** Portal home. API §13.1 (GET /public/:tenantSlug/portal). Owner: cases agent. */
export default function PortalHomePage() {
  return (
    <PublicPlaceholder
      title="Public service portal"
      description="Report a service issue, track a request with your reference and tracking code, or see public information about development projects."
    />
  );
}
