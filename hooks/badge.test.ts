import { describe, expect, test } from 'claude-code/testing'
import { badgeLine, badgeModel, footerLine, light } from './badge.ts'
import { DEFAULTS, advance, gate } from './gate.ts'
import type { Snapshot } from './snapshot.ts'
import { FRAMES, H, W, frame, spriteSvg } from './sprite.ts'

const snap = (availableMB: number, sessions = 2): Snapshot => ({
  schema: 1,
  epoch: 1,
  t: 1_000,
  sampleMs: 100,
  intervalMs: 5_000,
  machine: { totalMB: 16384, availableMB, commitMB: 30_720, commitLimitMB: 49_152 },
  sessions: Array.from({ length: sessions }, (_, i) => ({
    sessionId: `s${i}`,
    pid: i + 1,
    cwd: 'C:\\x',
    entrypoint: 'cli',
    selfMB: 600,
    childMB: 0,
    children: 0,
    topChildren: [],
    agentsInFlight: i,
  })),
})

const text = (runs: { text: string }[]) => runs.map(r => r.text).join('')

describe('sprite', () => {
  test('every mood has twelve frames of the sprite size', () => {
    for (const mood of ['CLEARED', 'HOLD', 'WAITING'] as const) {
      const frames = Array.from({ length: FRAMES }, (_, i) => frame(mood, i))
      expect(frames.length).toBe(12)
      for (const f of frames) {
        expect(f.length).toBe(H)
        for (const row of f) expect(row.length).toBe(W)
      }
      // It moves: not every frame is the same.
      expect(new Set(frames.map(f => f.join('\n'))).size).toBeGreaterThan(1)
    }
  })

  test('the SVG flips its frames with discrete SMIL and fits the Svg element', () => {
    for (const mood of ['CLEARED', 'HOLD', 'WAITING'] as const) {
      const svg = spriteSvg(mood)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.length).toBeLessThan(131_072)
      expect(svg.match(/<animate /g)?.length).toBe(FRAMES)
      expect(svg).toContain('calcMode="discrete"')
      expect(svg).not.toContain('<script')
    }
  })
})

describe('badge', () => {
  test('waits without a snapshot, and says a stale one is stale', () => {
    expect(badgeModel(undefined, 0, undefined)).toMatchObject({ mood: 'WAITING', note: 'waiting for a snapshot' })
    const s = snap(8000)
    const view = advance(undefined, s, DEFAULTS)
    expect(badgeModel(s, 61_000, view)).toMatchObject({ mood: 'WAITING', note: 'snapshot 60 s old' })
  })

  test('cleared: headroom, room for more, the census', () => {
    const s = snap(8000, 3)
    const b = badgeModel(s, 2_000, advance(undefined, s, DEFAULTS), gate(s, DEFAULTS, { kind: 'agent', mb: 300 }))
    expect(b).toMatchObject({ mood: 'CLEARED', sessions: 3, agents: 3, usedPct: 51, availableMB: 7987.2 })
    expect(text(badgeLine(b, 120))).toBe('Cleared  6.3 GB headroom  room for 3 more sessions, 5 subagents  · 3 sessions, 3 agents')
    expect(text(badgeLine(b, 40))).toBe('Cleared  6.3 GB headroom')
  })

  test('hold: the reasons, and where to divert on a wide band', () => {
    const s = snap(1024)
    const b = badgeModel(s, 2_000, advance(undefined, s, DEFAULTS), gate(s, DEFAULTS, { kind: 'agent', mb: 300 }))
    expect(b.mood).toBe('HOLD')
    expect(text(badgeLine(b, 120))).toContain('Hold new sessions  0.0 GB headroom  · no subagents fit  available 1.0 GB, floor 1.5 GB')
    expect(text(badgeLine(b, 120))).toContain('divert')
    expect(text(badgeLine(b, 70))).not.toContain('divert')
  })
})

describe('footer', () => {
  const at = (availableMB: number) => {
    const s = snap(availableMB)
    return badgeModel(s, 2_000, advance(undefined, s, DEFAULTS), gate(s, DEFAULTS, { kind: 'agent', mb: 300 }))
  }

  test('green while a session fits, with the numbers after the phrase', () => {
    const b = at(2048 + 600) // 1.1 GB over the 1.5 GB floor: one 0.7 GB session, or three 0.3 GB subagents
    expect(light(b)).toBe('green')
    expect(text(footerLine(b))).toBe('● cleared for 1 session · 3 agents · 2.6 GB free, RAM 84%')
  })

  test('yellow when only subagents fit', () => {
    const b = at(1536 + 400)
    expect(light(b)).toBe('yellow')
    expect(text(footerLine(b))).toBe('● cleared for 1 agent · no new session · 1.9 GB free, RAM 88%')
  })

  test('red when nothing fits, grey without numbers', () => {
    expect(light(at(1600))).toBe('red')
    expect(text(footerLine(at(1600)))).toBe('● on hold · nothing fits · 1.6 GB free, RAM 90%')
    expect(text(footerLine(badgeModel(undefined, 0, undefined)))).toBe('● clearance waiting for a snapshot')
  })

  test('the colored head fits the footer before it cuts', () => {
    for (const mb of [8000, 2648, 1936, 1600]) expect(footerLine(at(mb))[0]!.text.length).toBeLessThanOrEqual(24)
  })
})
