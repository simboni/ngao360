'use client';

import {
  hasModuleAccess,
  type MeResponse,
  type PermissionKey,
  type PermissionModule,
  TENANT_MODULE_KEYS,
  type TenantModuleKey,
} from '@ngao360/shared';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from './api-client';

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
    try {
      await api.post('/auth/logout', undefined, { noRefresh: true });
    } finally {
      setMe(null);
      router.replace('/login');
    }
  }, [router]);

  const value = useMemo<AuthState>(() => {
    const perms = new Set<string>(me?.permissions ?? []);
    const modules = new Set<string>(me?.modules ?? []);
    const isTenantModule = (m: string): m is TenantModuleKey => (TENANT_MODULE_KEYS as readonly string[]).includes(m);
    return {
      me,
      loading,
      can: (p) => perms.has(p),
      canAny: (ps) => ps.some((p) => perms.has(p)),
      canAccessModule: (m) => hasModuleAccess(perms, m) && (!isTenantModule(m) || modules.has(m)),
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
