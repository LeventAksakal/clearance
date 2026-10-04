import type { ClearanceBand } from '../types'
import type { Shown, Snapshot } from './snapshot.ts'

// The gate (0002, design.md § The gate): a memory floor and a commit ceiling,
// plus count ceilings for sessions and subagents. Pure: no `$` here.

export type GateOptions = {
  minFreeGB: number
  maxCommitPct: number
  maxSessions: number
  maxAgents: number
  sessionBaselineGB: number
}

export const DEFAULTS: GateOptions = { minFreeGB: 1.5, maxCommitPct: 90, maxSessions: 6, maxAgents: 8, sessionBaselineGB: 0.7 }

/** `register(on, options)` values, with a default for any field that is missing or not a positive number. */
export const gateOptions = (raw: Readonly<Record<string, unknown>>): GateOptions => {
  const pick = (k: keyof GateOptions) => {
    const v = raw[k]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULTS[k]
  }
  return {
    minFreeGB: pick('minFreeGB'),
    maxCommitPct: Math.min(100, pick('maxCommitPct')),
    maxSessions: Math.floor(pick('maxSessions')),
    maxAgents: Math.floor(pick('maxAgents')),
    sessionBaselineGB: pick('sessionBaselineGB'),
  }
}

export type GateState = 'CLEARED' | 'HOLD'

/** What is asked for: a new session (the baseline), or a subagent with its forecast. */
export type Ask = { kind: 'session' } | { kind: 'agent'; mb: number }

export type Verdict = {
  state: GateState
  /** Memory that can still be admitted: the tighter of the RAM floor and the commit ceiling, reservations taken off. */
  headroomMB: number
  /** How many more of the asked kind fit now. */
  fits: number
  /** Why it holds; empty when cleared. */
  reasons: string[]
}

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** Machine-wide counts and reservations, summed from the snapshot's session rows. */
export const census = (s: Snapshot) => {
  let agents = 0
  let reservedMB = 0
  for (const row of s.sessions) {
    agents += row.agentsInFlight ?? 0
    reservedMB += row.reservedMB ?? 0
  }
  return { sessions: s.sessions.length, agents, reservedMB }
}

/**
 * Whether `ask` fits. `extraReservedMB` is this session's own reservations not
 * yet in the snapshot (recorded after the last sample).
 */
export const gate = (s: Snapshot, o: GateOptions, ask: Ask, extraReservedMB = 0): Verdict => {
  const m = s.machine
  const c = census(s)
  const reserved = c.reservedMB + extraReservedMB
  const memRoom = m.availableMB - reserved - o.minFreeGB * 1024
  const commitRoom = (m.commitLimitMB * o.maxCommitPct) / 100 - m.commitMB - reserved
  const headroomMB = Math.max(0, Math.round(Math.min(memRoom, commitRoom)))
  const cost = ask.kind === 'session' ? o.sessionBaselineGB * 1024 : Math.max(1, ask.mb)
  const [count, ceiling, noun] = ask.kind === 'session' ? [c.sessions, o.maxSessions, 'sessions'] : [c.agents, o.maxAgents, 'subagents']

  const reasons: string[] = []
  if (memRoom < cost) reasons.push(`available ${gb(m.availableMB - reserved)} GB, floor ${o.minFreeGB} GB + ${gb(cost)} GB ask`)
  if (commitRoom < cost)
    reasons.push(`commit ${Math.round(((m.commitMB + reserved) / m.commitLimitMB) * 100)}% of ${gb(m.commitLimitMB)} GB, ceiling ${o.maxCommitPct}%`)
  if (count >= ceiling) reasons.push(`${count} ${noun}, ceiling ${ceiling}`)

  const fits = Math.max(0, Math.min(Math.floor(headroomMB / cost), ceiling - count))
  return { state: reasons.length === 0 ? 'CLEARED' : 'HOLD', headroomMB, fits, reasons }
}

/** Hysteresis: a state must show in `need` consecutive samples before it replaces the shown one, so the status line doesn't flicker. */
export type Settled = { shown: GateState; pending: GateState | undefined; streak: number }

export const settle = (prev: Settled | undefined, next: GateState, need = 2): Settled => {
  if (!prev) return { shown: next, pending: undefined, streak: 0 }
  if (next === prev.shown) return { shown: prev.shown, pending: undefined, streak: 0 }
  const streak = prev.pending === next ? prev.streak + 1 : 1
  return streak >= need ? { shown: next, pending: undefined, streak: 0 } : { shown: prev.shown, pending: next, streak }
}

/** The gate as one session shows it: settled per sample, never per tick (ticks reread the same sample). */
export type GateView = { t: number; settled: Settled; shown: Shown; band: ClearanceBand | null }

export const advance = (prev: GateView | undefined, s: Snapshot, o: GateOptions, extraReservedMB = 0): GateView => {
  const v = gate(s, o, { kind: 'session' }, extraReservedMB)
  const settled = prev && prev.t === s.t ? prev.settled : settle(prev?.settled, v.state)
  const isHeld = settled.shown === 'HOLD'
  return {
    t: s.t,
    settled,
    shown: { state: settled.shown, headroomMB: v.headroomMB, fits: isHeld ? 0 : v.fits },
    band: isHeld ? { state: 'HOLD', headroomMB: v.headroomMB, reasons: v.reasons.length > 0 ? v.reasons : ['clearing; waiting for one more sample'] } : null,
  }
}
