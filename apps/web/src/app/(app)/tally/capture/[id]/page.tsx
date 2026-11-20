import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Form capture' };

/** S19 Form capture (split view: queue, original image, metadata + fields). API §5.2. */
export default async function CapturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Form capture"
      screen="S19 Form capture"
      description={`Capture metadata and figures for submission ${id}. The original image is never hidden or overwritten.`}
      breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Form inbox', href: '/tally/inbox' }, { label: 'Capture' }]}
      anyOf={['tally.capture']}
    />
  );
}
