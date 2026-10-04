import { census, floorMB, gate, type GateOptions, type Verdict } from './gate.ts'
import type { Snapshot } from './snapshot.ts'

// Admission (0004, design.md § Hooks): the spawn gate's deny text, the
// subagent's budget line, the headroom tool's table and the session-start
// check. Pure: no `$` here.


const gb = (mb: number) => (mb / 1024).toFixed(1)

export const DIVERT = 'divert to a cloud session (claude.ai/code) or to another machine (Remote Control or ssh)'

export type SpawnDecision = { allow: true; verdict: Verdict | undefined } | { allow: false; deny: string; verdict: Verdict }

/**
 * Whether a subagent may start. Without a fresh snapshot it is allowed: the
 * census being down must not block work (deter, never kill: 0003).
 */
export const decideSpawn = (s: Snapshot | undefined, o: GateOptions, subagentType: string, mb: number, extraReservedMB: number): SpawnDecision => {
  if (!s) return { allow: true, verdict: undefined }
  const v = gate(s, o, { kind: 'agent', mb }, extraReservedMB)
  if (v.state === 'CLEARED') return { allow: true, verdict: v }
  const inFlight = census(s).agents
  const deny =
    `clearance: HOLD. Forecast ${gb(mb)} GB for ${subagentType}, machine headroom ${gb(v.headroomMB)} GB ` +
    `(${v.reasons.join('; ')}). ${inFlight} subagent${inFlight === 1 ? '' : 's'} in flight machine-wide. ` +
    `Run at most ${v.fits} now: wait for running subagents to finish, do the work in this conversation, or ${DIVERT}. ` +
    `Call mcp__clearance__headroom for the full table.`
  return { allow: false, deny, verdict: v }
}

/** The line every subagent gets at its start (classic SubagentStart additionalContext). */
export const budgetLine = (s: Snapshot | undefined, o: GateOptions, subagentType: string, mb: number): string => {
  const head = s ? `machine headroom ${gb(gate(s, o, { kind: 'agent', mb }).headroomMB)} GB, ${census(s).agents} subagents in flight` : 'machine census unavailable'
  return (
    `clearance: this machine is memory-constrained. Your budget as ${subagentType} is about ${gb(mb)} GB (${head}). ` +
    `Avoid starting heavy processes (dev servers, test watchers, browsers, docker) unless the task needs them, and stop any you start before you finish.`
  )
}

export type HeadroomAsk = { subagentType?: string; count?: number }

/** The headroom tool's answer: the census and what fits, as plain text for the model. */
export const headroomReport = (
  s: Snapshot | undefined,
  o: GateOptions,
  extraReservedMB: number,
  ask: HeadroomAsk,
  now: number,
  mbFor: (type: string) => { mb: number; basis: string },
): string => {
  if (!s) return 'clearance: no fresh machine snapshot yet (the scribe is starting or gone). Spawns are not gated meanwhile.'
  const type = ask.subagentType ?? 'general-purpose'
  const { mb, basis } = mbFor(type)
  const agent = gate(s, o, { kind: 'agent', mb }, extraReservedMB)
  const session = gate(s, o, { kind: 'session' }, extraReservedMB)
  const c = census(s)
  const m = s.machine
  const lines = [
    `clearance census (sampled ${Math.max(0, Math.round((now - s.t) / 1000))} s ago)`,
    `machine: available ${gb(m.availableMB)} GB of ${gb(m.totalMB)} GB (floor ${gb(floorMB(o, m.totalMB))} GB); commit ${gb(m.commitMB)}/${gb(m.commitLimitMB)} GB (ceiling ${o.maxCommitPct}%)`,
    `headroom: ${gb(agent.headroomMB)} GB after reservations (${gb(c.reservedMB + extraReservedMB)} GB reserved)`,
    `sessions: ${c.sessions} of ${o.maxSessions}; subagents in flight: ${c.agents} of ${o.maxAgents}`,
    '',
    'session | cwd | self GB | children GB | subagents',
    ...s.sessions.map(r => `${r.sessionId.slice(0, 8)} | ${r.cwd} | ${gb(r.selfMB)} | ${gb(r.childMB)} | ${r.agentsInFlight ?? '-'}`),
    '',
    `subagent ${type}: forecast ${gb(mb)} GB (${basis}); ${agent.state}; at most ${agent.fits} now${agent.reasons.length ? ` (${agent.reasons.join('; ')})` : ''}`,
    `new local session: forecast ${o.sessionBaselineGB.toFixed(2)} GB; ${session.state}; at most ${session.fits} now`,
  ]
  if (ask.count !== undefined && ask.count > agent.fits)
    lines.push(`asked for ${ask.count} subagents: run ${agent.fits} now and queue the rest, or ${DIVERT}`)
  return lines.join('\n')
}

/**
 * The snapshot as if this session were not running yet: its row and its
 * memory taken off, so the session-start check asks whether it should have
 * been admitted rather than counting itself twice.
 */
export const withoutSession = (s: Snapshot, sessionId: string): Snapshot => {
  const self = s.sessions.find(r => r.sessionId === sessionId)
  if (!self) return s
  const mb = self.selfMB + self.childMB
  return {
    ...s,
    machine: { ...s.machine, availableMB: s.machine.availableMB + mb, commitMB: Math.max(0, s.machine.commitMB - mb) },
    sessions: s.sessions.filter(r => r !== self),
  }
}

export const DIALOG = {
  question: (v: Verdict) => `clearance: this machine is on HOLD for a new session (${v.reasons.join('; ')}). Continue here?`,
  divert: 'Divert: show how',
  wait: 'Wait: tell me when cleared',
  anyway: 'Start anyway',
} as const

export const divertSteps = (v: Verdict) =>
  `clearance HOLD: ${v.reasons.join('; ')}. To keep this machine responsive, ${DIVERT}: ` +
  `start a cloud session at claude.ai/code (or the app's cloud option), or open the project on another machine. ` +
  `Close idle sessions here to free memory.`

/** The snapshot with this session's subagent count as it is now, not as last sampled (spawns between samples count at once). */
export const withOwnAgents = (s: Snapshot, sessionId: string, agentsInFlight: number): Snapshot => ({
  ...s,
  sessions: s.sessions.map(r => (r.sessionId === sessionId ? { ...r, agentsInFlight } : r)),
})
