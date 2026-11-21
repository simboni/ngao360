/**
 * Re-encryption / re-hashing after a key rotation (docs/RUNBOOKS.md "Key rotation").
 *
 * Targets:
 *   mfa         mfa_factors.secret_encrypted                         (MFA_ENCRYPTION_KEY)
 *   messaging   message_outbox address / secret payload + hash,      (MESSAGING_ENCRYPTION_KEY,
 *               push_subscriptions endpoint / keys + hash,             MESSAGING_HASH_KEY)
 *               contact_verifications address hash
 *   agent-data  agent_sensitive personal data + lookup hashes        (AGENT_DATA_KEY); also seals
 *               rows written before column encryption
 *
 * The new key is in the main variable, the old one in `<NAME>_PREVIOUS` (the API accepts both while
 * this runs). Rows are processed in primary-key order in batches; each batch is one transaction and
 * each row is rewritten only if it is unchanged since it was read (the API keeps running). A row
 * already under the new key is left alone, so a run can be repeated safely. A checkpoint file
 * records the last key per step and the counts, so an interrupted run resumes where it stopped; it
 * is bound to the new keys' identifiers and refused for other keys unless reset.
 *
 * Fail closed: a value no configured key opens is never rewritten; it is counted as `unreadable`
 * and the run exits non-zero, so the previous key is not retired while anything still needs it.
 * Nothing secret is printed: counts, table names and key identifiers (a hash) only.
 *
 * Connects as the schema owner (DATABASE_URL). Guarded messaging tables accept a re-key-only update
 * inside a transaction that sets `ngao.key_rotation = on` as a role other than ngao_app (migration
 * 20261201000100); every other column stays checked by the guards.
 */
import { AGENT_SENSITIVE_FIELDS, AgentDataCipher, type AgentSensitiveField, HmacKeyring, keyId, type Prisma, type PrismaClient, SealKeyring } from '@ngao360/db';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normaliseAddress, type AddressKind } from '../../platform/messaging/messaging-crypto';

export const ROTATION_TARGETS = ['mfa', 'messaging', 'agent-data'] as const;
export type RotationTarget = (typeof ROTATION_TARGETS)[number];

export interface RotationKeys {
  MFA_ENCRYPTION_KEY?: string;
  MFA_ENCRYPTION_KEY_PREVIOUS?: string;
  MESSAGING_ENCRYPTION_KEY?: string;
  MESSAGING_ENCRYPTION_KEY_PREVIOUS?: string;
  MESSAGING_HASH_KEY?: string;
  MESSAGING_HASH_KEY_PREVIOUS?: string;
  AGENT_DATA_KEY?: string;
  AGENT_DATA_KEY_PREVIOUS?: string;
  IDENTIFIER_FINGERPRINT_KEY?: string;
}

export interface RotationOptions {
  target: RotationTarget;
  keys: RotationKeys;
  dryRun?: boolean;
  batchSize?: number;
  /** JSON checkpoint file; omitted = no checkpoint (always from the start). */
  checkpointPath?: string;
  resetCheckpoint?: boolean;
  /** agent-data: VALIDATE the plaintext-refusing CHECK constraint once every row is sealed. */
  validate?: boolean;
  /** Only this tenant's rows (a staged rotation; tests). Omitted = every tenant. */
  tenantId?: string;
  /** Stop after this many batches (tests of the resume path). */
  maxBatches?: number;
  log?: (line: string) => void;
}

export interface StepCounts {
  scanned: number;
  rewritten: number;
  current: number;
  unreadable: number;
  /** Rows that cannot be re-keyed and need nothing (e.g. superseded contact rows for an old address). */
  skipped: number;
  /** Rows changed by the application between read and write (picked up by a re-run). */
  raced: number;
}

export interface RotationResult {
  target: RotationTarget;
  dryRun: boolean;
  keyId: string;
  steps: Record<string, StepCounts & { done: boolean }>;
  complete: boolean;
  validated: boolean;
}

interface Checkpoint {
  version: 1;
  target: RotationTarget;
  keyId: string;
  tenantId: string | null;
  steps: Record<string, { lastId: string | null; done: boolean; counts: StepCounts }>;
}

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown> & { id: string };

interface Step {
  name: string;
  table: string;
  idColumn: string;
  columns: string[];
  where: string;
  /** Returns the new column values, 'current', 'unreadable' or 'skip'. */
  rekey: (row: Row, tx: Tx) => Promise<Record<string, string | null> | 'current' | 'unreadable' | 'skip'>;
  /** Guarded table: the batch transaction sets ngao.key_rotation. */
  guarded: boolean;
}

const zero = (): StepCounts => ({ scanned: 0, rewritten: 0, current: 0, unreadable: 0, skipped: 0, raced: 0 });

