import { describe, expect, test } from 'claude-code/testing'
import { MODEL, forecastAgent, forecastSession, parseHistory, weightedQuantile, type AgentRecord, type SessionRecord } from './forecast.ts'
import { historyFile, historyText, startHistory, startTracker } from './history.ts'
import type { Io } from './io.ts'
import { pathsFor } from './paths.ts'

const NOW = 1_800_000_000_000
const DAY = 24 * 3600_000

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

describe('weighted quantile', () => {
  test('equal weights: the p90 of 1..10 is 9', () => {
    expect(weightedQuantile([...Array(10)].map((_, i) => ({ v: i + 1, w: 1 })), 0.9)).toBe(9)
  })
  test('weight moves it: an old large sample counts less', () => {
    const pts = [{ v: 100, w: 1 }, { v: 100, w: 1 }, { v: 1000, w: 0.05 }]
    expect(weightedQuantile(pts, 0.9)).toBe(100)
  })
})

describe('subagent forecast', () => {
  test('the prior without history', () => {
    expect(forecastAgent([], 'Explore', 307, NOW)).toEqual({ mb: 307, n: 0, source: 'prior' })
  })

  test('few samples are shrunk toward the prior; many reach p90 + 15%', () => {
    const one = forecastAgent([agent(1000)], 'general-purpose', 307, NOW)
    // one sample weighs 1/(1+5) against the prior
    expect(one.mb).toBe(Math.round((1 / 6) * 1150 + (5 / 6) * 307))
    const many = forecastAgent([...Array(200)].map((_, i) => agent(i < 180 ? 400 : 900)), 'general-purpose', 307, NOW)
    expect(many.learnedMB).toBe(460)
    expect(many.mb).toBeGreaterThan(450)
    expect(many.source).toBe('type')
  })

  test('a type with few runs borrows the pool; with enough it stands alone', () => {
    const pool = [...Array(10)].map(() => agent(800))
    const two = [agent(100, { type: 'Explore' }), agent(100, { type: 'Explore' })]
    expect(forecastAgent([...pool, ...two], 'Explore', 307, NOW).source).toBe('pool')
    const three = [...two, agent(100, { type: 'Explore' })]
    const f = forecastAgent([...pool, ...three], 'Explore', 307, NOW)
    expect(f.source).toBe('type')
    expect(f.learnedMB).toBe(115)
  })

  test('old runs fade (3-day half-life) and runs too short to measure are ignored', () => {
    const old = [...Array(20)].map(() => agent(2000, { t: NOW - 30 * DAY }))
    const recent = [...Array(20)].map(() => agent(300))
    expect(forecastAgent([...old, ...recent], 'general-purpose', 307, NOW).learnedMB).toBe(345)
    expect(forecastAgent([agent(5000, { samples: 0 })], 'general-purpose', 307, NOW).source).toBe('prior')
    expect(forecastAgent([agent(5000, { t: NOW - MODEL.maxAgeMs - 1 })], 'general-purpose', 307, NOW).source).toBe('prior')
  })
})

describe('session forecast', () => {
  test('p90 of own peak plus the median of the children, shrunk toward the option', () => {
    expect(forecastSession([], 716.8, NOW)).toEqual({ mb: 716.8, n: 0, source: 'prior' })
    const many = [...Array(100)].map((_, i) => session(700, i % 10 === 0 ? 2600 : 300))
    const f = forecastSession(many, 716.8, NOW)
    // self 700 × 1.15 = 805, children median 300 × 1.15 = 345 (the 2.6 GB dev servers don't move a median)
    expect(f.learnedMB).toBe(805 + 345)
    expect(f.mb).toBeGreaterThan(1100)
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
