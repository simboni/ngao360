import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Audit log' };

/** S29 Audit log. API §6.4. */
export default function AuditPage() {
  return (
    <ModulePlaceholder
      title="Audit log"
      screen="S29 Audit log"
      description="Actor, action, entity, timestamp, IP/device metadata, before/after hashes, export and retention hold."
      breadcrumbs={[{ label: 'Administration' }, { label: 'Audit log' }]}
      anyOf={['audit.view']}
    />
  );
}
