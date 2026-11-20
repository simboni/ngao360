'use client';

import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { visibleNav } from '@/lib/nav';

export function Sidebar({
  collapsed,
  onToggle,
  mobileOpen,
  onNavigate,
}: {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onNavigate: () => void;
}) {
  const pathname = usePathname() ?? '';
  const { can, canAccessModule, me } = useAuth();
  const groups = me ? visibleNav(can, canAccessModule) : [];

  return (
    <aside
      aria-label="Primary"
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex flex-col bg-navy text-white transition-[width,transform] duration-200',
        collapsed ? 'md:w-sidebar-collapsed' : 'md:w-sidebar',
        'w-sidebar',
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}
    >
      <div className="flex h-topbar items-center gap-3 border-b border-white/10 px-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal font-bold" aria-hidden>
          N
        </span>
        <span className={cn('text-[17px] font-semibold tracking-tight', collapsed && 'md:sr-only')}>NGAO360</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <div key={group.label} className="mb-5">
            <p className={cn('mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-white/50', collapsed && 'md:sr-only')}>
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const base = item.href.split('?')[0]!;
                const active = pathname === base || pathname.startsWith(`${base}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      title={collapsed ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex h-10 items-center gap-3 rounded-lg px-2 text-body transition-colors',
                        active ? 'bg-deep-blue text-white shadow-[inset_3px_0_0_0_rgb(var(--ngao-teal))]' : 'text-white/80 hover:bg-white/5 hover:text-white',
                        collapsed && 'md:justify-center',
                      )}
                    >
                      <Icon className="h-5 w-5 shrink-0" aria-hidden />
                      <span className={cn('truncate', collapsed && 'md:sr-only')}>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={onToggle}
        className="hidden h-12 items-center gap-2 border-t border-white/10 px-5 text-meta text-white/70 hover:text-white md:flex"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        <span className={cn(collapsed && 'sr-only')}>Collapse</span>
      </button>
    </aside>
  );
}
