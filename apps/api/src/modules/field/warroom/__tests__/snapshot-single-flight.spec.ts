import { WarRoomService } from '../warroom.service';

/**
 * Load test finding (docs/OPERATIONS.md): when the 15 s War Room snapshot expired under load, every
 * concurrent request re-ran the 55k-station query (p95 5.7 s). The snapshot is now single flight.
 */
describe('War Room snapshot single flight', () => {
  const prev = process.env.FIELD_WARROOM_CACHE_SECONDS;
  beforeAll(() => {
    process.env.FIELD_WARROOM_CACHE_SECONDS = '15';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.FIELD_WARROOM_CACHE_SECONDS;
    else process.env.FIELD_WARROOM_CACHE_SECONDS = prev;
  });

  function make() {
    const svc = new WarRoomService({} as never, {} as never, {} as never, {} as never, {} as never);
    let calls = 0;
    let fail = false;
    jest.spyOn(svc, 'readStations').mockImplementation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      if (fail) throw new Error('boom');
      return [];
    });
    const tx = { $executeRawUnsafe: jest.fn(async () => 0) };
    const snapshot = (tenantId: string) =>
      (svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ at: Date }> }).snapshot(
        tx,
        { tenantId },
        { id: 'cycle-1', electionDate: new Date('2027-08-10') },
        'reg-1',
      );
    return { svc, snapshot, calls: () => calls, setFail: (v: boolean) => (fail = v) };
  }

  it('runs one computation for concurrent callers of the same tenant, and serves the cache after', async () => {
    const m = make();
    const results = await Promise.all(Array.from({ length: 10 }, () => m.snapshot('tenant-a')));
    expect(m.calls()).toBe(1);
    expect(new Set(results).size).toBe(1);
    await m.snapshot('tenant-a');
    expect(m.calls()).toBe(1);
  });

  it('never shares a computation across tenants', async () => {
    const m = make();
    const [a, b] = await Promise.all([m.snapshot('tenant-a'), m.snapshot('tenant-b')]);
    expect(m.calls()).toBe(2);
    expect(a).not.toBe(b);
  });

  it('a failed shared computation makes each waiting caller compute with its own transaction', async () => {
    const m = make();
    m.setFail(true);
    const first = m.snapshot('tenant-a');
    const second = m.snapshot('tenant-a');
    await expect(first).rejects.toThrow('boom');
    m.setFail(false);
    await expect(second).resolves.toBeDefined();
    expect(m.calls()).toBe(2);
  });
});

describe('War Room per-caller views are memoised per snapshot', () => {
  const scope = (o: Partial<{ orgWide: boolean; unitIds: string[]; stationKeys: string[] }>) =>
    ({ orgWide: false, unitIds: [], stationIds: [], stationKeys: [], ...o }) as never;
  const station = (code: string, wardId: string) =>
    ({
      code,
      cols: { electionCycleId: 'c', pollingStationCode: code, countyId: 'k', constituencyId: 'q', wardId, pollingCentreId: null },
    }) as never;

  it('reuses the derived array for the same scope and never for a different one', () => {
    const svc = new WarRoomService({} as never, {} as never, {} as never, {} as never, {} as never);
    const derive = jest.spyOn(svc as never, 'deriveViews' as never).mockImplementation(((st: unknown[], sc: { orgWide: boolean; unitIds: string[] }) =>
      (st as Array<{ code: string; cols: { wardId: string } }>).filter((s) => sc.orgWide || sc.unitIds.includes(s.cols.wardId))) as never);
    const views = (svc as unknown as { views: (...a: unknown[]) => unknown[] }).views.bind(svc);
    const snapA = [station('S1', 'w1'), station('S2', 'w2')];
    const all1 = views(snapA, scope({ orgWide: true }), null, {});
    const all2 = views(snapA, scope({ orgWide: true }), null, {});
    expect(all2).toBe(all1);
    const w1 = views(snapA, scope({ unitIds: ['w1'] }), null, {});
    expect(w1).toHaveLength(1);
    expect(w1).not.toBe(all1);
    // tally visibility and the area are part of the key
    expect(views(snapA, scope({ orgWide: true }), scope({ orgWide: true }), {})).not.toBe(all1);
    expect(views(snapA, scope({ orgWide: true }), null, { unitId: 'w2' })).not.toBe(all1);
    // a new snapshot array is never served from an old one's memo
    expect(views([...snapA], scope({ orgWide: true }), null, {})).not.toBe(all1);
    expect(derive).toHaveBeenCalledTimes(5);
  });
});
