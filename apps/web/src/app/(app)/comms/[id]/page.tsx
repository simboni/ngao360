import { ReauthProvider } from '@/components/admin/reauth';
import { ContentDetailView } from '@/components/comms/content-detail';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Content item' };

/** Communications content item: text, workflow and revision history. API §26. */
export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['comms.content.view']}>
      <ReauthProvider>
        <ContentDetailView id={id} />
      </ReauthProvider>
    </RequirePagePermission>
  );
}
