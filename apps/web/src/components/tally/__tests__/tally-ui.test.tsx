/**
 * Component and logic tests for the NGAO TALLY screens.
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/tally/__tests__/tsconfig.json --test src/components/tally/__tests__/*.test.ts src/components/tally/__tests__/*.test.tsx
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type CandidateTotal,
  type Coverage,
  type DiscrepancyCaseDetail,
  findForbiddenTallyLanguage,
  type MeResponse,
  type SubmissionDetail,
} from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ballotOrder, coverageSegments, denominatorLabel, niceMax, shareOfVerified } from '../aggregate-math';
import { CoverageBadge } from '../badges';
import { CandidateBarChart, CoverageBar } from '../charts';
import { arithmeticFailures, manualTransitions, normaliseComparison } from '../discrepancy-model';
import { checkSourceFile } from '../upload-dialog';
import { verifyBlockReason } from '../verify-model';

const coverage: Coverage = {
  expectedStations: 153,
  received: 40,
  transcribed: 30,
  awaitingReview: 8,
  verified: 20,
  flagged: 3,
  excluded: 1,
  missing: 113,
  verifiedPercent: 13.07,
};

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const candidates: CandidateTotal[] = [
  { candidateReferenceId: C2, candidateNameAsPublished: 'Synthetic Candidate Beta', partyLabel: null, ballotOrder: 2, verifiedVotes: 900, shareOfVerifiedValidVotes: 60 },
  { candidateReferenceId: C1, candidateNameAsPublished: 'Synthetic Candidate Alpha', partyLabel: 'Demo Party', ballotOrder: 1, verifiedVotes: 600, shareOfVerifiedValidVotes: 40 },
];

describe('aggregate presentation', () => {
  it('splits the denominator into exclusive segments that sum to expected stations', () => {
    const segs = coverageSegments(coverage);
    assert.equal(segs.reduce((a, s) => a + s.count, 0), coverage.expectedStations);
    assert.equal(segs.find((s) => s.key === 'missing')!.count, 113);
    assert.equal(segs.find((s) => s.key === 'receivedOther')!.count, 8);
  });

  it('always states the denominator', () => {
    assert.equal(denominatorLabel(20, 153), '20 of 153 expected stations (13.1%)');
  });

  it('keeps ballot order and never ranks by votes', () => {
    assert.deepEqual(ballotOrder(candidates).map((c) => c.ballotOrder), [1, 2]);
  });

  it('computes shares of verified valid votes and shows none when nothing is verified', () => {
    assert.equal(shareOfVerified(candidates[0]!, 1500), 60);
    assert.equal(shareOfVerified(candidates[0]!, 0), null);
  });

  it('rounds axis maxima to readable values', () => {
    assert.equal(niceMax(900), 1000);
    assert.equal(niceMax(0), 1);
  });
});

describe('charts', () => {
  it('renders the candidate chart in ballot order with accessible labels and no outcome language', () => {
    const html = renderToStaticMarkup(<CandidateBarChart candidates={candidates} totalVerifiedValid={1500} />);
    assert.ok(html.indexOf('Synthetic Candidate Alpha') < html.indexOf('Synthetic Candidate Beta'));
    assert.match(html, /aria-label="Synthetic Candidate Beta: 900 verified votes, 60.00% of verified valid votes"/);
    assert.equal(findForbiddenTallyLanguage(html), null);
  });

  it('describes missing stations in the coverage bar instead of hiding them', () => {
    const html = renderToStaticMarkup(<CoverageBar coverage={coverage} label="Overall" />);
    assert.match(html, /Missing \(no form yet\) 113/);
    assert.match(html, /153 expected stations/);
  });

  it('shows coverage status as a word with an icon', () => {
    const html = renderToStaticMarkup(<CoverageBadge status="MISSING" />);
    assert.match(html, /Missing \(no form\)/);
    assert.match(html, /<svg/);
  });
});

describe('verification separation of duties', () => {
  const me = { user: { id: C1, email: 'clerk@demo.example.org', displayName: 'Clerk', status: 'ACTIVE', mfaEnabled: false } } as MeResponse;
  const base = {
    status: 'SECOND_REVIEW_PENDING',
    allowedActions: [],
    submitter: { id: C2, displayName: 'Agent' },
    values: [],
    verifications: [],
  } as unknown as SubmissionDetail;

  it('explains when the reviewer submitted the form', () => {
    const r = verifyBlockReason({ ...base, submitter: { id: C1, displayName: 'Clerk' } }, me, true);
    assert.match(r!, /You submitted this form/);
  });

  it('explains when the reviewer captured values', () => {
    const values = [{ confirmedBy: { id: C1, displayName: 'Clerk' } }] as unknown as SubmissionDetail['values'];
    assert.match(verifyBlockReason({ ...base, values }, me, true)!, /You captured or changed values/);
  });

  it('allows verification when the server lists VERIFY', () => {
    assert.equal(verifyBlockReason({ ...base, allowedActions: ['VERIFY'] }, me, true), null);
  });
});

describe('discrepancy comparison', () => {
  it('maps reviewer disagreement to captured vs second reviewer', () => {
    const cmp = normaliseComparison({
      varianceType: 'REVIEWER_DISAGREEMENT',
      details: { comparison: [{ cell: `candidate_votes:${C1}`, fieldKey: 'candidate_votes', candidateReferenceId: C1, captured: 120, independent: 125, difference: 5 }] },
    } as Pick<DiscrepancyCaseDetail, 'varianceType' | 'details'>);
    assert.equal(cmp!.labelB, 'Second reviewer');
    assert.deepEqual(cmp!.rows[0], { key: `candidate_votes:${C1}`, fieldKey: 'candidate_votes', candidateReferenceId: C1, sourceA: 120, sourceB: 125, difference: 5 });
  });

  it('maps cross-stage differences to source A and B', () => {
    const cmp = normaliseComparison({
      varianceType: 'CROSS_STAGE_MISMATCH',
      details: { comparison: [{ fieldKey: 'total_valid_votes', candidateReferenceId: null, sourceA: 1000, sourceB: 990, difference: -10 }] },
    } as Pick<DiscrepancyCaseDetail, 'varianceType' | 'details'>);
    assert.match(cmp!.labelA, /Source A/);
    assert.equal(cmp!.rows[0]!.difference, -10);
  });

  it('reads arithmetic failures and allowed manual transitions', () => {
    assert.equal(arithmeticFailures({ details: { failures: [{ ruleKey: 'SUM', fieldKeys: ['a'], expected: 3 }] } })[0]!.extra.expected, 3);
    assert.deepEqual(manualTransitions('OPEN'), ['UNDER_REVIEW', 'ESCALATED']);
    assert.deepEqual(manualTransitions('CLOSED'), []);
  });
});

describe('upload checks', () => {
  it('accepts images and PDFs within the size limit only', () => {
    assert.equal(checkSourceFile({ type: 'application/pdf', size: 1000 }), null);
    assert.match(checkSourceFile({ type: 'text/plain', size: 10 })!, /JPEG/);
    assert.match(checkSourceFile({ type: 'image/png', size: 26 * 1024 * 1024 })!, /larger/);
  });
});

describe('tally UI copy', () => {
  it('never uses winner / elected / declared language in tally screens', () => {
    const roots = [join(__dirname, '..'), join(__dirname, '..', '..', '..', 'app', '(app)', 'tally')];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) {
          if (f !== '__tests__') walk(p);
        } else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    roots.forEach(walk);
    assert.ok(files.length > 10);
    for (const f of files) {
      // Strip comments, which may cite the rule itself.
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.equal(findForbiddenTallyLanguage(src), null, `forbidden outcome wording in ${f}`);
    }
  });
});
