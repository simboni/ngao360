import { PublicPlaceholder } from '@/components/office/public/public-shell';

export const metadata = { title: 'Project' };

/** Public project view. API §13.4. Owner: projects agent. */
export default function PublicProjectPage() {
  return (
    <PublicPlaceholder
      title="Project"
      description="Approved public fields only. A commitment is not an approved project, and a photograph alone is not proof of completion."
    />
  );
}
