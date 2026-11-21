'use client';

import {
  hasModuleAccess,
  type MeResponse,
  type PermissionKey,
  type PermissionModule,
  PERMISSION_MODULE_TENANT_MODULES,
  type TenantModuleKey,
} from '@ngao360/shared';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from './api-client';
import { clearOfflineDataForSignOut } from './offline/device';
import { releasePushForSignOut } from '../components/account/push-model';

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  /** UI hint only: the API re-checks every request server-side. */
  can: (permission: PermissionKey) => boolean;
  canAny: (permissions: PermissionKey[]) => boolean;
  /**
   * Permission-module access for navigation: the user holds a permission of
   * the module AND, for tenant modules (tally, office), the tenant has the
   * module switched on.
   */
  canAccessModule: (module: PermissionModule) => boolean;
  /** Tenant module activation (from /auth/me `modules`). */
  moduleEnabled: (module: TenantModuleKey) => boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const reload = useCallback(async () => {
    try {
      setMe(await api.get<MeResponse>('/auth/me'));
    } catch (err) {
      setMe(null);
      if (err instanceof ApiRequestError && (err.status === 401 || err.code === 'MFA_REQUIRED')) {
        router.replace(`/login?next=${encodeURIComponent(pathname ?? '/dashboard')}`);
      }
    } finally {
      setLoading(false);
    }
  }, [router, pathname]);

  useEffect(() => {
    void reload();
    // Load once per mount; pathname changes do not require a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(async () => {
    // Before the session ends: this browser stops receiving this person's push notifications
    // (a shared field or office device must not show them to the next person).
    await releasePushForSignOut({
      storage: browserStorage(),
      revoke: (id) => api.delete(`/me/push/subscriptions/${id}`, { noRefresh: true }),
      getSubscription: async () => {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
        const reg = await navigator.serviceWorker.getRegistration();
        return reg?.pushManager ? reg.pushManager.getSubscription() : null;
      },
    }).catch(() => undefined);
    try {
      await api.post('/auth/logout', undefined, { noRefresh: true });
    } finally {
      // Sign-out on this device also removes the field app's encrypted offline
      // queue and its key (the callers warn about unsent items first).
      await clearOfflineDataForSignOut().catch(() => undefined);
      setMe(null);
      router.replace('/login');
    }
  }, [router]);

  const value = useMemo<AuthState>(() => {
    const perms = new Set<string>(me?.permissions ?? []);
    const modules = new Set<string>(me?.modules ?? []);
    // A permission module may need several tenant modules (the War Room needs field and tally).
    const tenantModulesOn = (m: string) => (PERMISSION_MODULE_TENANT_MODULES[m] ?? []).every((k) => modules.has(k));
    return {
      me,
      loading,
      can: (p) => perms.has(p),
      canAny: (ps) => ps.some((p) => perms.has(p)),
      canAccessModule: (m) => hasModuleAccess(perms, m) && tenantModulesOn(m),
      moduleEnabled: (m) => modules.has(m),
      reload,
      logout,
    };
  }, [me, loading, reload, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
