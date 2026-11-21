/**
 * Regression tests for the campaign review findings (docs/STATUS.md "Campaign
 * review fixes"): maker-checker on limit settings, frozen counterparty
 * identity, export re-download gating, breach note visibility, the task review
 * step, contributor identity and duplicate warnings, per-currency limits,
 * serialised approvals, one document per entry, reversal after a rejected
 * reversal, comms scope for editors, editor ≠ approver, the event's linked
 * communications, report date ranges in Africa/Nairobi, the builder rule on
 * ad-hoc exports and idempotent escalation. Synthetic data only.
 */
import { type CampaignFixture, createCampaignFixture, describeDb, seedDepartment, syntheticPdf } from './campaign-fixtures';
import { markScannedClean } from './platform-fakes';

jest.setTimeout(180_000);

const NOTE = 'Synthetic note: configure to the applicable law';

describeDb('Campaign review fixes: finance (integration)', () => {
  let f: CampaignFixture;
  let kes: string;
  let incomeCat: string;
  let expenseCat: string;
  let payeeId: string;

  beforeAll(async () => {
    f = await createCampaignFixture({
      officer: { perms: ['finance.view', 'finance.request'] },
      officer2: { perms: ['finance.view', 'finance.request'] },
      approver: { perms: ['finance.view', 'finance.approve', 'finance.settings.manage'] },
      approver2: { perms: ['finance.view', 'finance.approve', 'finance.settings.manage'] },
      settings: { perms: ['finance.view', 'finance.settings.manage'] },
      payer: { perms: ['finance.view', 'finance.pay'] },
      reverser: { perms: ['finance.view', 'finance.reverse'] },
      exporter: { perms: ['finance.view', 'finance.export', 'reports.view', 'reports.build', 'reports.export', 'reports.export_sensitive'] },
      dpo: { perms: ['audit.view', 'audit.export', 'reports.view', 'reports.export', 'reports.export_sensitive'] },
      auditorStale: { perms: ['audit.export', 'finance.view', 'finance.export', 'reports.export', 'reports.export_sensitive'], reauth: false },
      auditorFresh: { perms: ['audit.export', 'finance.view', 'finance.export', 'reports.export', 'reports.export_sensitive'] },
    });
    const s = f.http('settings');
    kes = (await s.post('/finance/accounts').send({ name: 'Synthetic KES account', type: 'BANK', currency: 'KES', isDedicatedCampaignAccount: true }).expect(201)).body.id;
    incomeCat = (await s.post('/finance/categories').send({ code: 'INC.DON', name: 'Donations', kind: 'INCOME' }).expect(201)).body.id;
    expenseCat = (await s.post('/finance/categories').send({ code: 'EXP.VEN', name: 'Venues', kind: 'EXPENSE' }).expect(201)).body.id;
    payeeId = (await f.http('officer').post('/finance/payees').send({ name: 'Synthetic Venue Ltd', kind: 'SUPPLIER', taxPin: 'P051111111A' }).expect(201)).body.id;
  });
  afterAll(async () => f?.close());

  // Uploads come back with a clean scan recorded (as the malware-scanning job would); approval needs CLEAN.
  const upload = async (who: string) => {
    const body = (await f.http(who).post('/finance/files').attach('file', syntheticPdf(), { filename: 'doc.pdf', contentType: 'application/pdf' }).expect(201)).body;
    await markScannedClean(f.owner, body.id);
    return body;
  };
  const attachFile = (who: string, txId: string, fileId: string) => f.http(who).post(`/finance/transactions/${txId}/documents`).send({ fileId, kind: 'INVOICE' });
  const act = (who: string, id: string, body: Record<string, unknown>) => f.http(who).post(`/finance/transactions/${id}/transition`).send(body);
  const draft = async (who: string, over: Record<string, unknown>) =>
    (
      await f
        .http(who)
        .post('/finance/transactions')
        .send({ type: 'EXPENSE', accountId: kes, categoryId: expenseCat, payeeId, amountMinor: 100_000, currency: 'KES', transactionDate: '2027-01-10', description: 'Synthetic entry', externalReference: `INV-${Math.random().toString(36).slice(2, 8)}`, ...over })
        .expect(201)
    ).body;
  /** Draft → document → submitted (returns the detail). */
  const submitted = async (who: string, over: Record<string, unknown>) => {
    const t = await draft(who, over);
    await attachFile(who, t.id, (await upload(who)).id).expect(201);
    return (await act(who, t.id, { action: 'SUBMIT', expectedVersion: t.version }).expect(200)).body;
  };
  const declaredSource = async (name: string, identifier: string | null) => {
    const src = (await f.http('officer').post('/finance/contribution-sources').send({ displayName: name, kind: 'INDIVIDUAL', ...(identifier ? { identifier } : {}) }).expect(201)).body;
    await f.http('approver2').patch(`/finance/contribution-sources/${src.id}`).send({ displayName: name, kind: 'INDIVIDUAL', declared: true }).expect(200);
    return src;
  };

  it('limit settings: never verified on entry, verified by a second person, and whoever relaxes one cannot approve what it governs', async () => {
    const a = f.http('approver');
    const body = { kind: 'SINGLE_SOURCE_CAP_PCT', label: 'Synthetic cap', valueBasisPoints: 2000, capBasis: 'TOTAL_CONTRIBUTIONS', periodLabel: 'Synthetic period', effectiveFrom: '2027-01-01', legalSourceNote: NOTE, enforcement: 'BLOCK' };
    expect((await a.post('/finance/settings/limits').send({ ...body, verified: true }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    const cap = (await a.post('/finance/settings/limits').send(body).expect(201)).body;
    expect(cap).toMatchObject({ verified: false, verifiedBy: null });
    expect((await a.post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: true, reason: 'Self check' }).expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
    await f.http('approver2').post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: true, reason: 'Second-person legal check (synthetic)' }).expect(200);

    const src = await declaredSource('Synthetic Donor Wafula', '30111222');
    const c = await submitted('officer', { type: 'CONTRIBUTION', categoryId: incomeCat, payeeId: null, contributionSourceId: src.id, amountMinor: 1_000_000, transactionDate: '2027-01-15' });
    expect((await act('approver', c.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: c.version }).expect(409)).body.code).toBe('LIMIT_EXCEEDED');

    // The approver downgrades the block by un-verifying it, then tries to approve: refused.
    await a.post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: false, reason: 'Instrument contested (synthetic)' }).expect(200);
    const sod = await act('approver', c.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: c.version }).expect(403);
    expect(sod.body.code).toBe('SEPARATION_OF_DUTIES');
    expect(sod.body.details.settingIds).toEqual([cap.id]);
    // Another approver may decide (the warning stays visible and acknowledged).
    expect((await act('approver2', c.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: c.version }).expect(200)).body.status).toBe('APPROVED');

    // Superseding the cap with a looser version is the same: its author cannot approve under it.
    await a.post(`/finance/settings/limits/${cap.id}/supersede`).send({ ...body, kind: undefined, verified: true, valueBasisPoints: 9000, effectiveFrom: '2027-02-01', reason: 'Looser (synthetic)' }).expect(400);
    const looser = (await a.post(`/finance/settings/limits/${cap.id}/supersede`).send({ ...body, kind: undefined, valueBasisPoints: 9000, effectiveFrom: '2027-02-01', reason: 'Looser (synthetic)' }).expect(201)).body;
    const c2 = await submitted('officer', { type: 'CONTRIBUTION', categoryId: incomeCat, payeeId: null, contributionSourceId: src.id, amountMinor: 10_000, transactionDate: '2027-02-10' });
    expect((await act('approver', c2.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: c2.version }).expect(403)).body.details.settingIds).toEqual([looser.id]);
    await act('approver2', c2.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: c2.version }).expect(200);
    const audit = await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, action: 'finance.limit_setting.verified', entityId: cap.id }, orderBy: { occurredAt: 'asc' } });
    expect(audit.map((x) => (x.after as { verificationChangedById: string }).verificationChangedById)).toEqual([f.users.approver2, f.users.approver]);
  });

  it('contributors: identity and declaration cannot be self-certified; missing IDs and look-alike names are flagged', async () => {
    // The requester cannot record a declaration.
    await f.http('officer').post('/finance/contribution-sources').send({ displayName: 'Synthetic Donor Self', kind: 'INDIVIDUAL', identifier: '30999888', declared: true }).expect(403);
    const anon = (await f.http('officer').post('/finance/contribution-sources').send({ displayName: 'J. Wekesa', kind: 'INDIVIDUAL' }).expect(201)).body;
    await f.http('officer').post('/finance/contribution-sources').send({ displayName: 'John Wekesa', kind: 'INDIVIDUAL', identifier: '30555444' }).expect(201);
    const d = await draft('officer', { type: 'CONTRIBUTION', categoryId: incomeCat, payeeId: null, contributionSourceId: anon.id, amountMinor: 5_000, transactionDate: '2027-01-20' });
    const flags = d.compliance.map((x: { flag: string }) => x.flag);
    expect(flags).toEqual(expect.arrayContaining(['UNDECLARED_SOURCE', 'SOURCE_IDENTITY_UNVERIFIED', 'POSSIBLE_DUPLICATE_SOURCE']));
    expect(d.compliance.find((x: { flag: string }) => x.flag === 'POSSIBLE_DUPLICATE_SOURCE').message).toContain('John Wekesa');
  });

  it('payees and contributors named on posted entries keep their identity; edits are audited with before and after', async () => {
    const payee = (await f.http('officer').post('/finance/payees').send({ name: 'ABC Supplies (synthetic)', kind: 'SUPPLIER' }).expect(201)).body;
    const e = await submitted('officer', { payeeId: payee.id, amountMinor: 50_000, transactionDate: '2027-01-25' });
    await act('approver', e.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: e.version }).expect(200);
    await f.http('officer').patch(`/finance/payees/${payee.id}`).send({ name: 'XYZ Holdings', kind: 'SUPPLIER' }).expect(403);
    expect((await f.http('settings').patch(`/finance/payees/${payee.id}`).send({ name: 'XYZ Holdings', kind: 'SUPPLIER' }).expect(409)).body.code).toBe('IMMUTABLE_RECORD');
    await expect(f.owner.financePayee.update({ where: { id: payee.id }, data: { name: 'XYZ Holdings' } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await f.http('settings').patch(`/finance/payees/${payee.id}`).send({ name: 'ABC Supplies (synthetic)', kind: 'SUPPLIER', active: false, notes: 'Contract ended' }).expect(200);
    const audits = await f.owner.auditEvent.findMany({ where: { tenantId: f.tenantId, entityId: payee.id, action: 'finance.payee.saved' }, orderBy: { occurredAt: 'asc' } });
    expect(audits.at(-1)!.before).toMatchObject({ name: 'ABC Supplies (synthetic)', active: true });
    expect(audits.at(-1)!.after).toMatchObject({ active: false });
    const ledger = (await f.http('officer').get(`/finance/transactions/${e.id}`).expect(200)).body;
    expect(ledger.counterparty.name).toBe('ABC Supplies (synthetic)');
  });

  it('one document backs one live entry; infected files never count as support', async () => {
    const file = await upload('officer');
    const e1 = await draft('officer', { transactionDate: '2027-01-26' });
    await attachFile('officer', e1.id, file.id).expect(201);
    const e2 = await draft('officer', { transactionDate: '2027-01-26' });
    expect((await attachFile('officer', e2.id, file.id).expect(409)).body.details.reason).toBe('DOCUMENT_IN_USE');
    await expect(f.owner.financeTransactionDocument.create({ data: { tenantId: f.tenantId, transactionId: e2.id, fileId: file.id, kind: 'INVOICE', addedById: f.users.officer! } })).rejects.toThrow(/DOCUMENT_IN_USE/);

    const bad = await upload('officer');
    await f.owner.storedFile.update({ where: { id: bad.id }, data: { malwareScanStatus: 'INFECTED' } });
    await attachFile('officer', e2.id, bad.id).expect(400);
    // A document flagged after it was attached blocks approval.
    const later = await upload('officer');
    await attachFile('officer', e2.id, later.id).expect(201);
    const sub = (await act('officer', e2.id, { action: 'SUBMIT', expectedVersion: e2.version }).expect(200)).body;
    await f.owner.storedFile.update({ where: { id: later.id }, data: { malwareScanStatus: 'INFECTED' } });
    const blocked = await act('approver', e2.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: sub.version }).expect(409);
    expect(blocked.body.details.blockers).toEqual(expect.arrayContaining(['SUPPORTING_DOCUMENT_MISSING', 'SUPPORTING_DOCUMENT_INFECTED']));
  });

  it('a rejected reversal does not block a new one', async () => {
    const e = await submitted('officer', { amountMinor: 70_000, transactionDate: '2027-01-27' });
    const ok = (await act('approver', e.id, { action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: e.version }).expect(200)).body;
    const r1 = (await f.http('reverser').post(`/finance/transactions/${e.id}/reverse`).send({ reason: 'Wrong amount (synthetic)', expectedVersion: ok.version }).expect(201)).body;
    await act('approver', r1.id, { action: 'REJECT', note: 'Wrong reason given', expectedVersion: r1.version }).expect(200);
    const orig = (await f.http('officer').get(`/finance/transactions/${e.id}`).expect(200)).body;
    expect(orig.reversedById).toBeNull();
    expect(orig.allowedActions).toContain('ADD_DOCUMENT');
    const r2 = (await f.http('reverser').post(`/finance/transactions/${e.id}/reverse`).send({ reason: 'Duplicate payment (synthetic)', expectedVersion: ok.version }).expect(201)).body;
    expect(r2).toMatchObject({ type: 'REVERSAL', reversesId: e.id, status: 'REQUESTED' });
    // Still only one live reversal.
    await f.http('reverser').post(`/finance/transactions/${e.id}/reverse`).send({ reason: 'Again (synthetic)', expectedVersion: ok.version }).expect(409);
    // The reversal may cite the original's receipt.
    const origDoc = (await f.http('officer').get(`/finance/transactions/${e.id}`).expect(200)).body.documents[0];
    await attachFile('officer', r2.id, origDoc.file.id).expect(201);
  });

  it('report and register date ranges are Africa/Nairobi calendar days', async () => {
    const a = await draft('officer', { transactionDate: '2027-05-31', description: 'Synthetic 31 May entry' });
    const b = await draft('officer', { transactionDate: '2027-06-01', description: 'Synthetic 1 June entry' });
    const def = { datasetKey: 'finance.transactions', fields: ['reference', 'transactionDate'], filters: [], groupBy: [], dateRange: { from: '2027-05-31T21:00:00.000Z', to: '2027-06-01T20:59:59.999Z' } };
    const refs = (await f.http('exporter').post('/reports/preview').send(def).expect(200)).body.rows.map((r: { reference: string }) => r.reference);
    expect(refs).toContain(b.reference);
    expect(refs).not.toContain(a.reference);
  });

  it('re-downloading a sensitive export needs the dataset and export permissions and a fresh re-authentication', async () => {
    await f.http('exporter').post('/finance/exports').send({ register: 'LEDGER', format: 'CSV', reason: 'Monthly review (synthetic)' }).expect(200);
    const exp = await f.owner.reportExport.findFirstOrThrow({ where: { tenantId: f.tenantId, generatedById: f.users.exporter }, orderBy: { generatedAt: 'desc' } });
    expect(exp.sensitive).toBe(true);
    // audit.export alone shows the log, never the finance data.
    const listed = (await f.http('dpo').get('/reports/exports').expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(listed).toContain(exp.id);
    const dpo = await f.http('dpo').get(`/reports/exports/${exp.id}/url`).expect(403);
    expect(dpo.body.details.required).toEqual(expect.arrayContaining(['finance.view', 'finance.export']));
    expect((await f.http('auditorStale').get(`/reports/exports/${exp.id}/url`).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    expect((await f.http('auditorFresh').get(`/reports/exports/${exp.id}/url`).expect(200)).body.url).toBeTruthy();
    expect((await f.http('exporter').get(`/reports/exports/${exp.id}/url`).expect(200)).body.url).toBeTruthy();
    const access = await f.owner.auditEvent.count({ where: { tenantId: f.tenantId, entityId: exp.id, action: 'file.source_accessed' } });
    expect(access).toBe(2);
  });
});

describeDb('Campaign review fixes: limits under concurrency and currencies (integration)', () => {
  let f: CampaignFixture;

  beforeAll(async () => {
    f = await createCampaignFixture({
      officer: { perms: ['finance.view', 'finance.request'] },
      approver: { perms: ['finance.view', 'finance.approve'] },
      approver2: { perms: ['finance.view', 'finance.approve', 'finance.settings.manage'] },
      settings: { perms: ['finance.view', 'finance.settings.manage'] },
      builder: { perms: ['finance.view', 'reports.view', 'reports.build'] },
    });
  });
  afterAll(async () => f?.close());

  it('two concurrent approvals cannot both pass a verified cap; other currencies are never counted against a limit', async () => {
    const s = f.http('settings');
    const kes = (await s.post('/finance/accounts').send({ name: 'Synthetic KES', type: 'BANK', currency: 'KES', isDedicatedCampaignAccount: true }).expect(201)).body.id;
    const usd = (await s.post('/finance/accounts').send({ name: 'Synthetic USD', type: 'BANK', currency: 'USD', isDedicatedCampaignAccount: false }).expect(201)).body.id;
    const inc = (await s.post('/finance/categories').send({ code: 'INC', name: 'Donations', kind: 'INCOME' }).expect(201)).body.id;
    const exp = (await s.post('/finance/categories').send({ code: 'EXP', name: 'Venues', kind: 'EXPENSE' }).expect(201)).body.id;
    await s.post('/finance/settings/limits').send({ kind: 'SPENDING_LIMIT', label: 'Synthetic spending limit', valueMinor: 1_000_000, currency: 'KES', periodLabel: 'Synthetic', effectiveFrom: '2027-01-01', legalSourceNote: NOTE, enforcement: 'WARN' }).expect(201);
    const cap = (await s.post('/finance/settings/limits').send({ kind: 'SINGLE_SOURCE_CAP_PCT', label: 'Synthetic cap', valueBasisPoints: 2000, capBasis: 'SPENDING_LIMIT', periodLabel: 'Synthetic', effectiveFrom: '2027-01-01', legalSourceNote: NOTE, enforcement: 'BLOCK' }).expect(201)).body;
    await f.http('approver2').post(`/finance/settings/limits/${cap.id}/verify`).send({ verified: true, reason: 'Second-person check (synthetic)' }).expect(200);
    const src = (await f.http('officer').post('/finance/contribution-sources').send({ displayName: 'Synthetic Donor Nafula', kind: 'INDIVIDUAL', identifier: '31222333' }).expect(201)).body;
    await f.http('approver2').patch(`/finance/contribution-sources/${src.id}`).send({ displayName: 'Synthetic Donor Nafula', kind: 'INDIVIDUAL', declared: true }).expect(200);

    const make = async (ref: string) => {
      const t = (
        await f
          .http('officer')
          .post('/finance/transactions')
          .send({ type: 'CONTRIBUTION', accountId: kes, categoryId: inc, contributionSourceId: src.id, amountMinor: 150_000, currency: 'KES', transactionDate: '2027-03-01', description: 'Synthetic contribution', externalReference: ref })
          .expect(201)
      ).body;
      const file = (await f.http('officer').post('/finance/files').attach('file', syntheticPdf(), { filename: 'r.pdf', contentType: 'application/pdf' }).expect(201)).body;
      await markScannedClean(f.owner, file.id);
      await f.http('officer').post(`/finance/transactions/${t.id}/documents`).send({ fileId: file.id, kind: 'RECEIPT' }).expect(201);
      return (await f.http('officer').post(`/finance/transactions/${t.id}/transition`).send({ action: 'SUBMIT', expectedVersion: t.version }).expect(200)).body;
    };
    // Each is 15 % of the limit; together 30 % against a verified 20 % BLOCK cap.
    const [a, b] = [await make('RCPT-A'), await make('RCPT-B')];
    const results = await Promise.all(
      [a, b].map((t) => f.http('approver').post(`/finance/transactions/${t.id}/transition`).send({ action: 'APPROVE', acknowledgeWarnings: true, expectedVersion: t.version })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('LIMIT_EXCEEDED');

    // A USD expense is not converted or counted against the KES limit: a currency warning instead.
    const payee = (await f.http('officer').post('/finance/payees').send({ name: 'Synthetic Hire Co', kind: 'SUPPLIER' }).expect(201)).body.id;
    const usdExpense = (
      await f
        .http('officer')
        .post('/finance/transactions')
        .send({ type: 'EXPENSE', accountId: usd, categoryId: exp, payeeId: payee, amountMinor: 5_000_000, currency: 'USD', transactionDate: '2027-03-02', description: 'Synthetic USD hire', externalReference: 'INV-USD' })
        .expect(201)
    ).body;
    const flags = usdExpense.compliance.map((x: { flag: string }) => x.flag);
    expect(flags).toContain('CURRENCY_MISMATCH');
    expect(flags).not.toContain('SPENDING_LIMIT_EXCEEDED');
    const ledger = (await f.http('officer').get('/finance/ledger').expect(200)).body;
    expect(ledger.compliance.map((x: { flag: string }) => x.flag)).not.toContain('SPENDING_LIMIT_EXCEEDED');

    // Report totals never add KES and USD together.
    const preview = (await f.http('builder').post('/reports/preview').send({ datasetKey: 'finance.transactions', fields: ['reference', 'amountMinor', 'currency'], filters: [], groupBy: [] }).expect(200)).body;
    expect(preview.totals.amountMinor).toBeUndefined();
    expect(preview.filtersDescription).toContain('several currencies');
    const byCurrency = (await f.http('builder').post('/reports/preview').send({ datasetKey: 'finance.transactions', fields: ['currency', 'amountMinor'], filters: [], groupBy: ['currency'] }).expect(200)).body;
    expect(byCurrency.rows.find((r: { currency: string }) => r.currency === 'USD').amountMinor).toBe(5_000_000);
    // A filter on an enum column runs in the query (complete under the row cap).
    const onlyExpenses = (await f.http('builder').post('/reports/preview').send({ datasetKey: 'finance.transactions', fields: ['reference', 'type'], filters: [{ field: 'type', op: 'eq', value: 'EXPENSE' }], groupBy: [] }).expect(200)).body;
    expect(onlyExpenses.rows.every((r: { type: string }) => r.type === 'EXPENSE')).toBe(true);
    expect(onlyExpenses.appliedScope).not.toContain('incomplete');
  });
});

describeDb('Campaign review fixes: tasks, breaches, comms, events, reports and alerts (integration)', () => {
  let f: CampaignFixture;
  let dept: { id: string; path: string; depth: number };
  const TASKS = ['tasks.view', 'tasks.create', 'tasks.assign'] as const;

  beforeAll(async () => {
    f = await createCampaignFixture({
      manager: { perms: [...TASKS, 'tasks.review', 'tasks.manage_all', 'org.departments.all'] },
      owner: { perms: [...TASKS, 'tasks.review'] },
      other: { perms: [...TASKS, 'tasks.review'] },
      reviewer: { perms: ['tasks.view', 'tasks.review'] },
      recorder: { perms: ['security.breach.record'] },
      recorder2: { perms: ['security.breach.record'] },
      dpo: { perms: ['security.breach.view', 'security.breach.record', 'security.breach.manage'] },
      dpo2: { perms: ['security.breach.view', 'security.breach.record', 'security.breach.manage'] },
      author: { perms: ['comms.content.view', 'comms.content.draft', 'events.view', 'events.create'] },
      editor: { perms: ['comms.content.view', 'comms.content.edit', 'comms.content.approve'] },
      approver: { perms: ['comms.content.view', 'comms.content.approve', 'comms.content.publish'] },
      viewer: { perms: ['reports.view', 'reports.export', 'tasks.view'] },
    });
    dept = await seedDepartment(f, 'VOL', 'Volunteers (synthetic)');
    const team = await f.owner.team.create({ data: { tenantId: f.tenantId, departmentId: dept.id, name: 'Volunteer desk (synthetic)', createdById: f.users.manager! } });
    for (const w of ['author', 'owner', 'other']) await f.owner.teamMember.create({ data: { tenantId: f.tenantId, teamId: team.id, userId: f.users[w]!, addedById: f.users.manager! } });
  });
  afterAll(async () => f?.close());

  it('the task review step cannot be removed or redirected by the owner', async () => {
    const o = f.http('owner');
    let t = (await o.post('/tasks').send({ title: 'Synthetic leaflet run', ownerId: f.users.owner, reviewerId: f.users.reviewer, status: 'READY', departmentId: dept.id }).expect(201)).body;
    t = (await o.post(`/tasks/${t.id}/status`).send({ toStatus: 'IN_PROGRESS', expectedVersion: t.version }).expect(200)).body;
    // Removing the reviewer to complete directly.
    await o.post(`/tasks/${t.id}/assign`).send({ reviewerId: null, expectedVersion: t.version }).expect(403);
    // Handing ownership over and naming oneself reviewer.
    await o.post(`/tasks/${t.id}/assign`).send({ ownerId: f.users.other, reviewerId: f.users.owner, expectedVersion: t.version }).expect(403);
    t = (await o.post(`/tasks/${t.id}/status`).send({ toStatus: 'SUBMITTED_FOR_REVIEW', expectedVersion: t.version }).expect(200)).body;
    // Frozen while awaiting review, even for a pure ownership move.
    expect((await o.post(`/tasks/${t.id}/assign`).send({ ownerId: f.users.other, expectedVersion: t.version }).expect(409)).body.details.reason).toBe('REVIEW_PENDING');
    // A manager may change the reviewer, with a reason, but never to a past owner.
    await f.http('manager').post(`/tasks/${t.id}/assign`).send({ reviewerId: f.users.other, expectedVersion: t.version }).expect(400);
    t = (await f.http('manager').post(`/tasks/${t.id}/assign`).send({ reviewerId: f.users.other, note: 'Reviewer on leave (synthetic)', expectedVersion: t.version }).expect(200)).body;
    t = (await f.http('other').post(`/tasks/${t.id}/review`).send({ decision: 'RETURN', note: 'Add the route map', expectedVersion: t.version }).expect(200)).body;

    // A past owner cannot be named reviewer, nor review.
    let u = (await o.post('/tasks').send({ title: 'Synthetic venue walk', ownerId: f.users.owner, status: 'READY', departmentId: dept.id }).expect(201)).body;
    u = (await o.post(`/tasks/${u.id}/assign`).send({ ownerId: f.users.other, expectedVersion: u.version }).expect(200)).body;
    expect((await f.http('other').post(`/tasks/${u.id}/assign`).send({ reviewerId: f.users.owner, expectedVersion: u.version }).expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('breach notes and details stay with viewers and the reporter', async () => {
    const b = (
      await f
        .http('recorder')
        .post('/security/breaches')
        .send({ title: 'Synthetic misdirected e-mail', description: 'Synthetic: a roster went to the wrong list.', isDrill: true, severity: 'LOW', detectedAt: new Date(Date.now() - 600_000).toISOString(), dataCategories: ['STAFF_CONTACT'] })
        .expect(201)
    ).body;
    // Another recorder without security.breach.view learns nothing, not even through a stale-version conflict.
    const other = await f.http('recorder2').post(`/security/breaches/${b.id}/events`).send({ type: 'NOTE', note: 'Peek', expectedVersion: b.version + 5 }).expect(404);
    expect(JSON.stringify(other.body)).not.toContain('roster');
    await f.http('recorder2').post(`/security/breaches/${b.id}/events`).send({ type: 'NOTE', note: 'Peek', expectedVersion: b.version }).expect(404);
    // The reporter may still add a note to their own record.
    expect((await f.http('recorder').post(`/security/breaches/${b.id}/events`).send({ type: 'NOTE', note: 'More detail (synthetic)', expectedVersion: b.version }).expect(200)).body.timeline).toHaveLength(2);
  });

  it('critical-alert escalation happens once per alert and never duplicates open alerts', async () => {
    const b = (
      await f
        .http('recorder')
        .post('/security/breaches')
        .send({ title: 'Synthetic lost tablet', description: 'Synthetic drill: tablet reported lost.', isDrill: true, severity: 'CRITICAL', detectedAt: new Date(Date.now() - 600_000).toISOString(), dataCategories: ['AGENT_PERSONAL_DATA'] })
        .expect(201)
    ).body;
    const alert = await f.owner.notification.findFirstOrThrow({ where: { userId: f.users.dpo, entityId: b.id } });
    const first = await f.http('dpo').post(`/notifications/${alert.id}/acknowledge`).send({ action: 'ESCALATED', note: 'Needs the DPO lead' });
    expect(first.status).toBe(200);
    expect((await f.http('dpo').post(`/notifications/${alert.id}/acknowledge`).send({ action: 'ESCALATED' }).expect(409)).body.details.reason).toBe('ALREADY_ESCALATED');
    // dpo2 still holds the open alert from the recording: no second copy.
    expect(await f.owner.notification.count({ where: { userId: f.users.dpo2, entityId: b.id } })).toBe(1);
    await expect(f.owner.notificationAcknowledgement.create({ data: { tenantId: f.tenantId, notificationId: alert.id, userId: f.users.dpo!, action: 'ESCALATED' } })).rejects.toThrow(/ALREADY_ESCALATED/);
  });

  it('editors from other departments review content; the editor who rewrote it cannot approve it; the event lists approved content', async () => {
    const now = Date.now();
    const ev = (await f.http('author').post('/events').send({ title: 'Synthetic volunteer briefing', type: 'TRAINING', startsAt: new Date(now + 86_400_000).toISOString(), endsAt: new Date(now + 90_000_000).toISOString(), organiserId: f.users.author, departmentId: dept.id }).expect(201)).body;
    let c = (await f.http('author').post('/comms/content').send({ type: 'EVENT_INFO', title: 'Volunteer briefing details', body: 'Synthetic briefing on Saturday.', audience: 'INTERNAL_ALL', departmentId: dept.id, eventId: ev.id }).expect(201)).body;
    const tr = (who: string, action: string) => f.http(who).post(`/comms/content/${c.id}/transition`).send({ action, expectedVersion: c.version });
    c = (await tr('author', 'SUBMIT').expect(200)).body;
    // The editor belongs to no department but sees the item awaiting editorial review.
    const queue = (await f.http('editor').get('/comms/content?view=awaiting_me').expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(queue).toContain(c.id);
    c = (await f.http('editor').patch(`/comms/content/${c.id}`).send({ body: 'Synthetic briefing on Saturday at 09:00.', departmentId: dept.id, expectedVersion: c.version }).expect(200)).body;
    c = (await tr('editor', 'EDITORIAL_APPROVE').expect(200)).body;
    expect(c.allowedActions).not.toContain('APPROVE');
    expect((await tr('editor', 'APPROVE').expect(403)).body.code).toBe('SEPARATION_OF_DUTIES');
    c = (await tr('approver', 'APPROVE').expect(200)).body;
    c = (await tr('approver', 'PUBLISH').expect(200)).body;
    const detail = (await f.http('author').get(`/events/${ev.id}`).expect(200)).body;
    expect(detail.communications).toEqual([expect.objectContaining({ id: c.id, status: 'PUBLISHED', reference: c.reference })]);
  });

  it('reports.view alone exports standard reports only, as it previews', async () => {
    const custom = { datasetKey: 'campaign.tasks', fields: ['reference', 'status'], filters: [], groupBy: [] };
    await f.http('viewer').post('/reports/preview').send(custom).expect(403);
    await f.http('viewer').post('/reports/exports').send({ definition: custom, format: 'CSV' }).expect(403);
    const standard = { datasetKey: 'campaign.tasks', fields: ['teamName', 'status'], filters: [], groupBy: ['teamName', 'status'] };
    await f.http('viewer').post('/reports/exports').send({ definition: standard, format: 'CSV' }).expect(201);
  });
});
