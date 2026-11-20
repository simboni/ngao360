/**
 * Finance ledger over HTTP (docs/API_CONTRACT.md §27): maker-checker
 * (requester ≠ approver ≠ payer), approval prerequisites, immutability after
 * approval with corrections only by reversing entries, tenant-configured
 * limit settings shown as warnings (unverified) or blocks (verified BLOCK),
 * operations roles locked out of finance, and exports gated by the elevated
 * permission + re-authentication and audited. Synthetic data only.
 */
import { type CampaignFixture, createCampaignFixture, describeDb, syntheticPdf } from './campaign-fixtures';

jest.setTimeout(120_000);

describeDb('Finance ledger (integration)', () => {
  let f: CampaignFixture;
  let accountId: string;
  let incomeCat: string;
  let expenseCat: string;
  let payeeId: string;
  let sourceId: string;

  beforeAll(async () => {
    f = await createCampaignFixture({
      officer: { perms: ['finance.view', 'finance.request'] },
      officer2: { perms: ['finance.view', 'finance.request'] },
      approver: { perms: ['finance.view', 'finance.approve', 'finance.pay', 'finance.reverse'] },
      dual: { perms: ['finance.view', 'finance.request', 'finance.approve'] },
      approverNoReauth: { perms: ['finance.view', 'finance.approve'], reauth: false },
      payer: { perms: ['finance.view', 'finance.pay'] },
      settings: { perms: ['finance.view', 'finance.settings.manage'] },
      settings2: { perms: ['finance.view', 'finance.settings.manage'] },
      exporter: { perms: ['finance.view', 'finance.export', 'reports.export', 'reports.export_sensitive'] },
      exporterNoReauth: { perms: ['finance.view', 'finance.export', 'reports.export', 'reports.export_sensitive'], reauth: false },
      viewerOnly: { perms: ['finance.view', 'reports.export'] },
      operations: { perms: ['tasks.view', 'tasks.create', 'events.view', 'events.logistics'] },
      outsider: { perms: ['finance.view', 'finance.request'], tenant: 'other' },
    });
    const s = f.http('settings');
    accountId = (await s.post('/finance/accounts').send({ name: 'Synthetic campaign account', type: 'BANK', institution: 'Synthetic Bank', accountNumberLast4: '4821', currency: 'KES', isDedicatedCampaignAccount: true }).expect(201)).body.id;
    incomeCat = (await s.post('/finance/categories').send({ code: 'INC.DON', name: 'Donations', kind: 'INCOME' }).expect(201)).body.id;
    expenseCat = (await s.post('/finance/categories').send({ code: 'EXP.VEN', name: 'Venues', kind: 'EXPENSE' }).expect(201)).body.id;
    payeeId = (await f.http('officer').post('/finance/payees').send({ name: 'Synthetic Sound Hire Ltd', kind: 'SUPPLIER', taxPin: 'P051234567X' }).expect(201)).body.id;
    sourceId = (await f.http('officer').post('/finance/contribution-sources').send({ displayName: 'Synthetic Donor A', kind: 'INDIVIDUAL', identifier: '12345678' }).expect(201)).body.id;
    // The declaration is recorded by a finance approver, never by the person recording contributions.
    await f.http('approver').patch(`/finance/contribution-sources/${sourceId}`).send({ displayName: 'Synthetic Donor A', kind: 'INDIVIDUAL', declared: true }).expect(200);
  });
  afterAll(async () => f?.close());

  const draft = async (who: string, over: Record<string, unknown> = {}) =>
    (
      await f
        .http(who)
        .post('/finance/transactions')
        .send({ type: 'EXPENSE', accountId, categoryId: expenseCat, payeeId, amountMinor: 1_250_000, currency: 'KES', transactionDate: '2027-03-01', description: 'Synthetic sound system hire', externalReference: 'INV-0001', ...over })
        .expect(201)
    ).body;

  const attach = async (who: string, id: string) => {
    const file = (await f.http(who).post('/finance/files').attach('file', syntheticPdf(), { filename: 'invoice.pdf', contentType: 'application/pdf' }).expect(201)).body;
    return (await f.http(who).post(`/finance/transactions/${id}/documents`).send({ fileId: file.id, kind: 'INVOICE' }).expect(201)).body;
  };

  const act = (who: string, id: string, body: Record<string, unknown>) => f.http(who).post(`/finance/transactions/${id}/transition`).send(body);

  it('masks identifiers: account last 4, payee PIN and contributor ID are never returned in full', async () => {
    const accounts = (await f.http('officer').get('/finance/accounts').expect(200)).body;
    expect(accounts[0]).toMatchObject({ accountNumberMasked: '•••• 4821', balanceMinor: 0 });
    const payees = (await f.http('officer').get('/finance/payees').expect(200)).body.items;
    expect(JSON.stringify(payees)).not.toContain('P051234567X');
    const dup = await f.http('officer2').post('/finance/payees').send({ name: 'Same PIN', kind: 'SUPPLIER', taxPin: 'p05-1234567x' }).expect(409);
    expect(dup.body.details.existingId).toBe(payeeId);
    const sources = (await f.http('officer').get('/finance/contribution-sources').expect(200)).body.items;
    expect(sources[0].identifierMasked).toMatch(/^ID •+678$/);
    expect(JSON.stringify(sources)).not.toContain('12345678');
  });

  it('operations roles and other tenants have no access to finance', async () => {
    await f.http('operations').get('/finance/ledger').expect(403);
    await f.http('operations').get('/finance/transactions').expect(403);
    const t = await draft('officer');
    await f.http('outsider').get(`/finance/transactions/${t.id}`).expect(404);
  });

  it('requester cannot approve or pay; approval needs a reference and a document; approver cannot pay when segregated', async () => {
    const t = await draft('officer', { externalReference: null });
    await act('officer', t.id, { action: 'SUBMIT', expectedVersion: t.version }).expect(200);
    // Approvers need a fresh re-authentication.
    expect((await act('approverNoReauth', t.id, { action: 'APPROVE', expectedVersion: 2 }).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    const incomplete = await act('approver', t.id, { action: 'APPROVE', expectedVersion: 2 }).expect(409);
    expect(incomplete.body.code).toBe('APPROVAL_INCOMPLETE');
    expect(incomplete.body.details.blockers).toEqual(expect.arrayContaining(['REFERENCE_MISSING', 'SUPPORTING_DOCUMENT_MISSING']));

    const ok = await draft('dual');
    await attach('dual', ok.id);
    await act('dual', ok.id, { action: 'SUBMIT', expectedVersion: ok.version }).expect(200);
    const self = await act('dual', ok.id, { action: 'APPROVE', expectedVersion: 2 }).expect(403);
    expect(self.body.code).toBe('SEPARATION_OF_DUTIES');

    const e = await draft('officer');
    await attach('officer', e.id);
    let d = (await act('officer', e.id, { action: 'SUBMIT', expectedVersion: e.version }).expect(200)).body;
    expect(d.allowedActions).not.toContain('APPROVE');
    d = (await act('approver', e.id, { action: 'APPROVE', expectedVersion: d.version }).expect(200)).body;
    expect(d).toMatchObject({ status: 'APPROVED', approvedBy: { id: f.users.approver } });
    const approverPays = await act('approver', e.id, { action: 'PAY', paymentReference: 'MPESA-SYN-1', expectedVersion: d.version }).expect(403);
    expect(approverPays.body.code).toBe('SEPARATION_OF_DUTIES');
    d = (await act('payer', e.id, { action: 'PAY', paymentReference: 'MPESA-SYN-1', expectedVersion: d.version }).expect(200)).body;
    expect(d).toMatchObject({ status: 'PAID', paidBy: { id: f.users.payer }, paymentReference: 'MPESA-SYN-1' });
    expect(d.timeline.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['CREATED', 'DOCUMENT_ADDED', 'REQUESTED', 'APPROVED', 'PAID']));

    const audit = await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, entityId: e.id, action: 'finance.transaction.status_changed' } });
    expect(audit.map((a) => (a.after as { status: string }).status)).toEqual(expect.arrayContaining(['REQUESTED', 'APPROVED', 'PAID']));
  });

  it('approved entries are immutable; a correction is a reversing entry approved by someone else', async () => {
    const e = await draft('officer', { amountMinor: 500_000 });
    await attach('officer', e.id);
    let d = (await act('officer', e.id, { action: 'SUBMIT', expectedVersion: 1 }).expect(200)).body;
    d = (await act('approver', e.id, { action: 'APPROVE', expectedVersion: d.version }).expect(200)).body;
    const edit = await f.http('officer').patch(`/finance/transactions/${e.id}`).send({ amountMinor: 1, expectedVersion: d.version }).expect(409);
    expect(edit.body.code).toBe('IMMUTABLE_RECORD');
    // Even a direct database write as the runtime role is refused by the trigger.
    await expect(f.owner.financeTransaction.update({ where: { id: e.id }, data: { amountMinor: 1n } })).rejects.toThrow(/IMMUTABLE_RECORD/);

    const before = (await f.http('approver').get('/finance/accounts').expect(200)).body[0].balanceMinor;
    const rev = (await f.http('approver').post(`/finance/transactions/${e.id}/reverse`).send({ reason: 'Duplicate payment (synthetic)', expectedVersion: d.version }).expect(201)).body;
    expect(rev).toMatchObject({ type: 'REVERSAL', status: 'REQUESTED', reversesId: e.id, amount: { amountMinor: 500_000, currency: 'KES' } });
    await f.http('approver').post(`/finance/transactions/${e.id}/reverse`).send({ reason: 'Again', expectedVersion: d.version }).expect(409);
    // The reversal's requester cannot approve it; it also needs its own document.
    expect((await act('approver', rev.id, { action: 'APPROVE', expectedVersion: rev.version }).expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
    await attach('officer2', rev.id);
    const fresh = (await f.http('officer').get(`/finance/transactions/${rev.id}`).expect(200)).body;
    const approver2 = await createApproverClient();
    await approver2.post(`/finance/transactions/${rev.id}/transition`).send({ action: 'APPROVE', expectedVersion: fresh.version }).expect(200);
    const orig = (await f.http('officer').get(`/finance/transactions/${e.id}`).expect(200)).body;
    expect(orig).toMatchObject({ status: 'REVERSED', reversedById: rev.id });
    const after = (await f.http('approver').get('/finance/accounts').expect(200)).body[0].balanceMinor;
    expect(after).toBe(before + 500_000);
  });

  // A second approver persona created on demand (the fixture's personas are fixed at start).
  let approver2Client: ReturnType<CampaignFixture['http']> | null = null;
  async function createApproverClient() {
    if (approver2Client) return approver2Client;
    approver2Client = f.http('payer');
    // payer lacks finance.approve: grant it through an extra role assignment for this check.
    const role = await f.owner.role.create({ data: { tenantId: f.tenantId, key: `R_APPROVER2_${Date.now()}`, name: 'Synthetic approver 2', permissions: { create: [{ tenantId: f.tenantId, permissionKey: 'finance.approve' }] } } });
    await f.owner.roleAssignment.create({ data: { tenantId: f.tenantId, userId: f.users.payer!, roleId: role.id, scopeType: 'ORGANISATION', reason: 'fixture' } });
    return approver2Client;
  }

  it('limit settings: unverified caps warn (with source note), verified BLOCK settings refuse approval', async () => {
    const s = f.http('settings');
    const cap = (
      await s
        .post('/finance/settings/limits')
        .send({ kind: 'SINGLE_SOURCE_CAP_PCT', label: 'Demo single-source cap', valueBasisPoints: 2000, capBasis: 'TOTAL_CONTRIBUTIONS', periodLabel: 'Synthetic 2027 cycle', effectiveFrom: '2027-01-01', legalSourceNote: 'Synthetic note: configure to the applicable law', enforcement: 'BLOCK' })
        .expect(201)
    ).body;
    expect(cap).toMatchObject({ verified: false, verifiedBy: null, enforcement: 'BLOCK' });
    await s.post('/finance/settings/limits').send({ kind: 'SINGLE_SOURCE_CAP_PCT', label: 'Overlap', valueBasisPoints: 1000, capBasis: 'TOTAL_CONTRIBUTIONS', periodLabel: 'Overlap period', effectiveFrom: '2027-06-01', legalSourceNote: 'Synthetic overlapping note' }).expect(409);

    const c = await draft('officer', { type: 'CONTRIBUTION', categoryId: incomeCat, payeeId: null, contributionSourceId: sourceId, amountMinor: 10_000_000, transactionDate: '2027-02-01', externalReference: 'RCPT-1' });
    await attach('officer', c.id);
    let d = (await act('officer', c.id, { action: 'SUBMIT', expectedVersion: 1 }).expect(200)).body;
    expect(d.complianceFlags).toEqual(expect.arrayContaining(['SINGLE_SOURCE_CAP_EXCEEDED', 'UNVERIFIED_SETTING']));
    const finding = d.compliance.find((x: { flag: string }) => x.flag === 'SINGLE_SOURCE_CAP_EXCEEDED');
    expect(finding).toMatchObject({ level: 'WARN', settingVerified: false, legalSourceNote: 'Synthetic note: configure to the applicable law' });
    expect(finding.message).toContain('Unverified – configure to the applicable law');
    // Warnings must be acknowledged.
    const warn = await act('approver', c.id, { action: 'APPROVE', expectedVersion: d.version }).expect(409);
    expect(warn.body.code).toBe('CONFLICT');
    expect(warn.body.details.findings.length).toBeGreaterThan(0);

    // Once verified, the BLOCK setting refuses the approval.
    // The person who entered the setting cannot verify it; a second person does.
    expect((await s.post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: true, reason: 'Confirmed by synthetic legal review' }).expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
    await f.http('settings2').post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: true, reason: 'Confirmed by synthetic legal review' }).expect(200);
    const block = await act('approver', c.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: d.version }).expect(409);
    expect(block.body.code).toBe('LIMIT_EXCEEDED');
    expect(block.body.details.findings[0]).toMatchObject({ flag: 'SINGLE_SOURCE_CAP_EXCEEDED', level: 'BLOCK', settingVerified: true });

    // Back to unverified: warning only, approved with acknowledgement, flags frozen.
    await f.http('settings2').post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: false, reason: 'Instrument contested (synthetic)' }).expect(200);
    d = (await act('approver', c.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: d.version }).expect(200)).body;
    expect(d.status).toBe('APPROVED');
    expect(d.timeline.some((x: { type: string }) => x.type === 'COMPLIANCE_EVALUATED')).toBe(true);

    // Supersede: new row, old row closed the day before; values never edited in place.
    const next = (
      await s
        .post(`/finance/settings/limits/${cap.id}/supersede`)
        .send({ label: 'Demo cap v2', valueBasisPoints: 2500, capBasis: 'TOTAL_CONTRIBUTIONS', periodLabel: 'Synthetic 2027 cycle', effectiveFrom: '2027-07-01', legalSourceNote: 'Synthetic note v2: configure to the law', reason: 'Updated guidance (synthetic)' })
        .expect(201)
    ).body;
    expect(next.supersedesId).toBe(cap.id);
    const all = (await s.get('/finance/settings/limits?includeSuperseded=true').expect(200)).body;
    expect(all.find((x: { id: string }) => x.id === cap.id).effectiveTo).toBe('2027-06-30');
    const ledger = (await f.http('officer').get('/finance/ledger').expect(200)).body;
    expect(ledger.totals.contributionsMinor).toBe(10_000_000);
  });

  it('exports need finance.export + reports.export_sensitive + re-auth, carry the header and are logged and audited', async () => {
    await f.http('viewerOnly').post('/finance/exports').send({ register: 'LEDGER', format: 'CSV', reason: 'Monthly review' }).expect(403);
    expect((await f.http('exporterNoReauth').post('/finance/exports').send({ register: 'LEDGER', format: 'CSV', reason: 'Monthly review' }).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    const out = (await f.http('exporter').post('/finance/exports').send({ register: 'CONTRIBUTIONS', format: 'CSV', reason: 'Monthly review (synthetic)' }).expect(200)).body;
    expect(out.url).toBeTruthy();
    const log = await f.owner.reportExport.findFirstOrThrow({ where: { tenantId: f.tenantId, generatedById: f.users.exporter }, include: { file: true } });
    expect(log).toMatchObject({ datasetKey: 'finance.contributions', sensitive: true, reason: 'Monthly review (synthetic)', classification: 'HIGHLY_RESTRICTED' });
    expect(log.reauthAt).not.toBeNull();
    const actions = (await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, actorId: f.users.exporter } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['finance.exported', 'reports.exported']));
    const res = await request(out.url);
    expect(res).toContain('Generated:');
    expect(res).toContain('Data classification: HIGHLY RESTRICTED');
    expect(res).not.toContain('12345678');
  });

  async function request(url: string): Promise<string> {
    const supertest = (await import('supertest')).default;
    const path = new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search;
    const r = await supertest(f.app.getHttpServer()).get(path).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return (r.body as Buffer).toString('utf8');
  }
});
