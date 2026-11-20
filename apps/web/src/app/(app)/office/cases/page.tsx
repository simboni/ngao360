import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Citizen cases' };

/** Citizen case list (S25 entry point). API §11. Owner: cases agent (components/office/cases). */
export default function CasesPage() {
  return (
    <ModulePlaceholder
      title="Citizen cases"
      screen="Case list"
      description="Service requests and issue reports from the public portal and walk-ins, by stage, ward, assignee and review date."
      breadcrumbs={[{ label: 'Office' }, { label: 'Citizen cases' }]}
      anyOf={['office.cases.view']}
    />
  );
}
