'use client';

/**
 * S02 entry: a platform operator (platform.tenants.manage in the platform organisation) creates
 * organisations; an organisation's owner completes its own profile and data protection.
 */
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { CreateWorkspaceWizard } from './create-workspace-wizard';
import { OrganisationSetup } from './organisation-setup';

export function WorkspaceSetup() {
  const { can, me } = useAuth();
  const operator = can('platform.tenants.manage') && me?.tenant.type === 'PLATFORM';
  return (
    <>
      <PageHeader
        title={operator ? 'Create an organisation' : 'Workspace setup'}
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Workspace setup' }]}
        description={
          operator
            ? 'Create an organisation workspace and invite its first administrators. Invitations go to them directly once e-mail delivery is configured.'
            : 'Complete your organisation profile and data-protection details, then follow the next steps.'
        }
      />
      {operator ? <CreateWorkspaceWizard /> : <OrganisationSetup />}
    </>
  );
}
