/**
 * Mobile PWA helpers: conflict choices, queue wording, report answers, dates,
 * incident wording hints and photo preparation helpers. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FieldReportTemplateSchema, MyAssignment } from '@ngao360/shared';
import { fitWithin, jpegHasExif } from '@/lib/offline/image';
import {
  answerIssues,
  buildAnswers,
  coerceAnswer,
  conflictChoice,
  descriptionHints,
  fromLocalInputValue,
  isTooFarInFuture,
  pendingTargets,
  queueHeadline,
  queueStateText,
  rejectedExplanation,
  stationOptions,
  toLocalInputValue,
} from '../mobile-model';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('conflict choices (never overwrite the server)', () => {
  it('a key reused with different content can only be sent again as a new record', () => {
    const c = conflictChoice('INCIDENT', 'IDEMPOTENCY_KEY_REUSED', null);
    assert.equal(c.canResubmit, true);
    assert.equal(c.expectedVersion, undefined);
  });
  it('a replaced or cancelled assignment cannot be checked into', () => {
    assert.equal(conflictChoice('CHECK_IN', 'SERVER_CHANGED', { status: 'REPLACED', version: 4 }).canResubmit, false);
    assert.equal(conflictChoice('ASSIGNMENT_CONFIRMATION', 'SERVER_CHANGED', { status: 'CANCELLED', version: 4 }).canResubmit, false);
  });
  it('an already checked-in assignment needs no second check-in', () => {
    assert.equal(conflictChoice('CHECK_IN', 'SERVER_CHANGED', { status: 'CHECKED_IN', version: 5 }).canResubmit, false);
    assert.equal(conflictChoice('ASSIGNMENT_CONFIRMATION', 'SERVER_CHANGED', { status: 'CONFIRMED', version: 5 }).canResubmit, false);
  });
  it('a still-active assignment with a newer version may be resent against that version', () => {
    const c = conflictChoice('CHECK_IN', 'SERVER_CHANGED', { status: 'CONFIRMED', version: 3 });
    assert.equal(c.canResubmit, true);
    assert.equal(c.expectedVersion, 3);
  });
  it('a report against a retired form must be filled in again on the current form', () => {
    assert.equal(conflictChoice('FIELD_REPORT', 'SERVER_CHANGED', { status: 'RETIRED', version: 1 }).canResubmit, false);
  });
});

describe('queue wording', () => {
  it('never calls a local save uploaded', () => {
    const base = { phase: 'SEND' as const, retryCount: 0, errorCode: null, serverReference: null };
    assert.match(queueStateText({ ...base, state: 'SAVED_LOCALLY' }), /Saved on this phone/);
    assert.match(queueStateText({ ...base, state: 'SAVED_LOCALLY', retryCount: 2 }), /will retry/);
    assert.match(queueStateText({ ...base, state: 'CONFIRMED', serverReference: 'INC-2027-000101' }), /INC-2027-000101/);
    assert.match(queueStateText({ ...base, state: 'SAVED_LOCALLY', phase: 'ATTACH_EVIDENCE', serverReference: 'FRP-2027-000201' }), /photo still uploading/);
  });
  it('headline puts decisions first', () => {
    assert.match(queueHeadline({ pending: 3, retrying: 0, sent: 1, failed: 1, conflict: 2 }, true), /2 items need your decision/);
    assert.match(queueHeadline({ pending: 1, retrying: 0, sent: 0, failed: 0, conflict: 0 }, false), /saved on this phone/);
    assert.match(queueHeadline({ pending: 0, retrying: 0, sent: 4, failed: 0, conflict: 0 }, true), /reached the server/);
  });
  it('explains refusals in plain words', () => {
    assert.match(rejectedExplanation('STALE', null), /too long ago/);
    assert.match(rejectedExplanation('OUT_OF_SCOPE', null), /not one you are assigned/);
  });
  it('blocks a second tap while an item for the same target is unsent or in conflict', () => {
    const t = pendingTargets(
      [
        { kind: 'CHECK_IN', state: 'SAVED_LOCALLY', targetId: U(1) },
        { kind: 'CHECK_IN', state: 'CONFIRMED', targetId: U(2) },
        { kind: 'CHECK_IN', state: 'CONFLICT', targetId: U(3) },
        { kind: 'ASSIGNMENT_CONFIRMATION', state: 'SAVED_LOCALLY', targetId: U(4) },
      ],
      'CHECK_IN',
    );
    assert.deepEqual([...t].sort(), [U(1), U(3)]);
  });
});

describe('field report answers', () => {
  const schema: FieldReportTemplateSchema = {
    allowEvidence: true,
    sections: [
      {
        key: 'opening',
        title: 'Opening',
        questions: [
          { key: 'opened_on_time', label: 'Did the station open on time?', type: 'YES_NO', required: true },
          { key: 'opening_time', label: 'Opening time', type: 'TIME', required: false },
          { key: 'agents_present', label: 'Agents present', type: 'NUMBER', required: false, min: 0, max: 50 },
          {
            key: 'materials',
            label: 'Materials present',
            type: 'MULTI_CHOICE',
            required: false,
            options: [
              { value: 'ballots', label: 'Ballot papers' },
              { value: 'register', label: 'Register' },
            ],
          },
        ],
      },
    ],
  };
  it('coerces form values to typed answers and leaves out empty ones', () => {
    const a = buildAnswers(schema, { opened_on_time: false, opening_time: '06:40', agents_present: '3', materials: [] });
    assert.deepEqual(a, { opened_on_time: false, opening_time: '06:40', agents_present: 3 });
  });
  it('reports issues per question with the shared validator', () => {
    const issues = answerIssues(schema, buildAnswers(schema, { agents_present: '99' }));
    assert.equal(issues.opened_on_time, 'Required');
    assert.match(issues.agents_present!, /between 0 and 50/);
  });
  it('keeps non-numeric input as text so the validator flags it', () => {
    assert.equal(coerceAnswer({ type: 'NUMBER' }, 'abc'), 'abc');
    assert.equal(coerceAnswer({ type: 'YES_NO' }, 'yes'), true);
  });
});

describe('dates', () => {
  it('round-trips datetime-local values in the phone time zone', () => {
    const d = new Date(2027, 7, 9, 6, 45);
    const v = toLocalInputValue(d);
    assert.equal(v, '2027-08-09T06:45');
    assert.equal(fromLocalInputValue(v), d.toISOString());
    assert.equal(fromLocalInputValue('not a date'), null);
  });
  it('refuses device times more than five minutes ahead', () => {
    const now = new Date('2027-08-09T06:00:00Z');
    assert.equal(isTooFarInFuture('2027-08-09T06:04:00Z', now), false);
    assert.equal(isTooFarInFuture('2027-08-09T06:06:00Z', now), true);
  });
});

describe('incident wording hints (factual, not accusatory)', () => {
  it('flags conclusions, names and phone numbers without blocking', () => {
    assert.equal(descriptionHints('The station opened 40 minutes late.').length, 0);
    assert.ok(descriptionHints('The election was rigged here').some((h) => /conclusions/.test(h)));
    assert.ok(descriptionHints('Mr. Wekesa told voters to leave').some((h) => /naming people/.test(h)));
    assert.ok(descriptionHints('Call 0712 345 678').some((h) => /phone numbers/.test(h)));
  });
});

describe('station options', () => {
  it('lists each active assigned station once', () => {
    const loc = (code: string) => ({
      electionCycleId: U(9),
      county: { id: U(1), name: 'Bungoma' },
      constituency: { id: U(2), name: 'Kanduyi' },
      ward: { id: U(3), name: 'Township' },
      pollingCentre: null,
      station: { code, name: `Synthetic School ${code.slice(-2)}`, id: U(4), inApprovedRegistry: true },
    });
    const a = [
      { status: 'CONFIRMED', location: loc('039001000101') },
      { status: 'CHECKED_IN', location: loc('039001000101') },
      { status: 'REPLACED', location: loc('039001000102') },
      { status: 'ASSIGNED', location: loc('039001000103') },
    ] as Pick<MyAssignment, 'status' | 'location'>[];
    assert.deepEqual(
      stationOptions(a).map((o) => o.code),
      ['039001000101', '039001000103'],
    );
  });
});

describe('photo helpers', () => {
  it('fits within the long edge without upscaling', () => {
    assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 });
    assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 });
    assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  });
  it('detects an EXIF block in a JPEG header', () => {
    const exif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda]);
    const clean = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x00]);
    assert.equal(jpegHasExif(exif.buffer), true);
    assert.equal(jpegHasExif(clean.buffer), false);
  });
});

describe('service worker never caches API traffic or queued records', () => {
  it('keeps /api and non-GET requests out of the cache', () => {
    const sw = readFileSync(join(__dirname, '../../../../public/sw.js'), 'utf8');
    assert.match(sw, /startsWith\('\/api\/'\)\) return/);
    assert.match(sw, /req\.method !== 'GET'\) return/);
  });
});

describe('mobile screens wording', () => {
  it('no mobile screen calls the parallel tally official or labels people', () => {
    const dir = join(__dirname, '..');
    const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && f.endsWith('.tsx'));
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const stripped = text.replace(/(never|not) an official result|official result form/gi, '');
      assert.ok(!/official result/i.test(stripped), `${f} must not present an official result`);
      assert.ok(!/\b(winner|declared winner)\b/i.test(text), `${f} must not use winner wording`);
    }
  });
});
