import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Election readiness' };

/** S15 Election readiness. API §18. */
export default function ReadinessPage() {
  return (
    <ModulePlaceholder
      title="Election readiness"
      screen="S15 Election readiness"
      description="Coverage cards with denominators: accreditation, materials, transport, communications and agent facilitation per station, training completion and stations without an agent."
      breadcrumbs={[{ label: 'Field operations' }, { label: 'Readiness' }]}
      anyOf={['field.readiness.view']}
    />
  );
}