function required(keys: RotationKeys, name: keyof RotationKeys): string {
  const v = keys[name];
  if (!v) throw new Error(`${name} is required for this rotation`);
  return v;
}

/** Identifier of the new key set for a target (bound into the checkpoint). */
export function targetKeyId(target: RotationTarget, keys: RotationKeys): string {
  if (target === 'mfa') return keyId(required(keys, 'MFA_ENCRYPTION_KEY'));
  if (target === 'agent-data') return keyId(required(keys, 'AGENT_DATA_KEY'));
  return keyId(`${required(keys, 'MESSAGING_ENCRYPTION_KEY')}|${required(keys, 'MESSAGING_HASH_KEY')}`);
}

function sealStep(name: string, table: string, column: string, ring: SealKeyring): Step {
  return {
    name,
    table,
    idColumn: 'id',
    columns: [column],
    where: `"${column}" IS NOT NULL`,
    guarded: false,
    rekey: async (row) => {
      const value = row[column] as string;
      const r = ring.tryOpen(value);
      if (!r) return 'unreadable';
      if (r.keyIndex === 0) return 'current';
      return { [column]: ring.seal(r.plaintext) };
    },
  };
}

function mfaSteps(keys: RotationKeys): Step[] {
  const ring = new SealKeyring(required(keys, 'MFA_ENCRYPTION_KEY'), [keys.MFA_ENCRYPTION_KEY_PREVIOUS]);
  return [sealStep('mfa_factors.secret', 'mfa_factors', 'secret_encrypted', ring)];
}

function messagingSteps(keys: RotationKeys): Step[] {
  const ring = new SealKeyring(required(keys, 'MESSAGING_ENCRYPTION_KEY'), [keys.MESSAGING_ENCRYPTION_KEY_PREVIOUS]);
  const newHash = new HmacKeyring(required(keys, 'MESSAGING_HASH_KEY'));
  const anyHash = new HmacKeyring(required(keys, 'MESSAGING_HASH_KEY'), [keys.MESSAGING_HASH_KEY_PREVIOUS]);

  /** Re-seal + re-hash a sealed address whose hash is HMAC("<kind>:<plaintext>"). */
  const resealHashed = (row: Row, sealedCol: string, hashCol: string, kind: string, extraSealed: string[] = []) => {
    const out: Record<string, string | null> = {};
    const opened = ring.tryOpen(row[sealedCol] as string);
    if (!opened) return 'unreadable' as const;
    const message = `${kind}:${opened.plaintext}`;
    const stored = row[hashCol] as string | null;
    // The stored hash must be this value's hash under a configured key (never trust a mismatch).
    if (stored !== null && !anyHash.candidates(message).includes(stored)) return 'unreadable' as const;
    if (opened.keyIndex !== 0) out[sealedCol] = ring.seal(opened.plaintext);
    const fresh = newHash.hash(message);
    if (stored !== null && stored !== fresh) out[hashCol] = fresh;
    for (const col of extraSealed) {
      const v = row[col] as string | null;
      if (v === null) continue;
      const o = ring.tryOpen(v);
      if (!o) return 'unreadable' as const;
      if (o.keyIndex !== 0) out[col] = ring.seal(o.plaintext);
    }
    return Object.keys(out).length === 0 ? ('current' as const) : out;
  };

  return [
    {
      name: 'message_outbox.address',
      table: 'message_outbox',
      idColumn: 'id',
      columns: ['channel', 'address_encrypted', 'address_hash', 'secret_payload_encrypted'],
      where: `"address_encrypted" IS NOT NULL OR "secret_payload_encrypted" IS NOT NULL`,
      guarded: true,
      rekey: async (row) => {
        if (row.address_encrypted === null) {
          const o = ring.tryOpen(row.secret_payload_encrypted as string);
          if (!o) return 'unreadable';
          return o.keyIndex === 0 ? 'current' : { secret_payload_encrypted: ring.seal(o.plaintext) };
        }
        return resealHashed(row, 'address_encrypted', 'address_hash', String(row.channel), ['secret_payload_encrypted']);
      },
    },
    {
      name: 'push_subscriptions.endpoint',
      table: 'push_subscriptions',
      idColumn: 'id',
      columns: ['endpoint_encrypted', 'endpoint_hash', 'keys_encrypted'],
      where: 'TRUE',
      guarded: true,
      rekey: async (row) => resealHashed(row, 'endpoint_encrypted', 'endpoint_hash', 'PUSH', ['keys_encrypted']),
    },
    {
      name: 'contact_verifications.address_hash',
      table: 'contact_verifications',
      idColumn: 'id',
      columns: ['user_id', 'channel', 'address_hash'],
      where: 'TRUE',
      guarded: true,
      // Only the hash is stored; it is recomputed from the account's current address when that
      // address is the one the row was made for. A row for an earlier address (superseded on next
      // use, never matched again) cannot be recomputed and is skipped.
      rekey: async (row, tx) => {
        const users = await tx.$queryRawUnsafe<Array<{ email: string | null; phone: string | null }>>(
          'SELECT email, phone FROM users WHERE id = $1::uuid',
          row.user_id,
        );
        const channel = String(row.channel) as AddressKind;
        const raw = channel === 'EMAIL' ? users[0]?.email : users[0]?.phone;
        const normalised = raw ? normaliseAddress(channel, raw) : null;
        if (!normalised) return 'skip';
        const message = `${channel}:${normalised}`;
        const fresh = newHash.hash(message);
        if (row.address_hash === fresh) return 'current';
        if (!anyHash.candidates(message).includes(row.address_hash as string)) return 'skip';
        return { address_hash: fresh };
      },
    },
  ];
}

