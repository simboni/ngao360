/**
 * Client-side planner checks (S14). They only warn before a request; the API
 * re-checks every assignment and answers 409 CONFLICT with the authoritative
 * `details.conflicts` (API §17).
 */
import {
  type AgentSummary,
  type DeploymentConflict,
  type DeploymentRole,
  type DeploymentShift,
  shiftsOverlap,
  type StationCoverageSlot,
} from '@ngao360/shared';

export const DEPLOYMENT_CONFLICT_LABELS: Record<DeploymentConflict['kind'], string> = {
  AGENT_DOUBLE_BOOKED: 'Agent double-booked',
  SLOT_ALREADY_FILLED: 'Slot already filled',
  AGENT_NOT_ACTIVE: 'Agent not active',
  AGENT_NOT_ACCREDITED: 'Agent not accredited',
  STATION_NOT_IN_APPROVED_REGISTRY: 'Station not in approved registry',
};

/** Roles that cover a station (API §17 `covered`). */
export const COVERING_ROLES: readonly DeploymentRole[] = ['CHIEF_AGENT', 'STATION_AGENT'];

export interface PlannedAssignment {
  agent: Pick<AgentSummary, 'id' | 'displayName' | 'status' | 'accreditationStatus'>;
  station: Pick<StationCoverageSlot, 'pollingStationCode' | 'pollingStationName' | 'slots'>;
  role: DeploymentRole;
  shift: DeploymentShift;
}

/**
 * Warnings the planner can see from loaded data: the agent is inactive or
 * unaccredited, a second chief agent on an overlapping shift, or the agent
 * already holds an overlapping slot on a station in view (by display name,
 * since coverage slots carry no agent id). `blocking` mirrors what the API
 * will refuse.
 */
export function precheckAssignment(plan: PlannedAssignment, visibleStations: ReadonlyArray<Pick<StationCoverageSlot, 'pollingStationCode' | 'slots'>>): DeploymentConflict[] {
  const out: DeploymentConflict[] = [];
  const base = { agentId: plan.agent.id, pollingStationCode: plan.station.pollingStationCode };
  if (plan.agent.status !== 'ACTIVE' && plan.agent.status !== 'STANDBY') {
    out.push({ ...base, kind: 'AGENT_NOT_ACTIVE', message: `${plan.agent.displayName} is not active or on standby.`, deploymentIds: [], blocking: true });
  }
  if (plan.agent.accreditationStatus !== 'APPROVED' && plan.agent.accreditationStatus !== 'NOT_APPLICABLE') {
    out.push({ ...base, kind: 'AGENT_NOT_ACCREDITED', message: `${plan.agent.displayName} has no approved accreditation for this cycle.`, deploymentIds: [], blocking: false });
  }
  if (plan.role === 'CHIEF_AGENT') {
    const chief = plan.station.slots.find((s) => s.role === 'CHIEF_AGENT' && shiftsOverlap(s.shift, plan.shift));
    if (chief) {
      out.push({ ...base, kind: 'SLOT_ALREADY_FILLED', message: `${plan.station.pollingStationCode} already has a chief agent (${chief.agentDisplayName}) on an overlapping shift.`, deploymentIds: [chief.deploymentId], blocking: true });
    }
  }
  for (const st of visibleStations) {
    for (const s of st.slots) {
      if (s.agentDisplayName === plan.agent.displayName && shiftsOverlap(s.shift, plan.shift)) {
        out.push({ ...base, kind: 'AGENT_DOUBLE_BOOKED', message: `${plan.agent.displayName} may already hold an overlapping slot at ${st.pollingStationCode} (matched by name; the server checks by agent).`, deploymentIds: [s.deploymentId], blocking: false });
      }
    }
  }
  return out;
}
