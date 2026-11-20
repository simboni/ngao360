/* eslint-disable no-console -- command-line tool output */
/**
 * pnpm demo:redact-34a --tenant <slug> --submission <reference> --file <redacted image> [--as <email>]
 *
 * Attaches a redacted copy (names and signatures blurred by the operator) to a
 * 34A scan held "not for display until redacted". The redacted copy is stored
 * immutably with its own SHA-256; the original is never altered or shown.
 * Needs tally.approve (a tally supervisor attests the redaction).
 */
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { DisplayHoldsService } from '../../modules/tally/services/display-holds.service';
import { PrismaService } from '../../prisma/prisma.service';
import { demoEmail } from '../bungoma-demo';
import { actAs, authFor, createDemoAppContext, parseArgs, requirePermission, resolveTenant, svc } from '../demo-context';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.webp': 'image/webp' };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [tenantSlug, reference, file] = ['tenant', 'submission', 'file'].map((k) => args.get(k));
  if (typeof tenantSlug !== 'string' || typeof reference !== 'string' || typeof file !== 'string') {
    throw new Error('Usage: pnpm demo:redact-34a --tenant <slug> --submission <reference> --file <redacted image> [--as <email>]');
  }
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const mimetype = MIME[extname(path).toLowerCase()];
  if (!mimetype) throw new Error('The redacted copy must be a PNG, JPEG, WebP or PDF file');
  const app = await createDemoAppContext();
  try {
    const tenant = await resolveTenant(app, tenantSlug);
    const auth = await authFor(app, tenant.id, typeof args.get('as') === 'string' ? (args.get('as') as string) : demoEmail(tenantSlug, 'supervisor'));
    requirePermission(auth, 'tally.approve');
    const sub = await svc(app, PrismaService).withTenant(tenant.id, (tx) => tx.resultSubmission.findFirst({ where: { reference }, select: { id: true } }));
    if (!sub) throw new Error(`No submission ${reference}`);
    const buffer = readFileSync(path);
    const r = await actAs(auth, () => svc(app, DisplayHoldsService).attachRedactedCopy(auth, sub.id, { buffer, mimetype, originalname: basename(path), size: buffer.length }));
    console.log(`Redacted copy attached to ${reference} (sha256 ${r.redactedSha256}). Viewers now see the redacted copy; the original is unchanged.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
