import { PublicPlaceholder } from '@/components/office/public/public-shell';

export const metadata = { title: 'Track a request' };

/** Track a request by public reference and tracking code. API §13.3. Owner: cases agent. */
export default function PublicTrackPage() {
  return (
    <PublicPlaceholder
      title="Track a request"
      description="Enter the reference and tracking code you received to see the current stage and public updates."
    />
  );
}
