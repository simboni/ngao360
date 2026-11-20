'use client';

import { Bell, LogOut, Menu, Search, UserCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-line bg-surface px-4">
      <button type="button" className="rounded-lg p-2 hover:bg-cloud md:hidden" onClick={onMenu} aria-label="Open navigation">
        <Menu className="h-5 w-5" />
      </button>

      <div className="min-w-0">
        <p className="truncate text-meta text-slate">Workspace</p>
        <p className="truncate text-body font-semibold text-ink">{me?.tenant.name ?? '…'}</p>
      </div>

      <div className="ml-auto hidden max-w-sm flex-1 md:block">
        <label className="relative block">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" aria-hidden />
          <input type="search" placeholder="Search (coming soon)" disabled className="ngao-input pl-9" />
        </label>
      </div>

      <button type="button" className="relative rounded-lg p-2 text-slate hover:bg-cloud hover:text-ink" aria-label="Notifications">
        <Bell className="h-5 w-5" />
      </button>

      <div className="relative">
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-cloud"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <UserCircle2 className="h-7 w-7 text-deep-blue" aria-hidden />
          <span className="hidden text-left md:block">
            <span className="block text-body font-medium leading-4 text-ink">{me?.user.displayName}</span>
            <span className="block text-meta text-slate">{me?.roles.map((r) => r.name).join(', ')}</span>
          </span>
        </button>
        {open ? (
          <div role="menu" className="ngao-card absolute right-0 mt-2 w-56 p-1">
            <div className="px-3 py-2 text-meta text-slate">{me?.user.email}</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => void logout()}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-body hover:bg-cloud"
            >
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
