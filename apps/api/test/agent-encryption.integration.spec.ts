/**
 * Column-level encryption of agent personal data (national ID, phone, M-Pesa number, next of kin)
 * under AGENT_DATA_KEY, through the real HTTP stack (synthetic data only; skipped without TEST_*
 * database URLs):
 *  - nothing is stored in clear; masked values on `agents` are unchanged; keyed lookup hashes;
 *  - the audited reveal decrypts; the audit trail holds field names only;
 *  - the database refuses plaintext; a ciphertext moved to another row or column does not open;
 *  - rows written before column encryption are encrypted by the start-up data migration;
 *  - edits re-seal the whole row; erasure clears values and hashes for good.
 */
import { AgentDataCipher, isSealedAgentValue } from '@ngao360/db';
import { AgentDataCrypto, AgentDataMigration } from '../src/modules/field/agents/agent-data-crypto';
import { createFieldFixture, describeDb, type FieldFixture } from './field-fixtures';

jest.setTimeout(180_000);

const AGENT_KEY = Buffer.alloc(32, 21).toString('base64');
const SENSITIVE = { phone: '0712 345 678', nationalIdNumber: '12345678', mpesaNumber: '0798 765 432', nextOfKinName: 'Synthetic Kin', nextOfKinPhone: '0711000000', nextOfKinRelationship: 'Sibling' };
const CLEAR_VALUES = ['712345678', '12345678', '798765432', 'Synthetic Kin', '711000000', 'Sibling'];

