import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Report' };

/** S28 Saved report. */
export default async function ReportTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Report"
      screen="S28 Saved report"
      description={`Saved report ${id}: definition, owner, sharing scope, classification, preview and export (sensitive exports need re-authentication and are recorded).`}
      breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Report' }]}
      anyOf={['reports.view', 'reports.build']}
    />
  );
}
