import { PortalHome } from '@/components/public/portal-home';
import { PortalGate } from '@/components/public/portal-ui';

export const metadata = { title: 'Home' };

/** Portal home. API §13.1 (GET /public/:tenantSlug/portal). */
export default function PortalHomePage() {
  return (
    <PortalGate>
      <PortalHome />
    </PortalGate>
  );
}
