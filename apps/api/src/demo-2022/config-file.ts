import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type DemoConfig, DemoConfigError, parseDemoConfig } from '@ngao360/shared';

/** Repository root (the CLIs run from apps/api through pnpm --filter). */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const DEFAULT_DEMO_CONFIG = resolve(REPO_ROOT, 'data', 'demo-2022', 'bungoma.config.json');

/** Read and validate a demo config file; refuses to continue on any problem. */
export function loadDemoConfigFile(path = DEFAULT_DEMO_CONFIG): DemoConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DemoConfigError([`${path}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseDemoConfig(raw);
}
