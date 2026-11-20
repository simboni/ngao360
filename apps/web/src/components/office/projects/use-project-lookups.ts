'use client';

import type { Institution } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { projectsApi } from './projects-api';

export interface ProjectGeography {
  countyName: string | null;
  constituencies: Array<{ id: string; name: string }>;
  wards: Array<{ id: string; name: string; constituencyId: string }>;
}

/** Constituencies and wards of the office county (see `projectsApi.portalGeography`). Null when unavailable. */
export function useProjectGeography(): ProjectGeography | null {
  const { me } = useAuth();
  const [geo, setGeo] = useState<ProjectGeography | null>(null);
  const slug = me?.tenant.slug;
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    projectsApi
      .portalGeography(slug)
      .then((info) => alive && setGeo({ countyName: null, constituencies: info.constituencies, wards: info.wards }))
      .catch(() => alive && setGeo(null));
    return () => {
      alive = false;
    };
  }, [slug]);
  return geo;
}

/** Options for a ward / constituency select: constituency then its wards. */
export function unitOptions(geo: ProjectGeography | null): Array<{ value: string; label: string }> {
  if (!geo) return [];
  return geo.constituencies.flatMap((c) => [
    { value: c.id, label: `${c.name} (constituency)` },
    ...geo.wards.filter((w) => w.constituencyId === c.id).map((w) => ({ value: w.id, label: `— ${w.name}` })),
  ]);
}

/** Institution registry (all, including inactive, so existing projects still resolve). */
export function useInstitutions(): Institution[] {
  const [items, setItems] = useState<Institution[]>([]);
  useEffect(() => {
    let alive = true;
    Promise.all([projectsApi.institutions({ active: 'true' }), projectsApi.institutions({ active: 'false' }).catch(() => null)])
      .then(([a, b]) => alive && setItems([...a.items, ...(b?.items ?? [])].sort((x, y) => x.name.localeCompare(y.name))))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);
  return items;
}
