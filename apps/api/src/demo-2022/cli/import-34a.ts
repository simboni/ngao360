/* eslint-disable no-console -- command-line tool output */
/**
 * pnpm demo:import-34a --dir <path> --tenant <slug> [--dry-run] [--redacted]
 *                      [--as <email>] [--registrar <email>] [--cycle <name>] [--json]
 *
 * Imports local 2022 34A scans (never fetches anything). Before using real
 * scans: written IEBC permission, redaction of names and signatures, and no
 * use of the unlicensed crowdsourced ib0b CSV (docs/DEMO_2022.md).
 */
import { resolve } from 'node:path';
import { demoEmail } from '../bungoma-demo';
import { createDemoAppContext, parseArgs } from '../demo-context';
import { formatImportReport, import34A } from '../import-34a';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.get('dir');
  const tenant = args.get('tenant');
  if (typeof dir !== 'string' || typeof tenant !== 'string') {
    throw new Error('Usage: pnpm demo:import-34a --dir <path> --tenant <slug> [--dry-run] [--redacted] [--as <email>] [--registrar <email>] [--cycle <name>] [--json]');
  }
  const str = (k: string) => (typeof args.get(k) === 'string' ? (args.get(k) as string) : undefined);
  const app = await createDemoAppContext();
  try {
    const report = await import34A(app, {
      dir: resolve(process.env.INIT_CWD ?? process.cwd(), dir),
      tenantSlug: tenant,
      dryRun: args.has('dry-run'),
      redacted: args.has('redacted'),
      asEmail: str('as') ?? demoEmail(tenant, 'clerk1'),
      registrarEmail: str('registrar') ?? demoEmail(tenant, 'registrar'),
      cycleName: str('cycle'),
      log: (l) => console.log(l),
    });
    console.log(args.has('json') ? JSON.stringify(report, null, 2) : formatImportReport(report));
    if (report.failed.length) process.exitCode = 2;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
