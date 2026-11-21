#!/usr/bin/env node
/*
 * Recomputes every audit event's hashes from its stored content (used by restore-drill.sh).
 *
 * Input (stdin): one JSON object per line with the audit_events columns
 *   { seq, tenant_id, actor_id, actor_type, action, entity_type, entity_id, before_hash, after_hash,
 *     before, after, reason, request_id, event_hash, occurred_at_ms }
 * in seq order. Output (stdout): a JSON summary. Exit 1 when any event_hash does not match.
 *
 * event_hash = SHA-256(canonicalJson(core)) exactly as AuditService.buildEvent() and the seed write
 * it; before_hash / after_hash = SHA-256(canonicalJson(payload)). canonicalJson below mirrors
 * packages/db/src/security.ts (sorted keys, undefined dropped); a unit test keeps them in step.
 * The script also folds "seq:event_hash\n" into a running SHA-256 (the chain digest written by
 * backup.sh), so the caller can compare the restored log with the backup in one value.
 */
'use strict';
const { createHash } = require('node:crypto');
const readline = require('node:readline');

function normalise(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function' && value.constructor !== Object) return normalise(value.toJSON());
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = normalise(value[key]);
    }
    return out;
  }
  return value;
}
const canonicalJson = (v) => JSON.stringify(normalise(v));
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const hashJson = (v) => (v === null || v === undefined ? null : sha256Hex(canonicalJson(v)));

/** Hash of the core fields, as AuditService.buildEvent() computes it. */
function eventHashOf(row) {
  const core = {
    tenantId: row.tenant_id,
    actorId: row.actor_id ?? null,
    actorType: row.actor_type,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id ?? null,
    beforeHash: row.before_hash ?? null,
    afterHash: row.after_hash ?? null,
    reason: row.reason ?? null,
    requestId: row.request_id ?? null,
    occurredAt: new Date(Number(row.occurred_at_ms)).toISOString(),
  };
  return sha256Hex(canonicalJson(core));
}

async function main() {
  const chain = createHash('sha256');
  const summary = { events: 0, eventHashMismatches: 0, payloadHashMismatches: 0, outOfOrder: 0, firstMismatches: [] };
  let lastSeq = -Infinity;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    summary.events += 1;
    const seq = Number(row.seq);
    if (!(seq > lastSeq)) summary.outOfOrder += 1;
    lastSeq = seq;
    chain.update(`${row.seq}:${row.event_hash}\n`);
    if (eventHashOf(row) !== row.event_hash) {
      summary.eventHashMismatches += 1;
      if (summary.firstMismatches.length < 10) summary.firstMismatches.push({ seq: row.seq, kind: 'event_hash' });
    }
    if (hashJson(row.before) !== (row.before_hash ?? null) || hashJson(row.after) !== (row.after_hash ?? null)) {
      summary.payloadHashMismatches += 1;
      if (summary.firstMismatches.length < 10) summary.firstMismatches.push({ seq: row.seq, kind: 'payload_hash' });
    }
  }
  summary.chainDigest = chain.digest('hex');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(summary.eventHashMismatches === 0 && summary.payloadHashMismatches === 0 && summary.outOfOrder === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`audit-verify: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = { canonicalJson, eventHashOf, hashJson };
