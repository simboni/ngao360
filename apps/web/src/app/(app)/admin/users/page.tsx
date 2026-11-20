import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Users' };

/** S06 User directory. API §6.1. */
export default function UsersPage() {
  return (
    <ModulePlaceholder
      title="Users"
      screen="S06 User directory"
      description="Search, filters, status, role chips, invite, suspend, reset MFA and access review."
      breadcrumbs={[{ label: 'Administration' }, { label: 'Users' }]}
      anyOf={['users.view']}
    />
  );
}