function agentSteps(keys: RotationKeys): Step[] {
  const cipher = new AgentDataCipher(required(keys, 'AGENT_DATA_KEY'), [keys.AGENT_DATA_KEY_PREVIOUS]);
  const col: Record<AgentSensitiveField, string> = {
    nationalIdNumber: 'national_id_number',
    phone: 'phone',
    mpesaNumber: 'mpesa_number',
    nextOfKinName: 'next_of_kin_name',
    nextOfKinPhone: 'next_of_kin_phone',
    nextOfKinRelationship: 'next_of_kin_relationship',
  };
  const valueCols = AGENT_SENSITIVE_FIELDS.map((f) => col[f]);
  return [
    {
      name: 'agent_sensitive.personal_data',
      table: 'agent_sensitive',
      idColumn: 'agent_id',
      columns: ['tenant_id', ...valueCols, 'national_id_hash', 'phone_hash'],
      where: valueCols.map((c) => `"${c}" IS NOT NULL`).join(' OR '),
      guarded: false,
      rekey: async (row) => {
        const ref = { tenantId: String(row.tenant_id), agentId: row.id };
        const plain = {} as Record<AgentSensitiveField, string | null>;
        let stale = false;
        for (const f of AGENT_SENSITIVE_FIELDS) {
          const v = row[col[f]] as string | null;
          if (v === null) {
            plain[f] = null;
            continue;
          }
          const o = cipher.tryOpen(ref, f, v);
          if (!o) return 'unreadable';
          plain[f] = o.plaintext;
          if (o.legacy || o.keyIndex !== 0) stale = true;
        }
        const sealed = cipher.sealRow(ref, plain);
        if (!stale && row.national_id_hash === sealed.nationalIdHash && row.phone_hash === sealed.phoneHash) return 'current';
        const out: Record<string, string | null> = { national_id_hash: sealed.nationalIdHash, phone_hash: sealed.phoneHash };
        for (const f of AGENT_SENSITIVE_FIELDS) out[col[f]] = sealed[f];
        return out;
      },
    },
  ];
}

function stepsFor(target: RotationTarget, keys: RotationKeys): Step[] {
  if (target === 'mfa') return mfaSteps(keys);
  if (target === 'messaging') return messagingSteps(keys);
  return agentSteps(keys);
}

function readCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
  if (parsed.version !== 1 || !parsed.steps) throw new Error(`Unreadable checkpoint file ${path}`);
  return parsed;
}

function writeCheckpoint(path: string, cp: Checkpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cp, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Refuses an MFA rotation that would silently break campaign identifier fingerprints. */
async function preflight(db: Db, opts: RotationOptions): Promise<void> {
  if (opts.target !== 'mfa' || opts.keys.IDENTIFIER_FINGERPRINT_KEY) return;
  const [r] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    'SELECT (SELECT count(*) FROM finance_payees WHERE tax_pin_hash IS NOT NULL) + (SELECT count(*) FROM contribution_sources WHERE identifier_hash IS NOT NULL) AS n',
  );
  if (Number(r?.n ?? 0) > 0) {
    throw new Error(
      'Campaign identifier fingerprints are keyed with MFA_ENCRYPTION_KEY and cannot be recomputed: set IDENTIFIER_FINGERPRINT_KEY to the old MFA key (here and on the API) before rotating',
    );
  }
}

