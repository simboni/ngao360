/**
 * Regression tests for the pilot privacy review of agent personal data (synthetic data only):
 * national ID, phone, M-Pesa and next-of-kin details can be erased on request, also once the agent
 * is WITHDRAWN, and the field.agent_retention job erases them after the retention period.
 */
import { AgentRetentionService } from '../src/modules/field/agents/agent-retention.service';
import { createFieldFixture, describeDb, type FieldFixture } from './field-fixtures';

jest.setTimeout(180_000);

describeDb('Field privacy review fixes (integration)', () => {
  let f: FieldFixture;

  beforeAll(async () => {
    process.env.FIELD_WARROOM_RECORD_SECONDS = '0';
    f = await createFieldFixture({
      coord: { perms: ['field.agents.view', 'field.agents.create', 'field.agents.edit'] },
      revealer: { perms: ['field.agents.view', 'field.agents.reveal_sensitive'] },
      revealerNoReauth: { perms: ['field.agents.view', 'field.agents.reveal_sensitive'], reauth: false },
    });
  });
  afterAll(async () => f?.close());

  const mkWithdrawnAgent = async (name: string) => {
    const a = await f
      .http('coord')
      .post('/field/agents')
      .send({
        givenName: name,
        familyName: 'Synthetic',
        homeWardId: f.units.w1,
        privacyNoticeAcknowledged: true,
        sensitive: { phone: '0712 345 678', nationalIdNumber: '12345678', mpesaNumber: '0798 765 432', nextOfKinName: 'Synthetic Kin', nextOfKinPhone: '0711000000', nextOfKinRelationship: 'Sibling' },
      })
      .expect(201);
    await f.http('coord').post(`/field/agents/${a.body.id}/status`).send({ expectedVersion: a.body.version, to: 'WITHDRAWN', reason: 'Synthetic withdrawal' }).expect(200);
    return a.body.id as string;
  };

  it('erases a withdrawn agent’s personal data on request (re-authentication), audited by field name', async () => {
    const id = await mkWithdrawnAgent('Wafula');
    await f.http('revealerNoReauth').post(`/field/agents/${id}/sensitive/erase`).send({ reason: 'Data-subject request (synthetic)' }).expect(401);
    // Editing a withdrawn record is still refused, but erasing is allowed.
    await f.http('revealer').put(`/field/agents/${id}/sensitive`).send({ phone: '0700000000', reason: 'Synthetic phone change' }).expect(409);
    const res = await f.http('revealer').post(`/field/agents/${id}/sensitive/erase`).send({ reason: 'Data-subject request (synthetic)' }).expect(200);
    expect(res.body).toMatchObject({ phoneMasked: null, nationalIdMasked: null, hasMpesaNumber: false, hasNextOfKin: false });
    const row = await f.owner.agentSensitive.findUniqueOrThrow({ where: { agentId: id } });
    expect(row).toMatchObject({ nationalIdNumber: null, phone: null, mpesaNumber: null, nextOfKinName: null, nextOfKinPhone: null, nextOfKinRelationship: null });
    expect(row.erasedAt).not.toBeNull();
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: id, action: 'field.agent.sensitive_erased' } });
    expect(JSON.stringify(ev.after)).not.toMatch(/12345678|798765432/);
    // Erased data cannot be restored, even by the owner role.
    await expect(f.owner.agentSensitive.update({ where: { agentId: id }, data: { nationalIdNumber: '12345678' } })).rejects.toThrow(/erased/);
  });

  it('the retention job erases agents withdrawn longer than the retention period', async () => {
    const id = await mkWithdrawnAgent('Nekesa');
    const retention = f.app.get(AgentRetentionService);
    expect(await retention.runForTenant(f.tenantId, new Date())).toBe(0);
    expect((await f.owner.agentSensitive.findUniqueOrThrow({ where: { agentId: id } })).phone).not.toBeNull();
    const in13Months = new Date(Date.now() + 400 * 86_400_000);
    expect(await retention.runForTenant(f.tenantId, in13Months)).toBeGreaterThanOrEqual(1);
    expect((await f.owner.agentSensitive.findUniqueOrThrow({ where: { agentId: id } })).phone).toBeNull();
    const ev = await f.owner.auditEvent.findFirstOrThrow({ where: { entityId: id, action: 'field.agent.sensitive_erased' } });
    expect(ev).toMatchObject({ actorId: null, actorType: 'SYSTEM' });
  });
});
