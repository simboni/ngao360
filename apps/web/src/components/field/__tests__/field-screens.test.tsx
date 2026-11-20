/**
 * Desktop field screens (S13–S16, incident desk): model helpers and rendering.
 * Run with: pnpm --filter @ngao360/web test
 * All data below is synthetic.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type AgentDetail, completeness, findForbiddenTallyLanguage, type FieldLocation, type IncidentEvent, WAR_ROOM_LABEL } from '@ngao360/shared';
import { Activity } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccreditationBadge, IncidentStatusBadge, SeverityBadge } from '../common/field-badges';
import { auditActionLabel, buildTimeline, compareIncidentPriority, completenessText, formatAge, pairAssignments, stationLabel } from '../common/field-model';
import { CompletenessMeter } from '../common/field-ui';
import { agentStationCodes } from '../agents/agent-profile';
import { revealableFields, SensitivePanel } from '../agents/reveal-panel';
import { precheckAssignment } from '../deployment/deployment-model';
import { assigneeCandidates, corrections, describeEventData, sodHints } from '../incidents/incident-model';
import { readinessReasonRequired, statusSegments } from '../readiness/readiness-model';
import { Panel } from '../warroom/war-room-panels';
import { isStale, needsAttention, statusCounts } from '../warroom/warroom-model';

const CYCLE = '00000000-0000-4000-8000-0000000000c1';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function loc(code: string | null): FieldLocation {
  return {
    electionCycleId: CYCLE,
    county: { id: U(1), name: 'Bungoma' },
    constituency: { id: U(2), name: 'Kanduyi' },
    ward: { id: U(3), name: 'Township' },
    pollingCentre: null,
    station: code ? { code, name: 'Synthetic Primary School', id: U(4), inApprovedRegistry: true } : null,
  };
}

describe('completeness wording', () => {
  it('names missing stations as missing, never as zero', () => {
    const t = completenessText(completeness(153, 40));
    assert.equal(t.headline, '40 of 153 stations reported');
    assert.match(t.detail, /113 with no update \(missing, not zero\)/);
    assert.equal(t.percent, '26.1%');
    const html = renderToStaticMarkup(<CompletenessMeter value={completeness(153, 40)} />);
    assert.match(html, /role="meter"/);
    assert.match(html, /aria-valuetext="40 of 153 stations reported; 113 with no update \(missing, not zero\)"/);
  });
  it('handles an empty scope without a fake percentage', () => {
    assert.equal(completenessText(completeness(0, 0)).percent, '—');
  });
});

describe('labels and formatting', () => {
  it('labels stations by code and areas by ward', () => {
    assert.equal(stationLabel(loc('039-001')), '039-001 Synthetic Primary School');
    assert.equal(stationLabel(loc(null)), 'Township, Kanduyi');
  });
  it('formats queue ages', () => {
    assert.equal(formatAge(45), '45 min');
    assert.equal(formatAge(125), '2 h 05 min');
    assert.equal(formatAge(60 * 27), '1 d 3 h');
  });
  it('turns audit actions into words', () => {
    assert.equal(auditActionLabel('field.agent.sensitive_revealed'), 'Personal data revealed');
    assert.equal(auditActionLabel('field.agent.training_recorded'), 'Agent training recorded');
  });
  it('status badges carry a word and an icon', () => {
    for (const html of [
      renderToStaticMarkup(<SeverityBadge severity="CRITICAL" />),
      renderToStaticMarkup(<IncidentStatusBadge status="RESOLVED" />),
      renderToStaticMarkup(<AccreditationBadge status={null} />),
    ]) {
      assert.match(html, /<svg/);
      assert.match(html, /<span>[A-Z][a-z]/);
    }
  });
});

describe('agent personal data', () => {
  const agent = {
    id: U(10),
    phoneMasked: '+254 ••• ••• 678',
    nationalIdMasked: '••••• 321',
    hasMpesaNumber: false,
    hasNextOfKin: true,
    allowedActions: ['reveal_sensitive'],
  } as unknown as AgentDetail;

  it('offers only the fields that hold a value', () => {
    assert.deepEqual(revealableFields(agent), ['phone', 'nationalIdNumber', 'nextOfKin']);
  });
  it('renders masked values by default, with a reveal action only when allowed', () => {
    const html = renderToStaticMarkup(<SensitivePanel agent={agent} />);
    assert.match(html, /\+254 ••• ••• 678/);
    assert.match(html, /Recorded \(hidden\)/);
    assert.match(html, /Reveal…/);
    const none = renderToStaticMarkup(<SensitivePanel agent={{ ...agent, allowedActions: [] }} />);
    assert.doesNotMatch(none, /Reveal…/);
    assert.match(none, /Nobody can reveal their own agent record/);
  });
  it('looks up history for at most five stations', () => {
    const deployments = Array.from({ length: 7 }, (_, i) => ({ pollingStationCode: `039-00${i}` })).concat([{ pollingStationCode: '039-000' }]);
    assert.equal(agentStationCodes({ deployments } as unknown as AgentDetail).length, 5);
  });
});

describe('deployment planner', () => {
  const station = {
    pollingStationCode: '039-001',
    pollingStationName: 'Synthetic Primary',
    slots: [{ role: 'CHIEF_AGENT' as const, shift: 'FULL_DAY' as const, deploymentId: U(20), agentId: U(22), agentDisplayName: 'Agent A (synthetic)', status: 'ASSIGNED' as const }],
  };
  const agent = { id: U(21), displayName: 'Agent B (synthetic)', status: 'ACTIVE' as const, accreditationStatus: 'PENDING' as const };

  it('pairs selected agents with selected stations in order and reports leftovers', () => {
    const r = pairAssignments(['a1', 'a2'], ['s1', 's2', 's3']);
    assert.deepEqual(r.pairs, [
      { agent: 'a1', station: 's1' },
      { agent: 'a2', station: 's2' },
    ]);
    assert.deepEqual(r.unmatchedStations, ['s3']);
    assert.deepEqual(r.unmatchedAgents, []);
  });
  it('warns about a second chief agent (blocking) and missing accreditation (warning)', () => {
    const c = precheckAssignment({ agent, station, role: 'CHIEF_AGENT', shift: 'OPENING' }, [station]);
    assert.ok(c.some((x) => x.kind === 'SLOT_ALREADY_FILLED' && x.blocking));
    assert.ok(c.some((x) => x.kind === 'AGENT_NOT_ACCREDITED' && !x.blocking));
    const ok = precheckAssignment({ agent: { ...agent, accreditationStatus: 'APPROVED' }, station, role: 'STATION_AGENT', shift: 'FULL_DAY' }, [station]);
    assert.equal(ok.length, 0);
  });
  it('flags a double booking by agent id, not by name', () => {
    const sameName = precheckAssignment({ agent: { ...agent, accreditationStatus: 'APPROVED', displayName: 'Agent A (synthetic)' }, station: { ...station, slots: [] }, role: 'RUNNER', shift: 'OPENING' }, [station]);
    assert.ok(!sameName.some((x) => x.kind === 'AGENT_DOUBLE_BOOKED'));
    const sameAgent = precheckAssignment({ agent: { ...agent, id: U(22), accreditationStatus: 'APPROVED' }, station: { ...station, slots: [] }, role: 'RUNNER', shift: 'OPENING' }, [station]);
    assert.ok(sameAgent.some((x) => x.kind === 'AGENT_DOUBLE_BOOKED' && x.blocking));
  });
  it('blocks inactive agents', () => {
    const c = precheckAssignment({ agent: { ...agent, status: 'INACTIVE' as never }, station, role: 'RUNNER', shift: 'FULL_DAY' }, []);
    assert.ok(c.some((x) => x.kind === 'AGENT_NOT_ACTIVE' && x.blocking));
  });
});

describe('readiness', () => {
  it('requires a reason for blocked, not applicable and reopening a done item', () => {
    assert.equal(readinessReasonRequired('IN_PROGRESS', 'BLOCKED'), true);
    assert.equal(readinessReasonRequired('NOT_STARTED', 'NOT_APPLICABLE'), true);
    assert.equal(readinessReasonRequired('DONE', 'IN_PROGRESS'), true);
    assert.equal(readinessReasonRequired('IN_PROGRESS', 'DONE'), false);
    assert.equal(readinessReasonRequired('DONE', 'DONE'), false);
  });
  it('shows stations without a checklist as their own segment, never as ready', () => {
    const segs = statusSegments({ expectedStations: 153, stationsWithChecklist: 98, byStatus: [{ status: 'READY', count: 30 }, { status: 'BLOCKED', count: 5 }] });
    assert.equal(segs.find((s) => s.key === 'NO_CHECKLIST')!.count, 55);
    assert.equal(segs.find((s) => s.key === 'READY')!.count, 30);
    assert.equal(segs.reduce((a, s) => a + s.count, 0), 90);
  });
});

describe('incidents', () => {
  const ev = (type: IncidentEvent['type'], data: Record<string, unknown> = {}): IncidentEvent => ({
    id: U(Math.floor(Math.random() * 1e6)),
    type,
    fromStatus: null,
    toStatus: null,
    note: 'Synthetic note',
    data,
    fileIds: [],
    actor: { id: U(30), displayName: 'Desk officer (synthetic)' },
    createdAt: '2027-08-09T08:00:00Z',
  });
  it('orders the queue by severity, then by age', () => {
    const rows = [
      { severity: 'MEDIUM' as const, reportedAt: '2027-08-09T07:00:00Z' },
      { severity: 'CRITICAL' as const, reportedAt: '2027-08-09T09:00:00Z' },
      { severity: 'CRITICAL' as const, reportedAt: '2027-08-09T08:00:00Z' },
    ].sort(compareIncidentPriority);
    assert.deepEqual(rows.map((r) => r.reportedAt), ['2027-08-09T08:00:00Z', '2027-08-09T09:00:00Z', '2027-08-09T07:00:00Z']);
  });
  it('shows corrections beside the report and describes triage changes', () => {
    const events = [ev('REPORTED'), ev('CORRECTION', { correction: { pollingStationCode: '039-002' } }), ev('TRIAGED', { severity: 'HIGH', previousSeverity: 'MEDIUM' })];
    assert.equal(corrections(events).length, 1);
    assert.deepEqual(describeEventData(events[1]!), ['Corrected station: 039-002']);
    assert.deepEqual(describeEventData(events[2]!), ['Severity Medium → High']);
  });
  it('explains separation of duties to the reporter and the resolver', () => {
    const me = U(40);
    assert.equal(sodHints({ reporter: { id: me, displayName: 'x' }, resolvedBy: null, status: 'REPORTED' }, me).length, 1);
    assert.match(sodHints({ reporter: { id: U(41), displayName: 'x' }, resolvedBy: { id: me, displayName: 'y' }, status: 'RESOLVED' }, me)[0]!, /different reviewer/);
    assert.equal(sodHints({ reporter: { id: U(41), displayName: 'x' }, resolvedBy: null, status: 'TRIAGED' }, me).length, 0);
  });
  it('deduplicates assignee candidates', () => {
    const me = { id: U(50), displayName: 'Me' };
    const list = assigneeCandidates(me, [{ id: U(51), displayName: 'Bea' }, null, { id: U(50), displayName: 'Me' }, { id: U(51), displayName: 'Bea' }]);
    assert.deepEqual(list.map((u) => u.displayName), ['Bea', 'Me']);
  });
});

describe('War Room', () => {
  it('lists every 7.2 status in the legend', () => {
    const counts = statusCounts([{ status: 'CHECKED_IN', count: 12 }]);
    assert.equal(counts.length, 11);
    assert.equal(counts.find((c) => c.status === 'CHECKED_IN')!.count, 12);
    assert.equal(counts[0]!.status, 'NOT_ASSIGNED');
  });
  it('flags attention stations as the API does', () => {
    assert.equal(needsAttention({ status: 'CHECKED_IN', openIncidents: 1, highestOpenSeverity: 'CRITICAL' }), true);
    assert.equal(needsAttention({ status: 'CHECKED_IN', openIncidents: 1, highestOpenSeverity: 'LOW' }), false);
    assert.equal(needsAttention({ status: 'NOT_ASSIGNED', openIncidents: 0, highestOpenSeverity: null }), true);
  });
  it('marks figures stale when refreshes stop arriving', () => {
    const now = Date.parse('2027-08-09T10:00:00Z');
    assert.equal(isStale('2027-08-09T09:59:30Z', now, 30_000), false);
    assert.equal(isStale('2027-08-09T09:58:00Z', now, 30_000), true);
    assert.equal(isStale(null, now, 30_000), true);
  });
  it('builds a newest-first timeline from check-ins, updates and incidents', () => {
    const t = buildTimeline(
      [{ location: loc('039-001'), lastCheckInAt: '2027-08-09T05:40:00Z', lastFieldReportAt: '2027-08-09T07:10:00Z' }],
      [{ id: U(60), reference: 'INC-2027-000001', severity: 'HIGH', reportedAt: '2027-08-09T06:00:00Z', location: loc('039-001'), categoryLabel: 'Security concern' }],
    );
    assert.deepEqual(t.map((e) => e.kind), ['field_update', 'incident', 'check_in']);
    assert.equal(t[1]!.href, `/field/incidents/${U(60)}`);
  });
  it('panels say unofficial and internal and refuse to show numbers when unavailable', () => {
    const envelope = { label: WAR_ROOM_LABEL, asOf: '2027-08-09T10:00:00Z', completeness: completeness(153, 0), available: false };
    const html = renderToStaticMarkup(
      <Panel id="p" title="Tally verification" icon={Activity} envelope={envelope}>
        <span>42</span>
      </Panel>,
    );
    assert.match(html, /Unofficial · internal/);
    assert.match(html, /Not available/);
    assert.doesNotMatch(html, />42</);
    assert.ok(html.includes(WAR_ROOM_LABEL));
  });
});

describe('field screen copy', () => {
  it('never uses outcome or accusatory wording', () => {
    const roots = [join(__dirname, '..'), join(__dirname, '..', '..', '..', 'app', '(app)', 'field'), join(__dirname, '..', '..', '..', 'app', '(app)', 'warroom')];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) {
          if (f !== '__tests__' && f !== 'mobile') walk(p);
        } else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    roots.forEach(walk);
    assert.ok(files.length > 15);
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.equal(findForbiddenTallyLanguage(src), null, `forbidden outcome wording in ${f}`);
      assert.doesNotMatch(src, /\b(fraud|rigg|criminal|culprit|perpetrator|suspect)\w*/i, `accusatory wording in ${f}`);
    }
  });
});
