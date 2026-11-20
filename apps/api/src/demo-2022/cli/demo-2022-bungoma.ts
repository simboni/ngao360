/* eslint-disable no-console -- command-line tool output */
/**
 * pnpm demo:2022-bungoma [--config <path>] [--tenant <slug>] [--concurrency <n>]
 *
 * Creates or refreshes the separate 2022 Bungoma historical demo organisation
 * (docs/DEMO_2022.md). Idempotent. No network access. Every station-level
 * figure is SIMULATED; county figures come from the config and are labelled
 * UNVERIFIED until the operator plugs in gazetted totals with their source.
 */
import { resolve } from 'node:path';
import { createPrismaClient } from '@ngao360/db';
import { HISTORICAL_DEMO_LABEL, PARALLEL_TALLY_BANNER } from '@ngao360/shared';
import { buildBungomaDemo, demoEmail } from '../bungoma-demo';
import { DEFAULT_DEMO_CONFIG, loadDemoConfigFile } from '../config-file';
import { createDemoAppContext, parseArgs } from '../demo-context';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = typeof args.get('config') === 'string' ? resolve(process.env.INIT_CWD ?? process.cwd(), args.get('config') as string) : DEFAULT_DEMO_CONFIG;
  const config = loadDemoConfigFile(configPath);
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL (owner role) is required to provision the demo organisation');
  const password = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Password-2027';
  if (process.env.NODE_ENV === 'production' && (!process.env.SEED_DEMO_PASSWORD || password.length < 12)) {
    throw new Error('Set SEED_DEMO_PASSWORD (at least 12 characters) in production');
  }
  console.log(`${HISTORICAL_DEMO_LABEL} · ${PARALLEL_TALLY_BANNER}`);
  console.log(`Config: ${configPath}`);
  console.log(`WARNING: ${config.warning}`);
  const ownerDb = createPrismaClient({ url: ownerUrl, log: [] });
  const app = await createDemoAppContext();
  try {
    const started = Date.now();
    const r = await buildBungomaDemo(app, {
      config,
      ownerDb,
      password,
      mfa: { mode: (process.env.SEED_DEMO_MFA ?? 'disabled').toLowerCase() === 'preenrolled' ? 'preenrolled' : 'disabled', key: process.env.MFA_ENCRYPTION_KEY },
      tenantSlug: typeof args.get('tenant') === 'string' ? (args.get('tenant') as string) : undefined,
      concurrency: Number(args.get('concurrency') ?? 6) || 6,
      log: (l) => console.log(l),
    });
    console.log('');
    console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s. Organisation code: ${r.tenantSlug}`);
    console.log(`  37A statuses: ${Object.entries(r.statuses).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  verified stations in the parallel tally: ${r.verifiedStationCodes.length} of ${r.layer.stations.length}`);
    console.log(`  snapshot: ${r.snapshotId}`);
    console.log(`  sign in as ${demoEmail(r.tenantSlug, 'supervisor')} (or owner, clerk1, verifier1, ...) with SEED_DEMO_PASSWORD`);
    if (r.unverified.length) console.log(`  UNVERIFIED config values (placeholders): ${r.unverified.join('; ')}`);
  } finally {
    await app.close();
    await ownerDb.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
