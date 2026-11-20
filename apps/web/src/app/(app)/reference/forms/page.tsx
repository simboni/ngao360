import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Form templates' };

/** Form-template registry (S30 form versions). API §4.7. */
export default function FormsPage() {
  return (
    <ModulePlaceholder
      title="Form templates"
      screen="Form-template registry"
      description="Versioned templates for Forms 34A–39D, each linked to its official source, version and effective date."
      breadcrumbs={[{ label: 'Reference data' }, { label: 'Form templates' }]}
      anyOf={['forms.view']}
    />
  );
}
