import { describe, expect, test } from 'claude-code/testing'
import { POLICY, forecastAgent, forecastSession, needed, parseHistory, quantileUpperBound, type AgentRecord, type SessionRecord } from './forecast.ts'
import { historyFile, historyText, startHistory, startTracker } from './history.ts'
import type { Io } from './io.ts'
import { pathsFor } from './paths.ts'

const NOW = 1_800_000_000_000

const agent = (costMB: number, over: Partial<AgentRecord> = {}): AgentRecord => ({
  kind: 'agent',
  t: NOW,
  type: 'general-purpose',
  durationMs: 60_000,
  samples: 12,
  growthMB: costMB,
  concurrent: 1,
  costMB,
  ...over,
})

const session = (peakSelfMB: number, peakChildMB: number, over: Partial<SessionRecord> = {}): SessionRecord => ({
  kind: 'session',
  t: NOW,
  sessionId: 's',
  peakSelfMB,
  peakChildMB,
  samples: 100,
  ...over,
})

describe('quantile bound', () => {
  test('needs 22 observations for a p90 bound at 90% confidence', () => {
    expect(needed()).toBe(22)
    expect(quantileUpperBound([...Array(21)].map((_, i) => i))).toBeUndefined()
    // with 22, the bound is the largest; with more, it moves inside the sample
    expect(quantileUpperBound([...Array(22)].map((_, i) => i + 1))).toBe(22)
    const hundred = [...Array(100)].map((_, i) => i + 1)
    const b = quantileUpperBound(hundred)!
    expect(b).toBeGreaterThan(90)
    expect(b).toBeLessThan(100)
  })
})

describe('subagent forecast', () => {
  test('nothing measured: the observed stand-in, never a constant', () => {
    expect(forecastAgent([], 'Explore', 140, NOW)).toEqual({ mb: 140, n: 0, method: 'standIn', scope: 'pool' })
  })

  test('the run measured live today: 23 MB is the forecast, not a prior', () => {
    expect(forecastAgent([agent(23, { type: 'Explore' })], 'Explore', 140, NOW)).toMatchObject({ mb: 23, n: 1, method: 'max' })
  })

  test('too few for a bound: the largest; enough: the bound', () => {
    expect(forecastAgent([agent(100), agent(400), agent(250)], 'general-purpose', 1, NOW)).toMatchObject({ mb: 400, method: 'max' })
    const runs = [...Array(200)].map((_, i) => agent(i < 180 ? 400 : 900))
    const f = forecastAgent(runs, 'general-purpose', 1, NOW)
    expect(f).toMatchObject({ method: 'bound', scope: 'type' })
    expect(f.mb).toBe(900)
  })

  test("a type's own runs once they support a bound; the pool before", () => {
    const pool = [...Array(30)].map(() => agent(800))
    const explore = (n: number) => [...Array(n)].map(() => agent(50, { type: 'Explore' }))
    expect(forecastAgent([...pool, ...explore(5)], 'Explore', 1, NOW)).toMatchObject({ scope: 'pool', mb: 800 })
    expect(forecastAgent([...pool, ...explore(22)], 'Explore', 1, NOW)).toMatchObject({ scope: 'type', mb: 50 })
  })

  test('runs too short to measure, or too old, are left out', () => {
    expect(forecastAgent([agent(5000, { samples: 0 })], 'general-purpose', 7, NOW).method).toBe('standIn')
    expect(forecastAgent([agent(5000, { t: NOW - POLICY.maxAgeMs - 1 })], 'general-purpose', 7, NOW).method).toBe('standIn')
  })
})

describe('session forecast', () => {
  test('recorded peaks and the live sessions, observed from the first sample', () => {
    expect(forecastSession([], [700, 1300, 900], NOW)).toMatchObject({ mb: 1300, n: 3, method: 'max' })
    const many = [...Array(40)].map((_, i) => session(700, i % 10 === 0 ? 2600 : 300))
    const f = forecastSession(many, [], NOW)
    expect(f.method).toBe('bound')
    // a tenth of sessions run a 2.6 GB dev server: the p90 bound covers them
    expect(f.mb).toBe(3300)
  })
})

