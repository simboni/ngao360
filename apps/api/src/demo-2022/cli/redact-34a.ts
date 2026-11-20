/* eslint-disable no-console -- command-line tool output */
/**
 * pnpm demo:redact-34a --tenant <slug> --submission <reference> --file <redacted image> [--reason <text>] [--as <email>]
 * pnpm demo:redact-34a --tenant <slug> --submission <reference> --confirm-declared --reason <text> [--as <email>]
 *
 * Releases the "not for display until redacted" hold on an imported 34A scan
 * of a historical demo organisation. Needs tally.approve (a tally supervisor
 * attests the redaction) and must be a different person from the one who
 * imported the scan or declared it redacted.
 *
 * --file attaches a redacted copy (names and signatures blurred by the
 * operator), stored immutably with its own SHA-256. --confirm-declared is for
 * a scan imported with --redacted: the reviewer has checked that it is already
 * redacted, and a re-encoded copy without metadata becomes the displayable
 * copy. Either way the original is never altered or shown, and the release is
 * audited with the reviewer and the reason.
 */
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { DisplayHoldsService } from '../../modules/tally/services/display-holds.service';
import { PrismaService } from '../../prisma/prisma.service';
import { demoEmail } from '../bungoma-demo';
import { actAs, authFor, createDemoAppContext, parseArgs, requirePermission, resolveDemoTenant, svc } from '../demo-context';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.webp': 'image/webp' };
const USAGE =
  'Usage: pnpm demo:redact-34a --tenant <slug> --submission <reference> (--file <redacted image> | --confirm-declared --reason <text>) [--reason <text>] [--as <email>]';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const str = (k: string) => (typeof args.get(k) === 'string' ? (args.get(k) as string) : undefined);
  const tenantSlug = str('tenant');
  const reference = str('submission');
  const file = str('file');
  const confirm = args.has('confirm-declared');
  const reason = str('reason');
  if (!tenantSlug || !reference || (!file && !confirm) || (file && confirm)) throw new Error(USAGE);
  if (confirm && !reason) throw new Error('--confirm-declared needs --reason <text> (what you checked)');
  const path = file ? resolve(process.env.INIT_CWD ?? process.cwd(), file) : null;
  const mimetype = path ? MIME[extname(path).toLowerCase()] : undefined;
  if (path && !mimetype) throw new Error('The redacted copy must be a PNG, JPEG, WebP or PDF file');
  const app = await createDemoAppContext();
  try {
    const tenant = await resolveDemoTenant(app, tenantSlug);
    const auth = await authFor(app, tenant.id, str('as') ?? demoEmail(tenantSlug, 'supervisor'));
    requirePermission(auth, 'tally.approve');
    const sub = await svc(app, PrismaService).withTenant(tenant.id, (tx) => tx.resultSubmission.findFirst({ where: { reference }, select: { id: true } }));
    if (!sub) throw new Error(`No submission ${reference}`);
    const holds = svc(app, DisplayHoldsService);
    const r = path
      ? await actAs(auth, () => {
          const buffer = readFileSync(path);
          return holds.attachRedactedCopy(auth, sub.id, { buffer, mimetype: mimetype!, originalname: basename(path), size: buffer.length }, reason);
        })
      : await actAs(auth, () => holds.confirmDeclaredRedaction(auth, sub.id, reason!));
    console.log(`Display hold on ${reference} released by ${auth.email} (copy sha256 ${r.redactedSha256}). Viewers now see that copy; the original is unchanged.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
