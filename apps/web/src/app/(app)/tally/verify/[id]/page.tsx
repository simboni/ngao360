import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Verification' };

/** S20 Verification workspace (second-person review). API §5.4. */
export default async function VerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Verification"
      screen="S20 Verification workspace"
      description={`Independently compare the original image with captured values for submission ${id}. You cannot verify your own submission.`}
      breadcrumbs={[{ label: 'NGAO TALLY' }, { label: 'Verification queue', href: '/tally/inbox?view=awaiting_me' }, { label: 'Verify' }]}
      anyOf={['tally.verify', 'tally.approve']}
    />
  );
}
