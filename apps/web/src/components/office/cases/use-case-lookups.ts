'use client';

import type { Paginated, PrivacyNotice, UserRef, UserSummary } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { officeApi, useOfficeGeography, useOfficePrivacyNotices } from '../office-api';

export interface CaseGeography {
  constituencies: Array<{ id: string; name: string }>;
  wards: Array<{ id: string; name: string; constituencyId: string }>;
  /** The office's current portal privacy notice (read to walk-in requesters); null when unavailable. */
  privacyNotice: PrivacyNotice | null;
}

/**
 * Constituencies and wards of the office's county, for filters and forms, plus
 * the portal privacy notice. Reads GET /office/geography and
 * GET /office/privacy-notice, so it works with the public portal switched off.
 * Returns null while the geography is unavailable.
 */
export function useCaseGeography(): CaseGeography | null {
  const geo = useOfficeGeography();
  const notices = useOfficePrivacyNotices();
  if (!geo) return null;
  return { constituencies: geo.constituencies, wards: geo.wards, privacyNotice: notices?.portal ?? null };
}

const OFFICER_ROLE_KEYS = ['CASE_OFFICER', 'OFFICE_ADMINISTRATOR'];

/**
 * Officers who can be offered as assignees: with a case id, the active users
 * holding `office.cases.manage` over the case location
 * (GET /office/cases/:id/assignable-officers); otherwise, for holders of
 * `users.view`, active users with a case-handling role. The caller and anyone
 * already assigned are always offered. The API re-checks the assignee.
 */
export function useAssignableOfficers(extra: Array<UserRef | null | undefined> = [], caseId?: string): UserRef[] {
  const { me, can } = useAuth();
  const [directory, setDirectory] = useState<UserRef[]>([]);
  const canList = can('users.view');
  const canManage = can('office.cases.manage');
  useEffect(() => {
    let alive = true;
    if (caseId && canManage) {
      officeApi
        .assignableOfficers(caseId)
        .then((users) => alive && setDirectory(users))
        .catch(() => alive && setDirectory([]));
      return () => {
        alive = false;
      };
    }
    if (!canList) return;
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
  }, [canList, canManage, caseId]);

  const out = new Map<string, UserRef>();
  if (me) out.set(me.user.id, { id: me.user.id, displayName: `${me.user.displayName} (me)` });
  for (const u of [...directory, ...extra]) if (u && !out.has(u.id)) out.set(u.id, u);
  return [...out.values()].sort((a, b) => (a.id === me?.user.id ? -1 : b.id === me?.user.id ? 1 : a.displayName.localeCompare(b.displayName)));
}
