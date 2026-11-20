import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Roles' };

/** S07 Role editor. API §6.2–6.3. */
export default function RolesPage() {
  return (
    <ModulePlaceholder
      title="Roles"
      screen="S07 Role editor"
      description="Permission matrix, module toggles, geography scope, export permission, expiry and effective-access preview."
      breadcrumbs={[{ label: 'Administration' }, { label: 'Roles' }]}
      anyOf={['roles.view']}
    />
  );
}
