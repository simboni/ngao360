import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata = { title: 'Finance settings' };

/** Finance limit settings. */
export default function FinanceSettingsPage() {
  return (
    <ModulePlaceholder
      title="Finance settings"
      screen="Finance limit settings"
      description="Accounts, categories and limit settings: single-source contribution cap, spending limits and reporting deadlines per election period, each with effective dates, legal source note, verified flag and enforcement. Unverified settings are labelled Unverified – configure to the applicable law. API §27.6."
      breadcrumbs={[{ label: 'Campaign' }, { label: 'Finance', href: '/finance' }, { label: 'Settings' }]}
      anyOf={['finance.settings.manage', 'finance.view']}
    />
  );
}
