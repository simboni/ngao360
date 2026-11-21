'use client';

/**
 * Own recovery codes (API contract §32.2). Ten one-time codes, shown once; creating new codes
 * needs re-authentication and cancels the unused ones. Only the remaining count is shown later:
 * the server keeps argon2id hashes, never the codes.
 */
import type { RecoveryCodesResponse, RecoveryCodesStatus } from '@ngao360/shared';
import { Copy, Download, LifeBuoy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Notice } from '@/components/admin/primitives';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { REAUTH_CANCELLED, useAccountReauth } from './account-reauth';
import { recoveryCodesFileText } from './webauthn';

export function RecoveryCodesPanel() {
  const { me } = useAuth();
  const { run } = useAccountReauth();
  const q = useApiQuery<RecoveryCodesStatus>('recovery-codes', () => api.get<RecoveryCodesStatus>('/auth/recovery-codes'));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<RecoveryCodesResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await run(() => api.post<RecoveryCodesResponse>('/auth/recovery-codes'));
      setConfirming(false);
      setCopied(false);
      setFresh(res);
      await q.reload();
    } catch (err) {
      if (!(err instanceof Error && err.message === REAUTH_CANCELLED)) setError(describeError(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const fileText = fresh ? recoveryCodesFileText(fresh.codes, me?.tenant.slug ?? '', formatDateTime(fresh.generatedAt)) : '';

  const download = () => {
    const url = URL.createObjectURL(new Blob([fileText], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ngao360-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fileText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const status = q.data;
  const remaining = status?.remaining ?? 0;

  return (
    <Card>
      <CardHeader
        title="Recovery codes"
        description="If you lose your phone or passkey, a recovery code lets you finish signing in. Each code works once."
        actions={
          <Button size="sm" variant={remaining > 0 ? 'secondary' : 'primary'} onClick={() => setConfirming(true)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {remaining > 0 ? 'Create new codes' : 'Create codes'}
          </Button>
        }
      />
      <CardBody>
        {error ? <Notice tone="danger" className="mb-3">{error}</Notice> : null}
        {q.error ? <Notice tone="danger">{describeError(q.error)}</Notice> : null}
        {status ? (
          remaining > 0 ? (
            <p className="flex items-center gap-2 text-body text-ink">
              <LifeBuoy className="h-4 w-4 text-teal" aria-hidden />
              {remaining} unused {remaining === 1 ? 'code' : 'codes'} left
              {status.generatedAt ? <span className="text-slate">· created {formatDateTime(status.generatedAt)}</span> : null}
            </p>
          ) : (
            <Notice tone="warning">You have no recovery codes. Create them now and keep them somewhere safe, away from your phone.</Notice>
          )
        ) : null}
        {status && remaining > 0 && remaining <= 3 ? (
          <Notice tone="warning" className="mt-3">Only a few codes are left. Create new codes soon.</Notice>
        ) : null}
      </CardBody>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        size="sm"
        title={remaining > 0 ? 'Create new recovery codes?' : 'Create recovery codes'}
        description={remaining > 0 ? 'Your current unused codes will stop working.' : 'You will see the codes once. Save or print them before closing.'}
      >
        <p className="mb-4 text-body text-slate">You will be asked to confirm it’s you first.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button type="button" loading={busy} onClick={() => void generate()}>
            Create codes
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!fresh}
        onClose={() => setFresh(null)}
        size="sm"
        title="Save your recovery codes"
        description="This is the only time they are shown. Store them somewhere private, such as a password manager or a printed copy kept safely."
      >
        {fresh ? (
          <>
            <ol className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line bg-cloud p-3 font-mono text-body" aria-label="Recovery codes">
              {fresh.codes.map((c) => (
                <li key={c} className="tracking-wider">
                  {c}
                </li>
              ))}
            </ol>
            <div className="mb-4 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={download}>
                <Download className="h-4 w-4" aria-hidden />
                Download
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
                <Copy className="h-4 w-4" aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setFresh(null)}>
                I have saved them
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
    </Card>
  );
}
