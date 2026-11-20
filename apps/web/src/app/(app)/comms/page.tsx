import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Communications' };

/** Communications content. */
export default function CommsPage() {
  return (
    <ModulePlaceholder
      title="Communications"
      screen="Communications content"
      description="Notices, press releases, bulletins, website updates and event information through draft, editorial review, approval, publication and archive. Audience categories only: no recipient lists, voter targeting or bulk messaging. API §26."
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Communications' }]}
      anyOf={['comms.content.view']}
    />
  );
}
