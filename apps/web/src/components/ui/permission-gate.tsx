'use client';

import type { PermissionKey, TenantModuleKey } from '@ngao360/shared';
import { PackageX, ShieldOff } from 'lucide-react';
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

/**
 * Page-level guard for tenant modules (e.g. NGAO360 Office). Shows a plain
 * message when the organisation has the module switched off. Presentation
 * only: the API answers 403 MODULE_DISABLED.
 */
export function RequireModuleEnabled({ module, children }: { module: TenantModuleKey; children: ReactNode }) {
  const { moduleEnabled, loading } = useAuth();
  if (loading) return null;
  if (!moduleEnabled(module)) {
    return (
      <div className="ngao-card">
        <EmptyState
          icon={PackageX}
          title="This module is not enabled for your organisation"
          description="An organisation owner can switch it on in workspace settings."
        />
      </div>
    );
  }
  return <>{children}</>;
}
