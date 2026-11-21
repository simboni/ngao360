'use client';

/**
 * S30 System settings: organisation (summary, edited on /setup), modules, integrations and job
 * status, data retention, security and the backup restore test, plus finance master data for
 * organisations with the campaign module. Every change is re-authenticated where the API asks
 * and lands in the audit log.
 */
import { ArrowRight, Banknote, Building2, ListChecks } from 'lucide-react';
import Link from 'next/link';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { PageHeader } from '@/components/ui/page-header';
import { workspaceApi } from '@/components/workspace/workspace-api';
import { describeWorkspaceError } from '@/components/workspace/workspace-model';
import { useAuth } from '@/lib/auth-context';
import { BackupPanel } from './backup-panel';
import { IntegrationsPanel } from './integrations-panel';
import { ModulesPanel } from './modules-panel';
import { RetentionPanel } from './retention-panel';
import { SecurityPanel } from './security-panel';
import { SettingsSection } from './settings-section';

export function SystemSettings() {
  const { can, moduleEnabled } = useAuth();
  const profile = useAsync(() => workspaceApi.profile(), []);
  const p = profile.data;
  return (
    <>
      <PageHeader
        title="System settings"
        breadcrumbs={[{ label: 'Settings' }]}
        description="Organisation, modules, integrations, data retention, security and backups. Secrets are configured on the server, never here."
      />
      {profile.error ? <Notice tone="error" className="mb-4">{describeWorkspaceError(profile.error)}</Notice> : null}
      <div className="space-y-6">
        <SettingsSection id="organisation" title="Organisation" description="Profile, data-protection contact and notice versions.">
          {p ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <dl className="grid gap-x-6 gap-y-1 text-body sm:grid-cols-2">
                <div>
                  <dt className="text-meta text-slate">Name</dt>
                  <dd className="text-ink">
                    {p.displayName ?? p.name} <span className="font-mono text-meta text-slate">{p.slug}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-slate">Time zone · region</dt>
                  <dd className="text-ink">
                    {p.timezone} · {p.dataRegion.toUpperCase()}
                  </dd>
                </div>
                <div>
                  <dt className="text-meta text-slate">Privacy notice</dt>
                  <dd className="text-ink">{p.dataProtection ? `${p.dataProtection.privacyNoticeVersion}${p.dataProtection.reviewedAt ? '' : ' (not reviewed)'}` : 'Not recorded'}</dd>
                </div>
                <div>
                  <dt className="text-meta text-slate">Data-protection contact</dt>
                  <dd className="text-ink">{p.dataProtection ? `${p.dataProtection.contactName} · ${p.dataProtection.contactEmail}` : 'Not recorded'}</dd>
                </div>
              </dl>
              <div className="flex flex-col gap-2">
                <SettingsLink href="/setup" icon={Building2} label="Edit organisation" />
                {can('workspace.configure') ? <SettingsLink href="/onboarding" icon={ListChecks} label="Onboarding checklist" /> : null}
              </div>
            </div>
          ) : null}
        </SettingsSection>
        <ModulesPanel />
        <IntegrationsPanel />
        <RetentionPanel />
        <SecurityPanel />
        <BackupPanel />
        {moduleEnabled('campaign') && can('finance.view') ? (
          <SettingsSection id="finance" title="Finance master data" description="Accounts, categories, payees and budget lines used by the finance ledger.">
            <SettingsLink href="/settings/finance" icon={Banknote} label="Manage finance master data" />
          </SettingsSection>
        ) : null}
      </div>
    </>
  );
}

function SettingsLink({ href, icon: Icon, label }: { href: string; icon: typeof Building2; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink hover:bg-cloud">
      <Icon className="h-4 w-4 text-slate" aria-hidden />
      {label}
      <ArrowRight className="h-4 w-4 text-slate" aria-hidden />
    </Link>
  );
}
