import { PublicPlaceholder } from '@/components/office/public/public-shell';

export const metadata = { title: 'Development projects' };

/** Public project list. API §13.4. Owner: projects agent. */
export default function PublicProjectsPage() {
  return (
    <PublicPlaceholder
      title="Development projects"
      description="Published projects with the responsible institution, the source of the commitment and whether completion has been independently verified."
    />
  );
}
