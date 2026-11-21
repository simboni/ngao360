/* eslint-disable no-console -- command-line tool output */
/**
 * pnpm ops:rotate-keys --target <mfa|messaging|agent-data> [--dry-run] [--batch-size <n>]
 *                      [--checkpoint <file>] [--reset-checkpoint] [--validate] [--tenant <id>]
 *
 * Re-encrypts / re-hashes stored values after a key rotation (docs/RUNBOOKS.md "Key rotation").
 * The new key is in the main variable (e.g. AGENT_DATA_KEY), the old one in `<NAME>_PREVIOUS`; the
 * API accepts both until this reports `complete`. Connects as the schema owner (DATABASE_URL).
 * Prints counts and key identifiers only, never a key or a value.
 *
 * Exit codes: 0 complete (only an unscoped run); 1 error; 2 finished with rows still needing the previous
 * key (unreadable or changed during the run: re-run, then investigate before retiring the old key);
 * 3 stopped early; 4 the one tenant of a `--tenant` run is complete (other tenants were not scanned:
 * run without --tenant before retiring the previous key).
 */
import { createPrismaClient, developmentAgentDataKey } from '@ngao360/db';
import { resolve } from 'node:path';
import { ROTATION_EXIT_CODES, ROTATION_TARGETS, type RotationKeys, type RotationTarget, rotationVerdict, runRotation } from './key-rotation/rotation';

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(a.slice(2), next);
      i += 1;
    } else out.set(a.slice(2), true);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const target = args.get('target');
  if (typeof target !== 'string' || !(ROTATION_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`--target must be one of ${ROTATION_TARGETS.join(', ')}`);
  }
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL (schema owner) is required');
  const env = process.env;
  const keys: RotationKeys = {
    MFA_ENCRYPTION_KEY: env.MFA_ENCRYPTION_KEY,
    MFA_ENCRYPTION_KEY_PREVIOUS: env.MFA_ENCRYPTION_KEY_PREVIOUS,
    MESSAGING_ENCRYPTION_KEY: env.MESSAGING_ENCRYPTION_KEY,
    MESSAGING_ENCRYPTION_KEY_PREVIOUS: env.MESSAGING_ENCRYPTION_KEY_PREVIOUS,
    MESSAGING_HASH_KEY: env.MESSAGING_HASH_KEY,
    MESSAGING_HASH_KEY_PREVIOUS: env.MESSAGING_HASH_KEY_PREVIOUS,
    AGENT_DATA_KEY: env.AGENT_DATA_KEY,
    AGENT_DATA_KEY_PREVIOUS: env.AGENT_DATA_KEY_PREVIOUS,
    IDENTIFIER_FINGERPRINT_KEY: env.IDENTIFIER_FINGERPRINT_KEY,
  };
  for (const k of Object.keys(keys) as Array<keyof RotationKeys>) if (keys[k] === '') delete keys[k];
  // Same development fallback as the API (production always sets AGENT_DATA_KEY).
  if (!keys.AGENT_DATA_KEY && env.NODE_ENV !== 'production' && keys.MFA_ENCRYPTION_KEY) keys.AGENT_DATA_KEY = developmentAgentDataKey(keys.MFA_ENCRYPTION_KEY);
  const checkpoint = args.get('checkpoint');
  const dryRun = args.has('dry-run');
  const db = createPrismaClient({ url: ownerUrl, log: [] });
  try {
    const r = await runRotation(db, {
      target: target as RotationTarget,
      keys,
      dryRun,
      batchSize: Number(args.get('batch-size') ?? 200) || 200,
      checkpointPath: typeof checkpoint === 'string' ? resolve(process.env.INIT_CWD ?? process.cwd(), checkpoint) : undefined,
      resetCheckpoint: args.has('reset-checkpoint'),
      validate: args.has('validate'),
      ...(typeof args.get('tenant') === 'string' ? { tenantId: args.get('tenant') as string } : {}),
      log: (l) => console.log(l),
    });
    console.log(`Target ${r.target}, new key id ${r.keyId}${r.dryRun ? ' (dry run: nothing written)' : ''}`);
    const verdict = rotationVerdict(r);
    if (verdict === 'incomplete') console.log('NOT complete: some rows still need the previous key. Re-run with --reset-checkpoint; do not retire the previous key yet.');
    if (verdict === 'tenant-complete') {
      console.log(`Tenant ${r.tenantId} complete${r.dryRun ? ' (dry run)' : ''}. Other tenants were not scanned: run without --tenant (then --reset-checkpoint) before retiring the previous key.`);
    }
    if (verdict === 'dry-run-complete') console.log('Dry run complete.');
    if (verdict === 'complete') console.log('Complete: every row is under the new key. The previous key can be removed from the environment.');
    return ROTATION_EXIT_CODES[verdict];
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
