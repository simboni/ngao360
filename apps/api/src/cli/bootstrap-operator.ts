/* eslint-disable no-console -- command-line tool output */
/**
 * Create the first platform-operator account on a fresh install (docs/DEPLOYMENT.md §5):
 *
 *   docker compose -f docker-compose.prod.yml --env-file /etc/ngao360/.env.prod run --rm migrate \
 *     node dist/cli/bootstrap-operator.js --email you@ngao360.co.ke --name "Your Name"
 *
 * Connects as the schema owner (DATABASE_URL, the migrate service). Prints a single-use invitation link
 * once; the person sets their own password and enrols MFA at first sign-in. Run it again before the
 * link is used to issue a fresh one. Refuses once an active platform operator exists.
 *
 * Exit codes: 0 invitation issued; 1 error; 3 refused (an active platform operator already exists).
 */
import { createPrismaClient } from '@ngao360/db';
import { bootstrapPlatformOperator } from './bootstrap-operator/bootstrap';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (schema owner) is required: run this in the migrate service');
  const origin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  const db = createPrismaClient({ url, log: [] });
  try {
    const result = await bootstrapPlatformOperator(db, {
      email: arg('email') ?? '',
      displayName: arg('name') ?? '',
      ttlHours: Number(arg('ttl-hours') ?? process.env.INVITATION_TTL_HOURS ?? 72),
    });
    if (result.status === 'refused') {
      console.error('Refused: an active platform operator already exists. Invite further operators from the app (Users), or use account recovery.');
      return 3;
    }
    console.log(`${result.reissued ? 'Re-issued' : 'Created'} the platform-operator invitation.`);
    console.log(`  Organisation code: ${result.tenantSlug}`);
    console.log(`  Expires: ${result.expiresAt.toISOString()}`);
    console.log('  Open this link once, set a password and enrol an authenticator or passkey (it is shown only now):');
    console.log(`  ${origin || '<WEB_ORIGIN>'}${result.acceptPath}`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
