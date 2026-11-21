import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AGENT_SENSITIVE_FIELDS, AgentDataCipher, type AgentSensitiveField, developmentAgentDataKey, isSealedAgentValue, type TenantTx } from '@ngao360/db';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Column-level encryption of agent personal data (national ID, phone, M-Pesa number, next of kin)
 * under AGENT_DATA_KEY. See AgentDataCipher in @ngao360/db for the format and key derivation.
 *
 * - Production requires AGENT_DATA_KEY (config refuses to start without it). Development and tests
 *   without it use a key derived from MFA_ENCRYPTION_KEY, so data is never stored in clear.
 * - AGENT_DATA_KEY_PREVIOUS is accepted for reading during a rotation (`pnpm ops:rotate-keys`).
 * - Values, ciphertexts and keys are never logged.
 */
@Injectable()
export class AgentDataCrypto {
  readonly cipher: AgentDataCipher;

  constructor(config: AppConfig) {
    const v = config.values;
    let key = v.AGENT_DATA_KEY;
    if (!key) {
      if (v.NODE_ENV === 'production') throw new Error('AGENT_DATA_KEY is required in production');
      new Logger(AgentDataCrypto.name).warn('AGENT_DATA_KEY is not set: using a development key derived from MFA_ENCRYPTION_KEY');
      key = developmentAgentDataKey(v.MFA_ENCRYPTION_KEY);
    }
    this.cipher = new AgentDataCipher(key, [v.AGENT_DATA_KEY_PREVIOUS]);
  }
}

export type AgentSensitivePlain = Record<AgentSensitiveField, string | null>;

/** Sensitive row fields as stored (ciphertext); a missing row reads as all null. */
export type AgentSensitiveStored = Partial<Record<AgentSensitiveField, string | null>> | null;

export function emptyAgentSensitive(): AgentSensitivePlain {
  return Object.fromEntries(AGENT_SENSITIVE_FIELDS.map((f) => [f, null])) as AgentSensitivePlain;
}

/** Rows written before column encryption hold at least one value without the "ag1." prefix. */
export function hasLegacyValue(row: Partial<Record<AgentSensitiveField, string | null>>): boolean {
  return AGENT_SENSITIVE_FIELDS.some((f) => row[f] !== null && row[f] !== undefined && !isSealedAgentValue(row[f]));
}

/**
 * Data migration for agent_sensitive rows written before column encryption: seals every legacy
 * plaintext value and adds the lookup hashes. Runs once at start-up (tenants come from a SECURITY
 * DEFINER lookup that returns tenant ids only; nothing to do costs one query) and from the rotation
 * CLI. Each row is rewritten only if it is unchanged since it was read; safe on several instances.
 */
@Injectable()
export class AgentDataMigration implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentDataMigration.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AgentDataCrypto,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const r = await this.encryptLegacyRows();
      if (r.rows > 0) this.logger.log(`Agent personal data encrypted: ${r.rows} row(s) in ${r.tenants} tenant(s)`);
    } catch (e) {
      // Never blocks start-up; reads of a legacy row still work and the CLI reports what is left.
      this.logger.error(`Agent personal data migration did not finish: ${(e as Error).message}`);
    }
  }

  async encryptLegacyRows(batchSize = 200): Promise<{ tenants: number; rows: number }> {
    const tenants = await this.prisma.client.$queryRaw<Array<{ t: string }>>`SELECT ngao_agent_sensitive_legacy_tenants() AS t`;
    let rows = 0;
    for (const { t: tenantId } of tenants) {
      for (;;) {
        const n = await this.prisma.withTenant(tenantId, (tx) => this.encryptBatch(tx, tenantId, batchSize));
        rows += n.updated;
        if (n.seen < batchSize || n.updated === 0) break;
      }
    }
    return { tenants: tenants.length, rows };
  }

  private async encryptBatch(tx: TenantTx, tenantId: string, take: number): Promise<{ seen: number; updated: number }> {
    const notSealed = AGENT_SENSITIVE_FIELDS.map((f) => ({ AND: [{ [f]: { not: null } }, { NOT: { [f]: { startsWith: 'ag1.' } } }] }));
    const legacy = await tx.agentSensitive.findMany({ where: { OR: notSealed }, take, orderBy: { agentId: 'asc' } });
    let updated = 0;
    for (const row of legacy) {
      const ref = { tenantId, agentId: row.agentId };
      const plain = this.crypto.cipher.openRow(ref, row);
      const sealed = this.crypto.cipher.sealRow(ref, plain);
      // Optimistic: only if nobody changed the row since it was read (another instance, an edit).
      const r = await tx.agentSensitive.updateMany({
        where: { agentId: row.agentId, updatedAt: row.updatedAt, ...Object.fromEntries(AGENT_SENSITIVE_FIELDS.map((f) => [f, row[f]])) },
        data: sealed,
      });
      updated += r.count;
    }
    return { seen: legacy.length, updated };
  }
}
