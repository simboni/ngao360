import type { PermissionKey } from '@ngao360/shared';
import { Construction } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { type Crumb, PageHeader } from '@/components/ui/page-header';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** Temporary page body used until a module agent implements the screen. */
export function ModulePlaceholder({
  title,
  screen,
  description,
  breadcrumbs,
  anyOf,
  children,
}: {
  title: string;
  screen: string;
  description: string;
  breadcrumbs: Crumb[];
  anyOf: PermissionKey[];
  children?: ReactNode;
}) {
  return (
    <RequirePagePermission anyOf={anyOf}>
      <PageHeader title={title} description={description} breadcrumbs={breadcrumbs} />
      {children}
      <Card>
        <EmptyState icon={Construction} title={`${screen} is being built`} description="This screen will appear here once its module is implemented." />
      </Card>
    </RequirePagePermission>
  );
}
