/**
 * Which part of the platform this process runs (PROCESS_ROLE):
 *
 * - `all` (default, development and tests): HTTP API and every BullMQ worker in one process.
 * - `api`: HTTP only. Jobs are still queued and repeatable schedules are still upserted, but no
 *   BullMQ worker runs here, so a slow scan, import or dispatch never competes with requests.
 * - `worker`: no HTTP listener (`dist/worker.js`); runs the BullMQ processors and the durable
 *   `platform-jobs` worker.
 *
 * Read from the environment at module load, like QUEUES_ENABLED, because Nest module provider lists
 * are fixed when the module file is evaluated.
 */
export type ProcessRole = 'all' | 'api' | 'worker';

export function processRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  const v = (env.PROCESS_ROLE ?? 'all').trim().toLowerCase();
  if (v === '' || v === 'all') return 'all';
  if (v === 'api' || v === 'worker') return v;
  throw new Error(`Invalid PROCESS_ROLE "${v}" (expected all, api or worker)`);
}

/** True when this process should consume BullMQ queues (processors and the job worker). */
export function runsWorkers(env: NodeJS.ProcessEnv = process.env): boolean {
  return processRole(env) !== 'api';
}
