'use client';

import { RadioTower } from 'lucide-react';
import Link from 'next/link';
import { useAsync } from '@/components/tally/use-async';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { fieldApi } from './common/field-api';
import { share } from './common/field-model';

/**
 * Command-centre card for field operations (blueprint 4): station coverage,
 * readiness and open incidents with their denominators. Mount it on the
 * dashboard (owned by the admin UI; see docs/CHANGE_REQUESTS.md, Field web).
 * Renders nothing without the field module or a field view permission.
 */
export function FieldDashboardCard() {
  const { can, moduleEnabled } = useAuth();
  const on = moduleEnabled('field');
  const readiness = useAsync(() => fieldApi.readinessSummary({}), [], on && can('field.readiness.view'));
  const incidents = useAsync(() => fieldApi.incidents({ view: 'open', pageSize: 1 }), [], on && can('field.incidents.view'));
  if (!on || (!can('field.readiness.view') && !can('field.incidents.view'))) return null;
  const r = readiness.data;
  const ready = r?.byStatus.find((b) => b.status === 'READY')?.count ?? 0;
  return (
    <Card>
      <CardHeader
        title="Field operations"
        description={r ? `Approved-registry stations in your scope, as of ${formatDateTime(r.asOf)}` : undefined}
        actions={
          can('warroom.view') && moduleEnabled('tally') ? (
            <Link href="/warroom" className="inline-flex items-center gap-1 text-meta font-medium text-teal hover:underline">
              <RadioTower className="h-4 w-4" aria-hidden /> War Room
            </Link>
          ) : null
        }
      />
      <CardBody>
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {r ? (
            <>
              <Fig label="Stations ready" value={`${ready} of ${r.expectedStations}`} hint={share(ready, r.expectedStations)} href="/field/readiness" />
              <Fig label="Stations without an agent" value={`${r.stationsWithoutAgent} of ${r.expectedStations}`} hint="Not assigned" href="/field/deployment" />
              <Fig label="Agents deployed" value={String(r.agentsDeployed)} hint={`${r.agentsAccredited} accredited`} href="/field/agents" />
            </>
          ) : null}
          {incidents.data ? <Fig label="Open incidents" value={String(incidents.data.total)} hint="Incident desk" href="/field/incidents" /> : null}
        </dl>
      </CardBody>
    </Card>
  );
}

function Fig({ label, value, hint, href }: { label: string; value: string; hint: string; href: string }) {
  return (
    <div>
      <dt className="text-meta text-slate">{label}</dt>
      <dd className="text-[22px] font-semibold tabular-nums text-navy">{value}</dd>
      <Link href={href} className="text-meta text-teal hover:underline">
        {hint}
      </Link>
    </div>
  );
}
