import { CaptureWorkspace } from '@/components/tally/capture-workspace';
import { RequirePagePermission } from '@/components/ui/permission-gate';

export const metadata = { title: 'Form capture' };

/** S19 Form capture (split view: queue, original image, metadata + fields). API §5.2. */
export default async function CapturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePagePermission anyOf={['tally.capture', 'tally.submit', 'tally.view']}>
      <CaptureWorkspace id={id} />
    </RequirePagePermission>
  );
}