describe('history records', () => {
  test('round-trip through JSONL, skipping torn lines', () => {
    const text = historyText([agent(300)], session(700, 300)) + '{"kind":"agent","t":'
    expect(parseHistory(text)).toEqual([agent(300), session(700, 300)])
  })

  test('the file is per month and session', () => {
    expect(historyFile(pathsFor('C:\\u'), 'abc', Date.UTC(2026, 9, 4))).toBe('C:\\u\\.claude\\clearance\\history\\2026-10\\abc.jsonl')
  })
})

describe('tracker', () => {
  test("a subagent's cost is the tree's peak growth while it ran", () => {
    const tr = startTracker()
    tr.sample({ selfMB: 600, childMB: 200 }, 1)
    tr.started('a', 'Explore', 10)
    tr.sample({ selfMB: 750, childMB: 300 }, 2)
    tr.sample({ selfMB: 700, childMB: 250 }, 3)
    expect(tr.stopped('a', 40)).toEqual({
      kind: 'agent',
      t: 40,
      type: 'Explore',
      durationMs: 30,
      samples: 2,
      growthMB: 250,
      concurrent: 1,
      costMB: 250,
    })
  })

  test('overlapping subagents split the growth; a repeat sample is ignored', () => {
    const tr = startTracker()
    tr.sample({ selfMB: 600, childMB: 0 }, 1)
    tr.started('a', 'gp', 10)
    tr.started('b', 'gp', 11)
    tr.sample({ selfMB: 1200, childMB: 0 }, 2)
    tr.sample({ selfMB: 1200, childMB: 0 }, 2)
    const a = tr.stopped('a', 20)!
    expect(a).toMatchObject({ samples: 1, growthMB: 600, concurrent: 2, costMB: 300 })
  })

  test('too short to see a sample, or started before any sample: not measured', () => {
    const tr = startTracker()
    tr.started('x', 'gp', 1)
    tr.sample({ selfMB: 900, childMB: 0 }, 2)
    expect(tr.stopped('x', 3)).toMatchObject({ samples: 0, costMB: 0 })
    tr.started('y', 'gp', 4)
    expect(tr.stopped('y', 5)).toMatchObject({ samples: 0 })
    expect(tr.stopped('never', 6)).toBeUndefined()
  })

  test("the session's peaks", () => {
    const tr = startTracker()
    expect(tr.session('s', 1)).toBeUndefined()
    tr.sample({ selfMB: 600, childMB: 400 }, 1)
    tr.sample({ selfMB: 800, childMB: 100 }, 2)
    expect(tr.session('s', 3)).toEqual({ kind: 'session', t: 3, sessionId: 's', peakSelfMB: 800, peakChildMB: 400, samples: 2 })
  })
})

describe('history store', () => {
  const fs = () => {
    const files = new Map<string, string>()
    const io = {
      now: async () => NOW,
      list: async (dir: string) => {
        const names = new Map<string, string>()
        for (const p of files.keys()) {
          if (!p.startsWith(dir + '\\')) continue
          const rest = p.slice(dir.length + 1).split('\\')
          names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
        }
        if (names.size === 0) throw new Error('ENOENT')
        return [...names].map(([name, kind]) => ({ name, kind }))
      },
      read: async (p: string) => files.get(p) ?? '',
      write: async (p: string, t: string) => void files.set(p, t),
      log: () => {},
    } as unknown as Io
    return { files, io }
  }
  const paths = pathsFor('C:\\u')

  test("learns from every session's file and keeps its own across a reload", async () => {
    const { files, io } = fs()
    files.set(historyFile(paths, 'other', NOW), historyText([agent(500), agent(500)], session(700, 300, { sessionId: 'other' })))
    const h = await startHistory(io, paths, 'me', NOW)
    expect(h.records()).toHaveLength(3)
    await h.addAgent(agent(200))
    await h.setSession(session(650, 200, { sessionId: 'me', samples: 5 }))
    // a hot reload: a fresh store reads its own file back
    const again = await startHistory(io, paths, 'me', NOW)
    expect(again.records()).toHaveLength(5)
    await again.setSession(session(600, 250, { sessionId: 'me', samples: 3 }))
    const mine = parseHistory(files.get(historyFile(paths, 'me', NOW))!)
    expect(mine.find(r => r.kind === 'session')).toMatchObject({ peakSelfMB: 650, peakChildMB: 250, samples: 8 })
  })

  test('starts empty without a history folder', async () => {
    const { io } = fs()
    expect((await startHistory(io, paths, 'me', NOW)).records()).toEqual([])
  })
})
