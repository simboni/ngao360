import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Case workspace' };

/** S25 Case workspace. API §11. */
export default async function CaseWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ModulePlaceholder
      title="Case workspace"
      screen="S25 Case workspace"
      description={`Case ${id}: timeline, public updates, internal notes, assignee, referral, review date, evidence, close and reopen.`}
      breadcrumbs={[{ label: 'Office' }, { label: 'Citizen cases', href: '/office/cases' }, { label: 'Case' }]}
      anyOf={['office.cases.view']}
    />
  );
}
