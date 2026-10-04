import { describe, expect, test } from 'claude-code/testing'
import { AGENT_DEFAULT_MB, budgetLine, decideSpawn, headroomReport, withOwnAgents, withoutSession } from './admission.ts'
import { DEFAULTS } from './gate.ts'
import { liveReservations } from './presence.ts'
import type { SessionSample, Snapshot } from './snapshot.ts'

// A fixed 1.5 GB floor, so the arithmetic below doesn't move with the auto floor.
const FIXED = { ...DEFAULTS, minFreeGB: 1.5 }
const row = (sessionId: string, over: Partial<SessionSample> = {}): SessionSample => ({
  sessionId,
  pid: 1,
  cwd: `C:\\Code\\${sessionId}`,
  entrypoint: 'claude-desktop',
  selfMB: 600,
  childMB: 200,
  children: 3,
  topChildren: [],
  ...over,
})

const snap = (availableMB: number, sessions: SessionSample[] = [row('aaaaaaaa-1'), row('bbbbbbbb-2')]): Snapshot => ({
  schema: 1,
  epoch: 1,
  t: 10_000,
  sampleMs: 100,
  intervalMs: 5_000,
  machine: { totalMB: 16384, availableMB, commitMB: 30_720, commitLimitMB: 49_152 },
  sessions,
})

describe('spawn gate', () => {
  test('lets a subagent through when it fits', () => {
    expect(decideSpawn(snap(4096), FIXED, 'Explore', AGENT_DEFAULT_MB, 0).allow).toBe(true)
  })

  test('allows when the census is down: never block work on a missing sample', () => {
    expect(decideSpawn(undefined, FIXED, 'Explore', AGENT_DEFAULT_MB, 0)).toEqual({ allow: true, verdict: undefined })
  })

  test('denies over the floor with the forecast, what fits and the ways out', () => {
    const d = decideSpawn(snap(1700), FIXED, 'general-purpose', AGENT_DEFAULT_MB, 0)
    expect(d.allow).toBe(false)
    if (d.allow) return
    expect(d.deny).toBe(
      'clearance: HOLD. Forecast 0.3 GB for general-purpose, machine headroom 0.2 GB (available 1.7 GB, floor 1.5 GB + 0.3 GB ask). ' +
        '0 subagents in flight machine-wide. Run at most 0 now: wait for running subagents to finish, do the work in this conversation, ' +
        'or divert to a cloud session (claude.ai/code) or to another machine (Remote Control or ssh). Call mcp__clearance__headroom for the full table.',
    )
  })

  test("counts this session's reservations and newest spawns before the next sample", () => {
    expect(decideSpawn(snap(2400), FIXED, 'Explore', AGENT_DEFAULT_MB, 0).allow).toBe(true)
    expect(decideSpawn(snap(2400), FIXED, 'Explore', AGENT_DEFAULT_MB, 600).allow).toBe(false)
    const crowded = withOwnAgents(snap(12_000), 'aaaaaaaa-1', 8)
    const d = decideSpawn(crowded, FIXED, 'Explore', AGENT_DEFAULT_MB, 0)
    expect(d.allow).toBe(false)
    expect(d.verdict?.reasons).toEqual(['8 subagents, ceiling 8'])
  })
})

describe('budget line', () => {
  test('names the budget and asks for no heavy processes', () => {
    expect(budgetLine(snap(4096), FIXED, 'Explore', 307)).toBe(
      'clearance: this machine is memory-constrained. Your budget as Explore is about 0.3 GB (machine headroom 2.5 GB, 0 subagents in flight). ' +
        'Avoid starting heavy processes (dev servers, test watchers, browsers, docker) unless the task needs them, and stop any you start before you finish.',
    )
  })
})

describe('headroom tool', () => {
  test('reports the census, the table and what fits', () => {
    const text = headroomReport(snap(4096), FIXED, 0, { subagentType: 'Explore', count: 12 }, 12_000)
    expect(text).toContain('clearance census (sampled 2 s ago)')
    expect(text).toContain('aaaaaaaa | C:\\Code\\aaaaaaaa-1 | 0.6 | 0.2 | -')
    expect(text).toContain('subagent Explore: forecast 0.3 GB (prior); CLEARED; at most 8 now')
    expect(text).toContain('asked for 12 subagents: run 8 now and queue the rest')
  })

  test('says so when there is no snapshot', () => {
    expect(headroomReport(undefined, FIXED, 0, {}, 0)).toContain('no fresh machine snapshot')
  })
})

describe('session-start check', () => {
  test("takes the new session's own row and memory off before gating it", () => {
    const s = withoutSession(snap(1000), 'bbbbbbbb-2')
    expect(s.sessions.map(r => r.sessionId)).toEqual(['aaaaaaaa-1'])
    expect(s.machine.availableMB).toBe(1800)
    expect(s.machine.commitMB).toBe(29_920)
    expect(withoutSession(snap(1000), 'not-there')).toEqual(snap(1000))
  })
})

describe('reservations', () => {
  test('run out after 30 s', () => {
    const all = [
      { id: 'old', mb: 300, at: 0 },
      { id: 'new', mb: 300, at: 20_000 },
    ]
    expect(liveReservations(all, 30_000).map(r => r.id)).toEqual(['new'])
  })
})