describeDb('Agent personal data column encryption (integration)', () => {
  let f: FieldFixture;
  let cipher: AgentDataCipher;

  beforeAll(async () => {
    process.env.AGENT_DATA_KEY = AGENT_KEY;
    f = await createFieldFixture({
      coord: { perms: ['field.agents.view', 'field.agents.create', 'field.agents.edit'] },
      revealer: { perms: ['field.agents.view', 'field.agents.reveal_sensitive'] },
    });
    cipher = new AgentDataCipher(AGENT_KEY);
  });
  afterAll(async () => {
    await f?.close();
    delete process.env.AGENT_DATA_KEY;
  });

  const mkAgent = async (name: string, sensitive: Record<string, string> = SENSITIVE) =>
    (
      await f
        .http('coord')
        .post('/field/agents')
        .send({ givenName: name, familyName: 'Synthetic', homeWardId: f.units.w1, privacyNoticeAcknowledged: true, sensitive })
        .expect(201)
    ).body as { id: string; version: number; phoneMasked: string | null; nationalIdMasked: string | null };

  /** Raw stored columns, read as the schema owner. */
  const stored = (agentId: string) => f.owner.agentSensitive.findUniqueOrThrow({ where: { agentId } });

  it('stores ciphertext only, keeps the masked values and adds keyed lookup hashes', async () => {
    const a = await mkAgent('Wekesa');
    expect(a.phoneMasked).toBe('+254 ••• ••• 678');
    expect(a.nationalIdMasked).toBe('••••• 678');
    const row = await stored(a.id);
    for (const v of [row.nationalIdNumber, row.phone, row.mpesaNumber, row.nextOfKinName, row.nextOfKinPhone, row.nextOfKinRelationship]) {
      expect(isSealedAgentValue(v)).toBe(true);
    }
    const raw = JSON.stringify(row);
    for (const clear of CLEAR_VALUES) expect(raw).not.toContain(clear);
    // Two values that are equal in clear are different ciphertexts (random IV, per-column binding).
    const same = await stored((await mkAgent('Same', { phone: '0700999888', mpesaNumber: '0700999888' })).id);
    expect(same.phone).not.toBe(same.mpesaNumber);
    // Lookup hashes: keyed, tenant-scoped, equal for the same national ID in the same tenant.
    expect(row.nationalIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.nationalIdHash).toBe(cipher.lookupHash({ tenantId: f.tenantId }, 'nationalId', '12345678'));
    expect(row.phoneHash).toBe(cipher.lookupHash({ tenantId: f.tenantId }, 'phone', '+254712345678'));
    expect(cipher.lookupHash({ tenantId: f.otherTenantId }, 'nationalId', '12345678')).not.toBe(row.nationalIdHash);
    const b = await mkAgent('Wekesa Two', { nationalIdNumber: '12345678' });
    expect((await stored(b.id)).nationalIdHash).toBe(row.nationalIdHash);
    // The API uses AGENT_DATA_KEY from the environment.
    expect(f.app.get(AgentDataCrypto).cipher.currentKeyId).toBe(cipher.currentKeyId);
  });

  it('the audited reveal decrypts; the audit trail records field names only', async () => {
    const a = await mkAgent('Nanjala');
    const res = await f.http('revealer').post(`/field/agents/${a.id}/reveal`).send({ fields: ['nationalIdNumber', 'phone', 'mpesaNumber', 'nextOfKin'], reason: 'Confirm payment details' }).expect(200);
    expect(res.body).toMatchObject({
      nationalIdNumber: '12345678',
      phone: '+254712345678',
      mpesaNumber: '+254798765432',
      nextOfKin: { name: 'Synthetic Kin', phone: '+254711000000', relationship: 'Sibling' },
    });
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.agent.sensitive_revealed', entityId: a.id } });
    expect(ev.after).toEqual({ fields: ['nationalIdNumber', 'phone', 'mpesaNumber', 'nextOfKin'] });
    const audit = JSON.stringify(await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, entityId: a.id }, select: { before: true, after: true, reason: true } }));
    for (const clear of CLEAR_VALUES.slice(0, 3)) expect(audit).not.toContain(clear);
    expect(audit).not.toContain('ag1.');
  });

  it('the database refuses plaintext, and a ciphertext moved to another row or column does not open', async () => {
    const a = await mkAgent('Barasa');
    const b = await mkAgent('Barasa Two', { phone: '0700111222' });
    await expect(f.owner.agentSensitive.update({ where: { agentId: a.id }, data: { phone: '+254700000000' } })).rejects.toThrow(/agent_sensitive_encrypted_check/);
    const rowA = await stored(a.id);
    // Copy agent A's sealed phone into agent B's row (valid format, wrong binding): reveal fails closed.
    await f.owner.agentSensitive.update({ where: { agentId: b.id }, data: { phone: rowA.phone } });
    const moved = await f.http('revealer').post(`/field/agents/${b.id}/reveal`).send({ fields: ['phone'], reason: 'Synthetic tamper check' });
    expect(moved.status).toBe(500);
    expect(JSON.stringify(moved.body)).not.toContain('712345678');
    // Same row, other column: also refused.
    expect(() => cipher.open({ tenantId: f.tenantId, agentId: a.id }, 'mpesaNumber', rowA.phone)).toThrow();
    expect(cipher.open({ tenantId: f.tenantId, agentId: a.id }, 'phone', rowA.phone)).toBe('+254712345678');
    // A wrong key does not open it either.
    expect(() => new AgentDataCipher(Buffer.alloc(32, 22).toString('base64')).open({ tenantId: f.tenantId, agentId: a.id }, 'phone', rowA.phone)).toThrow();
  });

  it('encrypts rows written before column encryption (start-up data migration)', async () => {
    const a = await mkAgent('Legacy', { phone: '0700222333' });
    // Simulate a row from before this release: plaintext values, no hashes. The CHECK constraint
    // refuses that today, so it is lifted for this one statement inside a transaction.
    await f.owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE agent_sensitive DROP CONSTRAINT agent_sensitive_encrypted_check');
      await tx.$executeRawUnsafe(
        `UPDATE agent_sensitive SET phone = '+254700222333', national_id_number = '22223333', next_of_kin_name = 'Legacy Kin', national_id_hash = NULL, phone_hash = NULL WHERE agent_id = $1::uuid`,
        a.id,
      );
      await tx.$executeRawUnsafe(`ALTER TABLE agent_sensitive ADD CONSTRAINT agent_sensitive_encrypted_check CHECK (
        (national_id_number IS NULL OR national_id_number ~ '^ag1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$')
        AND (phone IS NULL OR phone ~ '^ag1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$')
        AND (mpesa_number IS NULL OR mpesa_number ~ '^ag1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$')
        AND (next_of_kin_name IS NULL OR next_of_kin_name ~ '^ag1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$')
        AND (next_of_kin_phone IS NULL OR next_of_kin_phone ~ '^ag1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$')
        AND (next_of_kin_relationship IS NULL OR next_of_kin_relationship ~ '^ag1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$')) NOT VALID`);
    });
    expect((await stored(a.id)).phone).toBe('+254700222333');
    // A legacy row still reads (until it is migrated) ...
    const before = await f.http('revealer').post(`/field/agents/${a.id}/reveal`).send({ fields: ['phone'], reason: 'Synthetic legacy read' }).expect(200);
    expect(before.body.phone).toBe('+254700222333');
    // ... and the data migration seals it, with hashes, without changing what it says.
    const r = await f.app.get(AgentDataMigration).encryptLegacyRows();
    expect(r.rows).toBeGreaterThanOrEqual(1);
    const row = await stored(a.id);
    expect(isSealedAgentValue(row.phone)).toBe(true);
    expect(isSealedAgentValue(row.nationalIdNumber)).toBe(true);
    expect(isSealedAgentValue(row.nextOfKinName)).toBe(true);
    expect(row.phoneHash).toBe(cipher.lookupHash({ tenantId: f.tenantId }, 'phone', '+254700222333'));
    const after = await f.http('revealer').post(`/field/agents/${a.id}/reveal`).send({ fields: ['phone', 'nationalIdNumber', 'nextOfKin'], reason: 'Synthetic legacy read' }).expect(200);
    expect(after.body).toMatchObject({ phone: '+254700222333', nationalIdNumber: '22223333', nextOfKin: { name: 'Legacy Kin', phone: null, relationship: null } });
    // Nothing left to do for this tenant; a second run changes nothing here.
    const tenants = await f.owner.$queryRawUnsafe<Array<{ t: string }>>('SELECT ngao_agent_sensitive_legacy_tenants()::text AS t');
    expect(tenants.map((t) => t.t)).not.toContain(f.tenantId);
  });

  it('an edit re-seals the row; erasure clears values and hashes for good', async () => {
    const a = await mkAgent('Simiyu');
    const first = await stored(a.id);
    const upd = await f.http('revealer').put(`/field/agents/${a.id}/sensitive`).send({ phone: '0711222333', reason: 'Agent changed number' }).expect(200);
    expect(upd.body.phoneMasked).toBe('+254 ••• ••• 333');
    const second = await stored(a.id);
    expect(second.phone).not.toBe(first.phone);
    expect(second.phoneHash).toBe(cipher.lookupHash({ tenantId: f.tenantId }, 'phone', '+254711222333'));
    expect(second.nationalIdHash).toBe(first.nationalIdHash);
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: 'field.agent.sensitive_updated', entityId: a.id } });
    expect(ev.after).toEqual({ fields: ['phone'] });

    await f.http('coord').post(`/field/agents/${a.id}/status`).send({ expectedVersion: upd.body.version, to: 'WITHDRAWN', reason: 'Synthetic withdrawal' }).expect(200);
    await f.http('revealer').post(`/field/agents/${a.id}/sensitive/erase`).send({ reason: 'Data-subject request (synthetic)' }).expect(200);
    const erased = await stored(a.id);
    expect(erased).toMatchObject({ phone: null, nationalIdNumber: null, nationalIdHash: null, phoneHash: null });
    await expect(f.owner.agentSensitive.update({ where: { agentId: a.id }, data: { phoneHash: first.phoneHash } })).rejects.toThrow(/erased/);
  });
});
