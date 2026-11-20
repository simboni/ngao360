import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Breach register' };

/** Data breach register. */
export default function BreachRegisterPage() {
  return (
    <ModulePlaceholder
      title="Breach register"
      screen="Data breach register"
      description="Breaches and drills with detect, contain, preserve evidence, assess, notify, remediate and lessons steps, and an exportable timeline. Categories and counts only. API §30."
      breadcrumbs={[{ label: 'Administration' }, { label: 'Breach register' }]}
      anyOf={['security.breach.view']}
    />
  );
}
