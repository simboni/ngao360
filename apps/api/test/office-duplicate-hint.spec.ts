/** Triage duplicate-possibility hint (blueprint 9.2): pure ranking, no database. */
import { keywords, rankPossibleDuplicates, similarity } from '../src/modules/office/cases/case-support';

const base = {
  id: 'subject',
  category: 'WATER_SANITATION',
  wardId: 'w1',
  constituencyId: 'k1',
  title: 'Water and sanitation — Township ward',
  description: 'The community borehole near Township market has stopped working and no water flows.',
  submittedAt: new Date('2026-11-20T08:00:00Z'),
};

describe('duplicate-possibility hint', () => {
  it('ignores short and common words', () => {
    expect([...keywords('The borehole has NOT worked, near the market!')].sort()).toEqual(['borehole', 'market', 'worked']);
    expect(similarity(new Set(), new Set(['a']))).toBe(0);
  });

  it('ranks similar reports in the same ward and category within the window', () => {
    const candidates = [
      { ...base, id: 'same', description: 'Borehole at Township market stopped working, no water for the community.' },
      { ...base, id: 'otherWard', wardId: 'w2', description: base.description },
      { ...base, id: 'otherCategory', category: 'HEALTH', description: base.description },
      { ...base, id: 'old', submittedAt: new Date('2026-09-01T08:00:00Z'), description: base.description },
      { ...base, id: 'unrelated', description: 'Streetlights along the bus park are off at night.' },
      { ...base, id: 'subject' },
    ];
    const ranked = rankPossibleDuplicates(base, candidates);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['same']);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(0.25);
  });

  it('falls back to the constituency when no ward is known, and gives no hint without a location', () => {
    const noWard = { ...base, wardId: null };
    const ranked = rankPossibleDuplicates(noWard, [{ ...base, id: 'k1', wardId: 'w9' }]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['k1']);
    expect(rankPossibleDuplicates({ ...base, wardId: null, constituencyId: null }, [{ ...base, id: 'x', wardId: null, constituencyId: null }])).toEqual([]);
  });
});
