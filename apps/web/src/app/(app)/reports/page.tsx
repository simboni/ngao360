import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Reports' };

/** S28 Report builder. */
export default function ReportsPage() {
  return (
    <ModulePlaceholder
      title="Reports"
      screen="S28 Report builder"
      description="Standard reports catalogue and the report builder: approved dataset, permitted fields, filters, area and date range, preview, saved templates with owner and sharing, and exports with generation time, filters and classification. API §28."
      breadcrumbs={[{ label: 'Reports' }]}
      anyOf={['reports.view', 'reports.build']}
    />
  );
}
