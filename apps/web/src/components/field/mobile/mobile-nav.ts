import type { PermissionKey } from '@ngao360/shared';
import { ClipboardList, FileUp, Home, MapPinCheck, type LucideIcon, TriangleAlert } from 'lucide-react';

export interface MobileNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown when the user holds ANY of these permissions (empty = always). */
  anyOf: PermissionKey[];
  /** Tenant module the item also needs (forms need NGAO TALLY). */
  module?: 'tally';
}

/**
 * Bottom navigation of the mobile PWA (blueprint 11.3). Items are hints only:
 * the API checks every request. An agent works on their own station(s):
 * station-scoped grants (by station code) limit what the API accepts.
 */
export const MOBILE_NAV: MobileNavItem[] = [
  { label: 'Home', href: '/m', icon: Home, anyOf: [] },
  { label: 'Report', href: '/m/report', icon: ClipboardList, anyOf: ['field.reports.submit'] },
  { label: 'Incident', href: '/m/incident', icon: TriangleAlert, anyOf: ['field.incidents.report'] },
  { label: 'Check in', href: '/m/checkin', icon: MapPinCheck, anyOf: ['field.deployment.checkin'] },
  { label: 'Forms', href: '/m/forms', icon: FileUp, anyOf: ['tally.submit'], module: 'tally' },
];

/** Permissions that make the mobile app useful at all. */
export const MOBILE_PERMISSIONS: PermissionKey[] = ['field.reports.submit', 'field.incidents.report', 'field.deployment.checkin'];

export function visibleMobileNav(can: (p: PermissionKey) => boolean, moduleEnabled: (m: 'tally') => boolean): MobileNavItem[] {
  return MOBILE_NAV.filter((i) => (i.anyOf.length === 0 || i.anyOf.some((p) => can(p))) && (!i.module || moduleEnabled(i.module)));
}
