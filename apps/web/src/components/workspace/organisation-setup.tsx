'use client';

/**
 * S02 for the organisation's first owner: complete the profile (display name, time zone, region,
 * logo, default county), record the data-protection contact and notice versions, then follow the
 * links to modules, the registry import and inviting administrators. Saving needs a recent
 * confirmation (re-auth); the logo can be used once the malware scanner records it clean.
 */
import { DATA_REGIONS, environmentDefinition, type UpdateWorkspaceProfile, type WorkspaceProfile } from '@ngao360/shared';
import { ArrowRight, ImageUp, Save, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField } from '@/components/office/correspondence/office-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { workspaceApi } from './workspace-api';
import { describeWorkspaceError } from './workspace-model';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

interface ProfileForm {
  displayName: string;
  timezone: string;
  dataRegion: string;
  defaultCountyCode: string;
  controllerName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  privacyNoticeVersion: string;
  staffNoticeVersion: string;
}

function formFrom(p: WorkspaceProfile): ProfileForm {
  const dp = p.dataProtection;
  return {
    displayName: p.displayName ?? p.name,
    timezone: p.timezone,
    dataRegion: p.dataRegion,
    defaultCountyCode: p.defaultCountyCode ?? '',
    controllerName: dp?.controllerName ?? '',
    contactName: dp?.contactName ?? '',
    contactEmail: dp?.contactEmail ?? '',
    contactPhone: dp?.contactPhone ?? '',
    privacyNoticeVersion: dp?.privacyNoticeVersion ?? '',
    staffNoticeVersion: dp?.staffNoticeVersion ?? '',
  };
}

