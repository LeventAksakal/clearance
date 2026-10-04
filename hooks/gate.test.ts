import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS, advance, census, gate, gateOptions, settle } from './gate.ts'
import type { SessionSample, Snapshot } from './snapshot.ts'

const row = (over: Partial<SessionSample> = {}): SessionSample => ({
  sessionId: 's',
  pid: 1,
  cwd: 'C:\\x',
  entrypoint: 'cli',
  selfMB: 600,
  childMB: 0,
  children: 0,
  topChildren: [],
  ...over,
})

// 16 GB machine; commit 30/48 GB, so the commit ceiling (90%) leaves ~12 GB and RAM decides.
const snap = (availableMB: number, sessions: SessionSample[] = [row(), row()], over: Partial<Snapshot> = {}): Snapshot => ({
  schema: 1,
  epoch: 1,
  t: 1_000,
  sampleMs: 100,
  intervalMs: 5_000,
  machine: { totalMB: 16384, availableMB, commitMB: 30_720, commitLimitMB: 49_152 },
  sessions,
  ...over,
})

describe('gate', () => {
  test('clears a session when RAM above the floor covers the baseline', () => {
    // 4096 - 1536 floor = 2560 headroom; a 717 MB baseline fits 3 times.
    expect(gate(snap(4096), DEFAULTS, { kind: 'session' })).toEqual({ state: 'CLEARED', headroomMB: 2560, fits: 3, reasons: [] })
  })

  test('holds a session when the floor would be crossed', () => {
    const v = gate(snap(2000), DEFAULTS, { kind: 'session' })
    expect(v.state).toBe('HOLD')
    expect(v.headroomMB).toBe(464)
    expect(v.fits).toBe(0)
    expect(v.reasons).toEqual(['available 2.0 GB, floor 1.5 GB + 0.7 GB ask'])
  })

  test('holds on the commit ceiling even with RAM to spare', () => {
    const s = snap(8000, [row()], { machine: { totalMB: 16384, availableMB: 8000, commitMB: 44_000, commitLimitMB: 49_152 } })
    const v = gate(s, DEFAULTS, { kind: 'session' })
    expect(v.state).toBe('HOLD')
    expect(v.reasons).toEqual(['commit 90% of 48.0 GB, ceiling 90%'])
  })

  test('holds at the session ceiling, and fits never exceed it', () => {
    const six = Array.from({ length: 6 }, () => row())
    expect(gate(snap(12_000, six), DEFAULTS, { kind: 'session' }).reasons).toEqual(['6 sessions, ceiling 6'])
    expect(gate(snap(12_000, [row(), row(), row(), row(), row()]), DEFAULTS, { kind: 'session' }).fits).toBe(1)
  })

  test('counts subagents and reservations machine-wide from presence', () => {
    const s = snap(4096, [row({ agentsInFlight: 5, reservedMB: 300 }), row({ agentsInFlight: 3 })])
    expect(census(s)).toEqual({ sessions: 2, agents: 8, reservedMB: 300 })
    const v = gate(s, DEFAULTS, { kind: 'agent', mb: 300 })
    expect(v.state).toBe('HOLD')
    expect(v.headroomMB).toBe(2260)
    expect(v.reasons).toEqual(['8 subagents, ceiling 8'])
  })

  test("takes this session's newer reservations off the headroom", () => {
    expect(gate(snap(4096), DEFAULTS, { kind: 'session' }, 2000).state).toBe('HOLD')
  })
})

describe('gateOptions', () => {
  test('fills defaults for missing or nonsensical values', () => {
    expect(gateOptions({})).toEqual(DEFAULTS)
    expect(gateOptions({ minFreeGB: 2, maxSessions: 4.7, maxCommitPct: 140, maxAgents: -1 })).toEqual({
      ...DEFAULTS,
      minFreeGB: 2,
      maxSessions: 4,
      maxCommitPct: 100,
    })
  })
})

describe('hysteresis', () => {
  test('a new state needs two samples in a row', () => {
    let h = settle(undefined, 'CLEARED')
    h = settle(h, 'HOLD')
    expect(h.shown).toBe('CLEARED')
    h = settle(h, 'HOLD')
    expect(h.shown).toBe('HOLD')
  })

  test('a one-sample blip changes nothing', () => {
    let h = settle(undefined, 'CLEARED')
    h = settle(h, 'HOLD')
    h = settle(h, 'CLEARED')
    h = settle(h, 'HOLD')
    expect(h.shown).toBe('CLEARED')
  })

  test('advance settles per sample, not per tick', () => {
    let v = advance(undefined, snap(4096), DEFAULTS)
    expect(v.shown.state).toBe('CLEARED')
    v = advance(v, snap(1000, undefined, { t: 2_000 }), DEFAULTS)
    v = advance(v, snap(1000, undefined, { t: 2_000 }), DEFAULTS)
    expect(v.shown.state).toBe('CLEARED')
    v = advance(v, snap(1000, undefined, { t: 3_000 }), DEFAULTS)
    expect(v.shown.state).toBe('HOLD')
    expect(v.shown.fits).toBe(0)
    expect(v.band?.reasons[0]).toBe('available 1.0 GB, floor 1.5 GB + 0.7 GB ask')
  })

  test('the band stays while HOLD is clearing, and says so', () => {
    let v = advance(undefined, snap(1000), DEFAULTS)
    v = advance(v, snap(4096, undefined, { t: 2_000 }), DEFAULTS)
    expect(v.shown.state).toBe('HOLD')
    expect(v.band?.reasons).toEqual(['clearing; waiting for one more sample'])
    v = advance(v, snap(4096, undefined, { t: 3_000 }), DEFAULTS)
    expect(v.band).toBeNull()
  })
})
