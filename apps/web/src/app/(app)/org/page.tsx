import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Organisation' };

/** S05 Organisation tree. */
export default function OrgPage() {
  return (
    <ModulePlaceholder
      title="Organisation"
      screen="S05 Organisation tree"
      description="Department tree with lead, parent and child departments, budget code, active dates and visibility; team cards with coordinator, members, area and contact channel; edit drawer. API §23."
      breadcrumbs={[{ label: 'Organisation' }]}
      anyOf={['org.departments.view', 'org.teams.view']}
    />
  );
}
