import { ReauthProvider } from '@/components/admin/reauth';
import { TemplateView } from '@/components/reports/template-view';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Report' };

/** S28 Saved report: owner, sharing, classification, preview and export. API §28. */
export default async function ReportTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['reports.view', 'reports.build']}>
      <ReauthProvider>
        <TemplateView id={id} />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