export function OrganisationSetup() {
  const { can } = useAuth();
  const canConfigure = can('workspace.configure');
  const highRisk = useHighRisk();
  const profile = useAsync(() => workspaceApi.profile(), []);
  const [f, setF] = useState<ProfileForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logo, setLogo] = useState<{ fileId: string; scanStatus: string } | null>(null);
  useEffect(() => {
    if (profile.data) setF(formFrom(profile.data));
  }, [profile.data]);
  const set = (k: keyof ProfileForm, v: string) => setF((s) => (s ? { ...s, [k]: v } : s));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f) return;
    const dpFilled = [f.controllerName, f.contactName, f.contactEmail, f.privacyNoticeVersion].some((v) => v.trim());
    const body: UpdateWorkspaceProfile = {
      displayName: f.displayName.trim(),
      timezone: f.timezone.trim(),
      dataRegion: f.dataRegion as UpdateWorkspaceProfile['dataRegion'],
      defaultCountyCode: f.defaultCountyCode.trim() || null,
      ...(dpFilled
        ? {
            dataProtection: {
              controllerName: f.controllerName.trim(),
              contactName: f.contactName.trim(),
              contactEmail: f.contactEmail.trim(),
              contactPhone: f.contactPhone.trim() || null,
              privacyNoticeVersion: f.privacyNoticeVersion.trim(),
              staffNoticeVersion: f.staffNoticeVersion.trim() || null,
            },
          }
        : {}),
    };
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      profile.setData(await highRisk(() => workspaceApi.updateProfile(body)));
      setSaved(true);
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      setLogo(await workspaceApi.uploadLogo(file));
    } catch (err) {
      setError(describeWorkspaceError(err));
    }
  };

  const applyLogo = async () => {
    if (!logo) return;
    setError(null);
    try {
      profile.setData(await highRisk(() => workspaceApi.updateProfile({ logoFileId: logo.fileId })));
      setLogo(null);
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    }
  };

  if (profile.error) return <Notice tone="error">{describeWorkspaceError(profile.error)}</Notice>;
  if (!profile.data || !f) return <div className="h-40 animate-pulse rounded-card bg-surface" aria-busy="true" />;
  const p = profile.data;
  const dp = p.dataProtection;

  return (
    <div className="space-y-6">
      {p.historicalDemo ? (
        <Notice tone="warning" title="HISTORICAL DEMO / SIMULATED DATA">
          This is a historical demo organisation. Its label cannot be removed.
        </Notice>
      ) : null}

      <form onSubmit={save} className="space-y-6" noValidate>
        <Card className="p-5">
          <h2 className="mb-1 text-card font-semibold text-ink">Organisation profile</h2>
          <p className="mb-4 text-meta text-slate">
            {p.name} · code <span className="font-mono">{p.slug}</span>
            {p.environment ? ` · ${environmentDefinition(p.environment).label}` : ''} · the name and code are fixed.
          </p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="os-display" label="Display name" required>
              <input id="os-display" className="ngao-input" value={f.displayName} disabled={!canConfigure} maxLength={120} onChange={(e) => set('displayName', e.target.value)} />
            </FormField>
            <FormField id="os-tz" label="Time zone" required hint="IANA name, e.g. Africa/Nairobi.">
              <input id="os-tz" className="ngao-input" value={f.timezone} disabled={!canConfigure} onChange={(e) => set('timezone', e.target.value)} />
            </FormField>
            <FormField id="os-region" label="Data region" required>
              <select id="os-region" className="ngao-input pr-8" value={f.dataRegion} disabled={!canConfigure} onChange={(e) => set('dataRegion', e.target.value)}>
                {DATA_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r === 'ke' ? 'Kenya' : r === 'eu' ? 'European Union' : 'Other'}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="os-county" label="Default county code" hint="Three digits, e.g. 039.">
              <input id="os-county" className="ngao-input w-32 tabular-nums" maxLength={3} inputMode="numeric" value={f.defaultCountyCode} disabled={!canConfigure} onChange={(e) => set('defaultCountyCode', e.target.value.replace(/\D/g, ''))} />
            </FormField>
          </div>
        </Card>

        <Card className="p-5" id="data-protection">
          <h2 className="mb-1 text-card font-semibold text-ink">Data protection</h2>
          <p className="mb-4 text-meta text-slate">
            The data controller and contact named in your notices, and the version labels of the notices people are shown (Data Protection Act 2019). Saving
            records you as the reviewer.
            {dp?.reviewedAt ? ` Last reviewed by ${dp.reviewedBy?.displayName ?? 'an administrator'} on ${formatDateTime(dp.reviewedAt)}.` : dp ? ' Recorded at setup; not yet reviewed in this organisation.' : ''}
          </p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="os-dp-controller" label="Data controller" required>
              <input id="os-dp-controller" className="ngao-input" value={f.controllerName} disabled={!canConfigure} onChange={(e) => set('controllerName', e.target.value)} />
            </FormField>
            <FormField id="os-dp-contact" label="Contact (role or office)" required>
              <input id="os-dp-contact" className="ngao-input" value={f.contactName} disabled={!canConfigure} onChange={(e) => set('contactName', e.target.value)} />
            </FormField>
            <FormField id="os-dp-email" label="Contact e-mail" required>
              <input id="os-dp-email" type="email" className="ngao-input" value={f.contactEmail} disabled={!canConfigure} onChange={(e) => set('contactEmail', e.target.value)} />
            </FormField>
            <FormField id="os-dp-phone" label="Contact phone">
              <input id="os-dp-phone" className="ngao-input" value={f.contactPhone} disabled={!canConfigure} onChange={(e) => set('contactPhone', e.target.value)} />
            </FormField>
            <FormField id="os-dp-notice" label="Privacy notice version" required hint="Changing it states your current retention periods under the new version.">
              <input id="os-dp-notice" className="ngao-input font-mono" value={f.privacyNoticeVersion} disabled={!canConfigure} onChange={(e) => set('privacyNoticeVersion', e.target.value)} />
            </FormField>
            <FormField id="os-dp-staff" label="Staff notice version">
              <input id="os-dp-staff" className="ngao-input font-mono" value={f.staffNoticeVersion} disabled={!canConfigure} onChange={(e) => set('staffNoticeVersion', e.target.value)} />
            </FormField>
          </div>
        </Card>

        {error ? <Notice tone="error">{error}</Notice> : null}
        {saved ? <Notice tone="success">Saved. The change is in the audit log.</Notice> : null}
        {canConfigure ? (
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>
              <Save className="h-4 w-4" aria-hidden />
              Confirm and save
            </Button>
          </div>
        ) : (
          <Notice tone="info">You can view the profile. Changing it needs the workspace.configure permission.</Notice>
        )}
      </form>

      <Card className="p-5">
        <h2 className="mb-1 text-card font-semibold text-ink">Logo</h2>
        <p className="mb-3 text-meta text-slate">
          PNG, JPEG or WebP, up to 2 MB, re-encoded without metadata. It can be used once the malware scanner records it clean.
          {p.logoFileId ? ` Current logo: ${p.logoScanStatus === 'CLEAN' ? 'clean' : (p.logoScanStatus ?? 'unknown').toLowerCase()}.` : ' No logo yet.'}
        </p>
        {canConfigure ? (
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink hover:bg-cloud">
              <ImageUp className="h-4 w-4" aria-hidden />
              Upload an image
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void uploadLogo(e.target.files?.[0])} />
            </label>
            {logo ? (
              <>
                <span className="text-meta text-slate">Uploaded; scan status {logo.scanStatus.toLowerCase()}.</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => void applyLogo()}>
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                  Use as logo
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-card font-semibold text-ink">Next steps</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          <NextStep href="/settings#modules" title="Choose modules" text="Switch on the modules you use." />
          <NextStep href="/reference/stations" title="Import geography and the station registry" text="Then a second person approves the registry version." />
          <NextStep href="/admin/users" title="Invite administrators" text="Invitations go to the person once e-mail delivery is configured." />
          <NextStep href="/onboarding" title="Onboarding checklist" text="Track what is done, from the data." />
        </ul>
      </Card>
    </div>
  );
}

function NextStep({ href, title, text }: { href: string; title: string; text: string }) {
  return (
    <li>
      <Link href={href} className="flex items-start justify-between gap-2 rounded-lg border border-line px-3 py-2 hover:bg-cloud">
        <span>
          <span className="block font-medium text-ink">{title}</span>
          <span className="block text-meta text-slate">{text}</span>
        </span>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate" aria-hidden />
      </Link>
    </li>
  );
}
