import { PublicPlaceholder } from '@/components/office/public/public-shell';

export const metadata = { title: 'Report an issue' };

/** S24 Citizen portal submission. API §13.2. Owner: cases agent (components/office/public). */
export default function PublicRequestPage() {
  return (
    <PublicPlaceholder
      title="Report an issue"
      description="Issue type, description, ward, optional photo and optional contact details, with the privacy notice shown before you submit."
    />
  );
}
