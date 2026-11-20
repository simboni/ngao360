import type { PermissionKey } from '@ngao360/shared';
import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { RequirePagePermission } from '@/components/ui/permission-gate';

/** Temporary mobile screen body until the mobile agent implements it. */
export function MobilePlaceholder({ title, description, anyOf }: { title: string; description: string; anyOf: PermissionKey[] }) {
  const body = (
    <section aria-labelledby="m-title">
      <h1 id="m-title" className="mb-3 text-[20px] font-semibold text-navy">
        {title}
      </h1>
      <div className="ngao-card">
        <EmptyState icon={Construction} title={`${title} is being built`} description={description} />
      </div>
    </section>
  );
  return anyOf.length > 0 ? <RequirePagePermission anyOf={anyOf}>{body}</RequirePagePermission> : body;
}
