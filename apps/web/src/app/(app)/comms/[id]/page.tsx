import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Content item' };

/** Communications content item. */
export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Content item"
      screen="Communications content item"
      description={`Content ${id}: text, audience category, author, editor, approver, publication time and the revision and correction history.`}
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Communications', href: '/comms' }, { label: 'Content item' }]}
      anyOf={['comms.content.view']}
    />
  );
}
