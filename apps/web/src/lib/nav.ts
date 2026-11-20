import type { PermissionKey, PermissionModule } from '@ngao360/shared';
import {
  AlertTriangle,
  BarChart3,
  ClipboardCheck,
  FileStack,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MapPin,
  ScrollText,
  ShieldCheck,
  Users,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown when the user holds ANY of these permissions. */
  anyOf: PermissionKey[];
}

export interface NavGroup {
  label: string;
  /** Whole group hidden without access to this module (blueprint 2.2 navigation rule). */
  module?: PermissionModule;
  items: NavItem[];
}

/**
 * Sidebar navigation. Items are filtered by permission; a user without results
 * permissions never sees NGAO TALLY. Module agents add items to their own group.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, anyOf: ['dashboard.view'] }],
  },
  {
    label: 'NGAO TALLY',
    module: 'tally',
    items: [
      { label: 'Form inbox', href: '/tally/inbox', icon: Inbox, anyOf: ['tally.submit', 'tally.capture', 'tally.verify', 'tally.approve'] },
      { label: 'Verification queue', href: '/tally/inbox?view=awaiting_me', icon: ClipboardCheck, anyOf: ['tally.verify'] },
      { label: 'Supervisor queue', href: '/tally/inbox?view=awaiting_supervisor', icon: ClipboardCheck, anyOf: ['tally.approve'] },
      { label: 'Parallel tally', href: '/tally/results', icon: BarChart3, anyOf: ['tally.results.view'] },
      { label: 'Discrepancies', href: '/tally/discrepancies', icon: AlertTriangle, anyOf: ['tally.discrepancy.view'] },
    ],
  },
  {
    label: 'Reference data',
    items: [
      { label: 'Station registry', href: '/reference/stations', icon: MapPin, anyOf: ['reference.view'] },
      { label: 'Form templates', href: '/reference/forms', icon: FileStack, anyOf: ['forms.view'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', href: '/admin/users', icon: Users, anyOf: ['users.view'] },
      { label: 'Roles', href: '/admin/roles', icon: ShieldCheck, anyOf: ['roles.view'] },
      { label: 'Audit log', href: '/admin/audit', icon: ScrollText, anyOf: ['audit.view'] },
    ],
  },
];

export function visibleNav(
  can: (p: PermissionKey) => boolean,
  canAccessModule: (m: PermissionModule) => boolean,
): NavGroup[] {
  return NAV_GROUPS.filter((g) => !g.module || canAccessModule(g.module))
    .map((g) => ({ ...g, items: g.items.filter((i) => i.anyOf.some((p) => can(p))) }))
    .filter((g) => g.items.length > 0);
}
