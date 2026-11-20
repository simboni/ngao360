'use client';

import type { OfficeGeography, OfficePrivacyNotices, UserRef } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

/**
 * Office form-support reads (API contract §9a). They work whether or not the
 * public portal is switched on.
 */
export const officeApi = {
  geography: () => api.get<OfficeGeography>('/office/geography'),
  privacyNotices: () => api.get<OfficePrivacyNotices>('/office/privacy-notice'),
  assignableOfficers: (caseId: string) => api.get<UserRef[]>(`/office/cases/${encodeURIComponent(caseId)}/assignable-officers`),
};

/** Permissions that open GET /office/geography (any Office view). */
export const OFFICE_GEOGRAPHY_PERMISSIONS = [
  'office.cases.view',
  'office.cases.create',
  'office.projects.view',
  'office.correspondence.view',
  'office.appointments.view',
  'office.meetings.view',
] as const;

/** Permissions that open GET /office/privacy-notice. */
export const OFFICE_NOTICE_PERMISSIONS = ['office.cases.create', 'office.appointments.manage', 'office.cases.view', 'office.appointments.view'] as const;

/** The office county's constituencies and wards, or null while loading or when unavailable. */
export function useOfficeGeography(): OfficeGeography | null {
  const { canAny } = useAuthAny();
  const allowed = canAny(OFFICE_GEOGRAPHY_PERMISSIONS);
  const [geo, setGeo] = useState<OfficeGeography | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    officeApi
      .geography()
      .then((g) => alive && setGeo(g))
      .catch(() => alive && setGeo(null));
    return () => {
      alive = false;
    };
  }, [allowed]);
  return geo;
}

/** The office's current privacy notices built from its configuration, or null when unavailable. */
export function useOfficePrivacyNotices(): OfficePrivacyNotices | null {
  const { canAny } = useAuthAny();
  const allowed = canAny(OFFICE_NOTICE_PERMISSIONS);
  const [notices, setNotices] = useState<OfficePrivacyNotices | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    officeApi
      .privacyNotices()
      .then((n) => alive && setNotices(n))
      .catch(() => alive && setNotices(null));
    return () => {
      alive = false;
    };
  }, [allowed]);
  return notices;
}

function useAuthAny() {
  const { can } = useAuth();
  return { canAny: (keys: readonly string[]) => keys.some((k) => can(k as Parameters<typeof can>[0])) };
}
