'use client';

import type { PermissionKey } from '@ngao360/shared';
import { ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { EmptyState } from './empty-state';

/**
 * Hide UI the user cannot use. This is presentation only: the API enforces
 * every permission server-side.
 */
export function PermissionGate({
  anyOf,
  children,
  fallback = null,
}: {
  anyOf: PermissionKey[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { canAny, loading } = useAuth();
  if (loading) return null;
  return <>{canAny(anyOf) ? children : fallback}</>;
}

/** Page-level guard with an accessible "no access" message. */
export function RequirePagePermission({ anyOf, children }: { anyOf: PermissionKey[]; children: ReactNode }) {
  return (
    <PermissionGate
      anyOf={anyOf}
      fallback={
        <div className="ngao-card">
          <EmptyState icon={ShieldOff} title="You do not have access to this page" description="Ask your organisation owner if you need this permission." />
        </div>
      }
    >
      {children}
    </PermissionGate>
  );
}
