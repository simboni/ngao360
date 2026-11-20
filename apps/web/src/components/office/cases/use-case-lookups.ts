'use client';

import type { Paginated, PrivacyNotice, UserRef, UserSummary } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { casesApi } from './case-api';

export interface CaseGeography {
  constituencies: Array<{ id: string; name: string }>;
  wards: Array<{ id: string; name: string; constituencyId: string }>;
  /** The office's current portal privacy notice (read to walk-in requesters). */
  privacyNotice: PrivacyNotice;
}

/**
 * Constituencies and wards of the office's county, for filters and forms.
 * See `casesApi.portalGeography`. Returns null when unavailable.
 */
export function useCaseGeography(): CaseGeography | null {
  const { me } = useAuth();
  const [geo, setGeo] = useState<CaseGeography | null>(null);
  const slug = me?.tenant.slug;
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    casesApi
      .portalGeography(slug)
      .then((info) => alive && setGeo({ constituencies: info.constituencies, wards: info.wards, privacyNotice: info.privacyNotice }))
      .catch(() => alive && setGeo(null));
    return () => {
      alive = false;
    };
  }, [slug]);
  return geo;
}

const OFFICER_ROLE_KEYS = ['CASE_OFFICER', 'OFFICE_ADMINISTRATOR'];

/**
 * Officers who can be offered as assignees. There is no office-specific
 * lookup in the API contract yet (see docs/CHANGE_REQUESTS.md), so: the caller
 * themself, anyone already assigned in view, and, for holders of
 * `users.view`, active users with a case-handling role. The API still checks
 * that the assignee holds `office.cases.manage` over the case location.
 */
export function useAssignableOfficers(extra: Array<UserRef | null | undefined> = []): UserRef[] {
  const { me, can } = useAuth();
  const [directory, setDirectory] = useState<UserRef[]>([]);
  const canList = can('users.view');
  useEffect(() => {
    if (!canList) return;
    let alive = true;
    Promise.all(
      OFFICER_ROLE_KEYS.map((roleKey) =>
        api.get<Paginated<UserSummary>>('/admin/users', { query: { roleKey, status: 'ACTIVE', pageSize: 200 } }).catch(() => null),
      ),
    ).then((pages) => {
      if (!alive) return;
      const users = pages.flatMap((p) => p?.items ?? []).map((u) => ({ id: u.id, displayName: u.displayName }));
      setDirectory(users);
    });
    return () => {
      alive = false;
    };
  }, [canList]);

  const out = new Map<string, UserRef>();
  if (me) out.set(me.user.id, { id: me.user.id, displayName: `${me.user.displayName} (me)` });
  for (const u of [...directory, ...extra]) if (u && !out.has(u.id)) out.set(u.id, u);
  return [...out.values()].sort((a, b) => (a.id === me?.user.id ? -1 : b.id === me?.user.id ? 1 : a.displayName.localeCompare(b.displayName)));
}
