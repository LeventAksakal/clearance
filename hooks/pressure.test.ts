import { describe, expect, test } from 'claude-code/testing'
import {
  attributeContainers,
  collisionFindings,
  hardPortFindings,
  hostPorts,
  supabaseFindings,
  unlabeledFindings,
} from './checks.ts'
import { DEFAULTS, advance, floorMB } from './gate.ts'
import { BUCKETS, MAX_SAMPLES, bucketOf, emptyPressure, fold, isPressured, isThrash, learnFloor, parsePressure, type Pressure } from './pressure.ts'
import type { Snapshot } from './snapshot.ts'

const TOTAL = 16_000 // 160 MB bins

/** `n` samples at `availableMB` paging `pages`/s, folded in. */
const feed = (p: Pressure, n: number, availableMB: number, pages: number) => {
  for (let i = 0; i < n; i++) p = fold(p, availableMB, pages, p.t + 1)
  return p
}

describe('paging histogram', () => {
  test('buckets are powers of two', () => {
    expect(bucketOf(0)).toBe(0)
    expect(bucketOf(1)).toBe(1)
    expect(bucketOf(3)).toBe(2)
    expect(bucketOf(4340)).toBe(13)
    expect(bucketOf(1e9)).toBe(BUCKETS - 1)
  })

  test('folds each sample once, and halves old counts past the cap', () => {
    let p = emptyPressure(TOTAL)
    p = fold(p, 3000, 100, 10)
    expect(fold(p, 3000, 100, 10)).toBe(p)
    expect(p.n).toBe(1)
    const big = { ...p, n: MAX_SAMPLES }
    const halved = fold(big, 3000, 100, 11)
    expect(halved.n).toBe(MAX_SAMPLES / 2 + 1)
    expect(halved.bins['18']![bucketOf(100)]).toBe(1.5)
  })

  test('round-trips as JSON', () => {
    const p = feed(emptyPressure(TOTAL), 3, 3000, 50)
    expect(parsePressure(JSON.stringify(p))).toEqual(p)
    expect(parsePressure('{')).toBeUndefined()
  })
})

describe('learned floor', () => {
  test('learning until there are enough samples', () => {
    expect(learnFloor(feed(emptyPressure(TOTAL), 10, 3000, 50)).mb).toBeUndefined()
  })

  test('no pressure below the median: the policy stands, and the basis says how low it was seen calm', () => {
    let p = emptyPressure(TOTAL)
    p = feed(p, 100, 6000, 40)
    p = feed(p, 100, 2000, 60)
    const f = learnFloor(p)
    expect(f.mb).toBeUndefined()
    expect(f.basis).toContain('no pressure seen below')
  })

  test('paging above the calm p90 below some level sets the floor at its top edge', () => {
    let p = emptyPressure(TOTAL)
    p = feed(p, 200, 6000, 50) // calm: ~50/s
    p = feed(p, 60, 2500, 80) // a bit busier, still within calm's spread? no: 80 > 64 bucket top
    p = feed(p, 60, 1200, 4000) // heavy paging at 1.2 GB
    const f = learnFloor(p)
    expect(f.calmP90).toBe(64)
    // the highest pressured bin is 2500 MB's (bin 15, top 2560)
    expect(f.mb).toBe(2560)
    expect(isPressured(4000, f)).toBe(true)
    expect(isPressured(40, f)).toBe(false)
    // and the gate uses it while the floor option is auto
    expect(floorMB({ ...DEFAULTS, learnedFloorMB: f.mb }, TOTAL)).toBe(2560)
    expect(floorMB({ ...DEFAULTS, minFreeGB: 1, learnedFloorMB: f.mb }, TOTAL)).toBe(1024)
  })
})

