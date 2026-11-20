'use client';

/**
 * Saved report (S28 /reports/[id]): owner, sharing scope, classification and
 * runnability, then the builder seeded with the definition. A shared template
 * runs with the caller's own permissions and scope. Owners can archive it
 * (never deleted).
 */
import { REPORT_TEMPLATE_SCOPE_LABELS, type ReportTemplate } from '@ngao360/shared';
import { Archive, Lock, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ReasonDialog } from '@/components/admin/reauth';
import { Facts, SensitivityBadge } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { ReportBuilder } from './report-builder';
import { fromDefinition } from './report-model';
import { reportsApi } from './reports-api';

export function TemplateView({ id }: { id: string }) {
  const { me, can } = useAuth();
  const router = useRouter();
  const { data: tpl, error, loading, reload, setData } = useAsync(() => reportsApi.template(id), [id]);
  const [archiving, setArchiving] = useState(false);
  const initial = useMemo(() => (tpl ? fromDefinition(tpl.definition) : undefined), [tpl?.id, tpl?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !tpl) return <div className="h-64 animate-pulse rounded-card bg-surface" aria-busy="true" />;
  if (error && !tpl) {
    return (
      <>
        <PageHeader title="Report" breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Report' }]} />
        <Card>
          <EmptyState icon={ShieldOff} title="This report could not be opened" description={describeCampaignError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />
        </Card>
      </>
    );
  }
  if (!tpl) return null;
  const isOwner = tpl.owner.id === me?.user.id;

  return (
    <>
      <PageHeader
        title={tpl.name}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: tpl.name }]}
        status={<SensitivityBadge level={tpl.classification} />}
        description={tpl.description ?? undefined}
        actions={
          isOwner && can('reports.save') ? (
            <Button variant="secondary" onClick={() => setArchiving(true)}>
              <Archive className="h-4 w-4" aria-hidden />
              Archive
            </Button>
          ) : null
        }
      />
      <Card className="mb-4">
        <CardBody>
          <Facts
            items={[
              { label: 'Owner', value: tpl.owner.displayName },
              { label: 'Shared with', value: tpl.permissionScope === 'ROLES' ? `Roles: ${tpl.sharedRoleKeys.join(', ')}` : REPORT_TEMPLATE_SCOPE_LABELS[tpl.permissionScope] },
              { label: 'Dataset', value: tpl.definition.datasetKey },
              { label: 'From the standard catalogue', value: tpl.standardReportKey ?? 'No' },
              { label: 'Created', value: formatDateTime(tpl.createdAt) },
              { label: 'Updated', value: formatDateTime(tpl.updatedAt) },
            ]}
          />
        </CardBody>
      </Card>
      {!tpl.runnable ? (
        <Notice tone="sod" className="mb-4" title="You cannot run this template as saved">
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            It uses a dataset or field your permissions do not include. Fields you cannot use are removed below; the report runs with your own scope.
          </span>
        </Notice>
      ) : (
        <Notice tone="info" className="mb-4">
          This report runs with your permissions, departments and areas{isOwner ? '' : `, not ${tpl.owner.displayName}'s`}.
        </Notice>
      )}
      <ReportBuilder
        initial={initial}
        initialStep="preview"
        template={tpl}
        onTemplateSaved={(t: ReportTemplate) => {
          if (t.id === tpl.id) setData(t);
          else router.push(`/reports/${t.id}`);
        }}
      />
      <ReasonDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title="Archive this template"
        description="It disappears from template lists for everyone. It is kept, not deleted, and the archive is audited."
        confirmLabel="Archive"
        tone="danger"
        onConfirm={async (reason) => {
          await reportsApi.archiveTemplate(tpl.id, reason);
          router.push('/reports');
        }}
      />
    </>
  );
}
