import type { PermissionKey, PermissionModule } from '@ngao360/shared';
import {
  Banknote,
  Bell,
  Building2,
  CalendarDays,
  FileWarning,
  ListTodo,
  Megaphone,
  SlidersHorizontal,
  AlertTriangle,
  ClipboardList,
  RadioTower,
  Smartphone,
  TriangleAlert,
  UserRoundCheck,
  BarChart3,
  CalendarClock,
  FolderKanban,
  LifeBuoy,
  Mail,
  ClipboardCheck,
  FileStack,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MapPin,
  ScrollText,
  ShieldCheck,
  Users,
  EyeOff,
  ListChecks,
  Settings,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown when the user holds ANY of these permissions. */
  anyOf: PermissionKey[];
  /** Item hidden without access to this module (for groups mixing modules, e.g. Campaign). */
  module?: PermissionModule;
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
    items: [
      {
        label: 'Dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        // Office staff see the Office overview there (office KPIs scoped by their own permissions).
        anyOf: ['dashboard.view', 'office.correspondence.view', 'office.appointments.view', 'office.meetings.view', 'office.cases.view', 'office.projects.view'],
      },
      { label: 'Notifications', href: '/notifications', icon: Bell, anyOf: ['notifications.view'] },
    ],
  },
  {
    // Campaign and organisation (blueprint 2.2). Each item needs the tenant's `campaign`
    // module and its own permission family; finance is separate (operations roles never see it).
    label: 'Campaign',
    items: [
      { label: 'Tasks', href: '/tasks', icon: ListTodo, anyOf: ['tasks.view'], module: 'tasks' },
      { label: 'Events', href: '/events', icon: CalendarDays, anyOf: ['events.view'], module: 'events' },
      { label: 'Communications', href: '/comms', icon: Megaphone, anyOf: ['comms.content.view'], module: 'comms' },
      { label: 'Finance', href: '/finance', icon: Banknote, anyOf: ['finance.view'], module: 'finance' },
      { label: 'Finance settings', href: '/finance/settings', icon: SlidersHorizontal, anyOf: ['finance.settings.manage'], module: 'finance' },
    ],
  },
  {
    label: 'Organisation',
    module: 'org',
    items: [{ label: 'Departments and teams', href: '/org', icon: Building2, anyOf: ['org.departments.view', 'org.teams.view'] }],
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
      // Display holds and redacted copies: owner field-pin
      { label: 'Display holds', href: '/tally/sources/holds', icon: EyeOff, anyOf: ['tally.source.download', 'tally.approve'] },
    ],
  },
  {
    // NGAO360 Office (blueprint 2.2). Hidden unless the tenant has the office module on
    // and the user holds an office permission (canAccessModule checks both).
    label: 'Office',
    module: 'office',
    items: [
      { label: 'Correspondence', href: '/office/correspondence', icon: Mail, anyOf: ['office.correspondence.view'] },
      { label: 'Appointments', href: '/office/appointments', icon: CalendarClock, anyOf: ['office.appointments.view', 'office.meetings.view'] },
      { label: 'Citizen cases', href: '/office/cases', icon: LifeBuoy, anyOf: ['office.cases.view'] },
      { label: 'Projects', href: '/office/projects', icon: FolderKanban, anyOf: ['office.projects.view'] },
    ],
  },
  {
    // Field and election operations (blueprint 6). Hidden unless the tenant has
    // the field module on and the user holds a field permission.
    label: 'Field operations',
    module: 'field',
    items: [
      { label: 'Agents', href: '/field/agents', icon: UserRoundCheck, anyOf: ['field.agents.view'] },
      { label: 'Deployment', href: '/field/deployment', icon: MapPin, anyOf: ['field.deployment.view'] },
      { label: 'Readiness', href: '/field/readiness', icon: ClipboardList, anyOf: ['field.readiness.view'] },
      { label: 'Incidents', href: '/field/incidents', icon: TriangleAlert, anyOf: ['field.incidents.view'] },
      { label: 'Field app', href: '/m', icon: Smartphone, anyOf: ['field.reports.submit', 'field.incidents.report', 'field.deployment.checkin'] },
    ],
  },
  {
    // Election-day War Room (blueprint 7): needs the field AND tally modules.
    label: 'Election day',
    module: 'warroom',
    items: [{ label: 'War Room', href: '/warroom', icon: RadioTower, anyOf: ['warroom.view'] }],
  },
  {
    // Report builder and standard reports (blueprint 10.1, 10.2). Datasets carry their own module gates.
    label: 'Reports',
    items: [{ label: 'Reports', href: '/reports', icon: BarChart3, anyOf: ['reports.view', 'reports.build'] }],
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
      { label: 'Breach register', href: '/security/breaches', icon: FileWarning, anyOf: ['security.breach.view'] },
      // Pilot hardening (S30, S03): owner workspace-admin
      { label: 'System settings', href: '/settings', icon: Settings, anyOf: ['workspace.view', 'workspace.configure'] },
      { label: 'Onboarding', href: '/onboarding', icon: ListChecks, anyOf: ['workspace.configure'] },
    ],
  },
];

export function visibleNav(
  can: (p: PermissionKey) => boolean,
  canAccessModule: (m: PermissionModule) => boolean,
): NavGroup[] {
  return NAV_GROUPS.filter((g) => !g.module || canAccessModule(g.module))
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.module || canAccessModule(i.module)) && i.anyOf.some((p) => can(p))) }))
    .filter((g) => g.items.length > 0);
}