describe('THRASH', () => {
  test('three pressured samples below the floor, or under half the floor with no progress for 5 min', () => {
    expect(isThrash({ pressuredRun: 3, availableMB: 900, floorMB: 1000, lastProgressAt: 0, now: 1 })).toBe(true)
    expect(isThrash({ pressuredRun: 2, availableMB: 900, floorMB: 1000, lastProgressAt: 0, now: 1 })).toBe(false)
    expect(isThrash({ pressuredRun: 3, availableMB: 1100, floorMB: 1000, lastProgressAt: 0, now: 1 })).toBe(false)
    expect(isThrash({ pressuredRun: 0, availableMB: 400, floorMB: 1000, lastProgressAt: 0, now: 300_001 })).toBe(true)
    expect(isThrash({ pressuredRun: 0, availableMB: 400, floorMB: 1000, lastProgressAt: 10, now: 60_000 })).toBe(false)
  })

  test('settles with the same hysteresis and holds everything', () => {
    const s = (t: number): Snapshot => ({
      schema: 1,
      epoch: 1,
      t,
      sampleMs: 1,
      intervalMs: 5000,
      machine: { totalMB: TOTAL, availableMB: 8000, commitMB: 1, commitLimitMB: 99_999 },
      sessions: [],
    })
    let v = advance(undefined, s(1), { ...DEFAULTS, sessionBaselineGB: 0.7 })
    expect(v.shown.state).toBe('CLEARED')
    v = advance(v, s(2), DEFAULTS, 0, 'THRASH: test')
    expect(v.shown.state).toBe('CLEARED')
    v = advance(v, s(3), DEFAULTS, 0, 'THRASH: test')
    expect(v.shown.state).toBe('THRASH')
    expect(v.shown.fits).toBe(0)
    expect(v.band?.reasons).toEqual(['THRASH: test'])
  })
})

const snap = (over: Partial<Snapshot>): Snapshot => ({
  schema: 1,
  epoch: 1,
  t: 1,
  sampleMs: 1,
  intervalMs: 5000,
  machine: { totalMB: TOTAL, availableMB: 8000, commitMB: 1, commitLimitMB: 99_999 },
  sessions: [],
  ...over,
})
const row = (sessionId: string, cwd: string) => ({ sessionId, pid: 1, cwd, entrypoint: 'claude-desktop', selfMB: 1, childMB: 0, children: 0, topChildren: [] })

describe('container attribution', () => {
  test('by the compose working_dir inside a session folder, the longest folder winning; no label is unattributed', () => {
    const s = snap({
      sessions: [row('a', 'C:\\Code'), row('b', 'C:\\Code\\ozu-aps')],
      containers: [
        { name: 'pg', project: 'core', workingDir: 'C:\\Code\\ozu-aps\\core', memMB: 158 },
        { name: 'db', project: 'supabase', workingDir: null, memMB: 144 },
        { name: 'x', project: 'x', workingDir: 'D:\\elsewhere', memMB: 9 },
      ],
    })
    const { bySession, unattributed } = attributeContainers(s)
    expect(bySession.get('b')?.map(c => c.name)).toEqual(['pg'])
    expect(bySession.get('a')).toBeUndefined()
    expect(unattributed.map(c => c.name)).toEqual(['db', 'x'])
  })
})

describe('convention checks', () => {
  test('supabase project_id: the default, or one id in two folders', () => {
    const f = supabaseFindings([
      { dir: 'C:\\Code\\ar-18', projectId: 'supabase' },
      { dir: 'C:\\Code\\a', projectId: 'shop' },
      { dir: 'C:\\Code\\b', projectId: 'shop' },
    ])
    expect(f.map(x => x.detail)).toEqual(['project_id is the default "supabase"', 'project_id "shop" in 2 folders'])
  })

  test('a compose project without the working_dir label', () => {
    const f = unlabeledFindings([
      { name: 'a', project: 'supabase', workingDir: null, memMB: 1 },
      { name: 'b', project: 'supabase', workingDir: null, memMB: 1 },
      { name: 'c', project: 'core', workingDir: 'C:\\x', memMB: 1 },
    ])
    expect(f).toHaveLength(1)
    expect(f[0]!.detail).toBe('2 running containers without a com.docker.compose.project.working_dir label')
  })

  test('hard-coded host ports, but not env indirection', () => {
    const text = 'services:\n  db:\n    ports:\n      - "5432:5432"\n      - 8080:80\n      - "${WEB:-3000}:3000"\n'
    expect(hardPortFindings([{ path: 'compose.yml', text }])[0]!.detail).toBe('host ports 5432, 8080')
  })

  test('one host port from two owners; one project name from two folders', () => {
    expect(hostPorts('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 8080/tcp')).toEqual(['5432'])
    const f = collisionFindings([
      { name: 'a', project: 'core', workingDir: 'C:\\w1\\core', ports: '0.0.0.0:5432->5432/tcp', memMB: 1 },
      { name: 'b', project: 'core', workingDir: 'C:\\w2\\core', ports: '0.0.0.0:5432->5432/tcp', memMB: 1 },
    ])
    expect(f.map(x => x.check)).toEqual(['port collision', 'compose project name'])
  })
})