export async function runRotation(db: Db, opts: RotationOptions): Promise<RotationResult> {
  const log = opts.log ?? (() => undefined);
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 200, 5000));
  const kid = targetKeyId(opts.target, opts.keys);
  const steps = stepsFor(opts.target, opts.keys);
  await preflight(db, opts);

  const tenantId = opts.tenantId ?? null;
  if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('--tenant must be a tenant id (uuid)');
  let cp: Checkpoint = { version: 1, target: opts.target, keyId: kid, tenantId, steps: {} };
  if (opts.checkpointPath && !opts.dryRun) {
    const existing = opts.resetCheckpoint ? null : readCheckpoint(opts.checkpointPath);
    if (existing) {
      if (existing.target !== opts.target || existing.keyId !== kid || (existing.tenantId ?? null) !== tenantId) {
        throw new Error(`Checkpoint ${opts.checkpointPath} belongs to another target or key (${existing.target}/${existing.keyId}); pass --reset-checkpoint to start over`);
      }
      cp = existing;
      log(`Resuming from checkpoint ${opts.checkpointPath}`);
    }
  }
  for (const s of steps) cp.steps[s.name] ??= { lastId: null, done: false, counts: zero() };

  let batches = 0;
  let stopped = false;
  for (const step of steps) {
    const state = cp.steps[step.name]!;
    if (state.done) {
      log(`${step.name}: already done`);
      continue;
    }
    for (;;) {
      if (opts.maxBatches !== undefined && batches >= opts.maxBatches) {
        stopped = true;
        break;
      }
      const cols = [step.idColumn, ...step.columns].map((c) => `"${c}"::text AS "${c === step.idColumn ? 'id' : c}"`).join(', ');
      const after = state.lastId;
      const seen = await db.$transaction(
        async (tx) => {
          if (step.guarded && !opts.dryRun) await tx.$executeRawUnsafe(`SELECT set_config('ngao.key_rotation', 'on', true)`);
          const filters: string[] = [];
          const selectParams: unknown[] = [];
          if (after) filters.push(`"${step.idColumn}" > $${selectParams.push(after)}::uuid`);
          if (tenantId) filters.push(`"tenant_id" = $${selectParams.push(tenantId)}::uuid`);
          const rows = await tx.$queryRawUnsafe<Row[]>(
            `SELECT ${cols} FROM "${step.table}" WHERE (${step.where}) ${filters.map((cond) => `AND ${cond}`).join(' ')} ORDER BY "${step.idColumn}" LIMIT ${batchSize}`,
            ...selectParams,
          );
          for (const row of rows) {
            state.counts.scanned += 1;
            const r = await step.rekey(row, tx);
            if (r === 'current') state.counts.current += 1;
            else if (r === 'unreadable') state.counts.unreadable += 1;
            else if (r === 'skip') state.counts.skipped += 1;
            else if (opts.dryRun) state.counts.rewritten += 1;
            else {
              const sets = Object.keys(r).map((c, i) => `"${c}" = $${i + 1}`);
              const params: unknown[] = Object.values(r);
              // Optimistic: unchanged since read (the application keeps running).
              const guards = Object.keys(r).map((c) => `"${c}"::text IS NOT DISTINCT FROM $${params.push(row[c] ?? null)}`);
              params.push(row.id);
              const n = await tx.$executeRawUnsafe(
                `UPDATE "${step.table}" SET ${sets.join(', ')} WHERE "${step.idColumn}" = $${params.length}::uuid AND ${guards.join(' AND ')}`,
                ...params,
              );
              if (n === 1) state.counts.rewritten += 1;
              else state.counts.raced += 1;
            }
          }
          return rows;
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
      batches += 1;
      if (seen.length > 0) state.lastId = seen[seen.length - 1]!.id;
      if (seen.length < batchSize) state.done = true;
      if (opts.checkpointPath && !opts.dryRun) writeCheckpoint(opts.checkpointPath, cp);
      if (state.done) break;
    }
    const c = state.counts;
    log(`${step.name}: scanned ${c.scanned}, ${opts.dryRun ? 'would rewrite' : 'rewritten'} ${c.rewritten}, current ${c.current}, skipped ${c.skipped}, unreadable ${c.unreadable}, changed meanwhile ${c.raced}${state.done ? '' : ' (stopped; re-run to resume)'}`);
    if (stopped) break;
  }

  // Rows changed by the application during the run may still be under the old key: a clean
  // verification pass (--reset-checkpoint) reports complete before the old key is retired.
  const complete = steps.every((s) => cp.steps[s.name]!.done) && steps.every((s) => cp.steps[s.name]!.counts.unreadable === 0 && cp.steps[s.name]!.counts.raced === 0);
  let validated = false;
  if (opts.validate && opts.target === 'agent-data' && complete && !opts.dryRun && !tenantId) {
    await db.$executeRawUnsafe('ALTER TABLE "agent_sensitive" VALIDATE CONSTRAINT "agent_sensitive_encrypted_check"');
    validated = true;
    log('agent_sensitive: every row is encrypted; CHECK constraint validated');
  }
  const out: RotationResult['steps'] = {};
  for (const s of steps) out[s.name] = { ...cp.steps[s.name]!.counts, done: cp.steps[s.name]!.done };
  return { target: opts.target, dryRun: !!opts.dryRun, keyId: kid, steps: out, complete, validated };
}
