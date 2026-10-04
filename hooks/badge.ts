import type { ClearanceBadge } from '../types'
import { census, type GateView, type Verdict } from './gate.ts'
import { ageMs, isFresh, type Snapshot } from './snapshot.ts'

// The band's badge: the marshaller sprite and one line, always up, so the
// machine's clearance reads at a glance beside the prompt. Pure: no `$` here.

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** The badge for the latest snapshot read; rebuilt every tick, redrawn only when it changes. */
const waiting = (note: string): ClearanceBadge => ({
  mood: 'WAITING',
  headroomMB: null,
  fits: 0,
  agentFits: 0,
  sessions: 0,
  agents: 0,
  reasons: [],
  note,
  usedPct: 0,
  availableMB: 0,
  totalMB: 0,
  floorMB: 0,
  agentAskMB: 0,
  sessionAskMB: 0,
  rows: [],
  otherMB: 0,
})

/** What the chip needs beyond the snapshot: this session, and the gate's floor and asks. */
export type BadgeContext = { me: string; floorMB: number; agentAskMB: number; sessionAskMB: number }

/** Rounded to what the lines show (0.1 GB), so a few MB of drift doesn't redraw them. */
const tenth = (mb: number) => (Math.round(mb / 102.4) * 1024) / 10

/**
 * The badge for the latest snapshot read; rebuilt every tick, redrawn only when
 * it changes. `agent` is the gate's verdict for one more general-purpose subagent.
 */
export const badgeModel = (
  s: Snapshot | undefined,
  now: number,
  view: GateView | undefined,
  agent?: Verdict,
  at: BadgeContext = { me: '', floorMB: 0, agentAskMB: 0, sessionAskMB: 0 },
): ClearanceBadge => {
  if (!s || !view) return waiting('waiting for a snapshot')
  if (!isFresh(s, now)) return waiting(`snapshot ${Math.round(ageMs(s, now) / 1000)} s old`)
  const c = census(s)
  const m = s.machine
  return {
    mood: view.shown.state,
    headroomMB: tenth(view.shown.headroomMB),
    fits: view.shown.fits,
    agentFits: agent?.fits ?? 0,
    sessions: c.sessions,
    agents: c.agents,
    reasons: view.band?.reasons ?? [],
    note: '',
    usedPct: Math.round(((m.totalMB - m.availableMB) / m.totalMB) * 100),
    availableMB: tenth(m.availableMB),
    totalMB: m.totalMB,
    floorMB: at.floorMB,
    agentAskMB: tenth(at.agentAskMB),
    sessionAskMB: tenth(at.sessionAskMB),
    rows: s.sessions
      .map(r => ({
        where: r.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? r.cwd,
        selfMB: tenth(r.selfMB),
        childMB: tenth(r.childMB),
        agents: r.agentsInFlight ?? null,
        isSelf: r.sessionId === at.me,
      }))
      .sort((a, b) => b.selfMB + b.childMB - (a.selfMB + a.childMB)),
    otherMB: tenth(Math.max(0, m.totalMB - m.availableMB - s.sessions.reduce((sum, r) => sum + r.selfMB + r.childMB, 0))),
  }
}

export type BadgeTone = 'ok' | 'warn' | 'idle'

/** A run of the badge's line: `strong` is the word, `dim` the rest. */
export type BadgeRun = { text: string; tone?: BadgeTone; color?: string; strong?: boolean; dim?: boolean }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The line beside the sprite, cut to fit `columns` (the sprite takes its own width before it). */
export const badgeLine = (b: ClearanceBadge, columns: number): BadgeRun[] => {
  if (b.mood === 'WAITING') return [{ text: 'Clearance', tone: 'idle', strong: true }, { text: `  ${b.note}`, dim: true }]
  const head = gb(b.headroomMB ?? 0)
  const census = `${plural(b.sessions, 'session')}, ${plural(b.agents, 'agent')}`
  if (b.mood === 'HOLD') {
    const runs: BadgeRun[] = [
      { text: 'Hold', tone: 'warn', strong: true },
      { text: ` new sessions  ${head} GB headroom` },
      { text: b.agentFits > 0 ? `  · ${plural(b.agentFits, 'subagent')} still fit` : '  · no subagents fit', dim: true },
    ]
    if (columns >= 60) runs.push({ text: `  ${b.reasons.join('; ')}`, dim: true })
    if (columns >= 100) runs.push({ text: '  · divert: cloud session, Remote Control or ssh', dim: true })
    return runs
  }
  const runs: BadgeRun[] = [{ text: 'Cleared', tone: 'ok', strong: true }, { text: `  ${head} GB headroom` }]
  if (columns >= 50) runs.push({ text: `  room for ${plural(b.fits, 'more session')}, ${plural(b.agentFits, 'subagent')}`, dim: true })
  if (columns >= 80) runs.push({ text: `  · ${census}`, dim: true })
  return runs
}

/** Text colors by tone, matching the sprite's paddles. */
export const TONE_COLOR: Record<BadgeTone, string> = { ok: '#3fb950', warn: '#f0a020', idle: '#94a3b8' }

/** Traffic-light tiers for the footer: what can still start. */
export type Light = 'green' | 'yellow' | 'red' | 'grey'

/** green: a session fits; yellow: only subagents fit; red: nothing fits; grey: no numbers. */
export const light = (b: ClearanceBadge): Light =>
  b.mood === 'WAITING' ? 'grey' : b.mood === 'CLEARED' && b.fits > 0 ? 'green' : b.agentFits > 0 ? 'yellow' : 'red'

export const LIGHT_COLOR: Record<Light, string> = { green: '#3fb950', yellow: '#e3b341', red: '#f85149', grey: '#94a3b8' }

/**
 * The chip's line: the colored head says what can start, or why nothing can;
 * the RAM figure follows. Dense, so it shows whole beside the prompt.
 */
export const footerLine = (b: ClearanceBadge): BadgeRun[] => {
  const tier = light(b)
  const head = (text: string): BadgeRun => ({ text, color: LIGHT_COLOR[tier], strong: true })
  if (tier === 'grey') return [head('● clearance'), { text: ` ${b.note}`, dim: true }]
  const ram = { text: ` · RAM ${b.usedPct}%`, dim: true }
  if (tier === 'green') return [head(`● cleared: ${plural(b.fits, 'session')}, ${plural(b.agentFits, 'agent')}`), ram]
  if (tier === 'yellow') return [head(`● cleared: ${plural(b.agentFits, 'agent')}`), { text: ', no session', color: LIGHT_COLOR.yellow }, ram]
  const short = b.availableMB - b.floorMB < b.agentAskMB
  return [head('● hold: '), { text: short ? `${gb(b.availableMB)} GB free, floor ${gb(b.floorMB)}` : b.reasons[0] ?? 'nothing fits', color: LIGHT_COLOR.red }, ram]
}

const col = (text: string, width: number) => (text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width))
const num = (mb: number) => gb(mb).padStart(5)

/** The hover card: the machine, why, and every session's use. One run list per line. */
export const cardLines = (b: ClearanceBadge): BadgeRun[][] => {
  if (b.mood === 'WAITING') return [[{ text: `clearance: ${b.note}`, dim: true }]]
  const used = b.totalMB - b.availableMB
  const lines: BadgeRun[][] = [
    [{ text: 'RAM ', strong: true }, { text: `${gb(used)} of ${gb(b.totalMB)} GB in use, ${gb(b.availableMB)} GB free, floor ${gb(b.floorMB)} GB` }],
    [
      { text: 'asks ', strong: true },
      { text: `session ${gb(b.sessionAskMB)} GB, subagent ${gb(b.agentAskMB)} GB → ` },
      { text: `${plural(b.fits, 'session')}, ${plural(b.agentFits, 'agent')} fit`, color: LIGHT_COLOR[light(b)] },
    ],
  ]
  for (const reason of b.reasons) lines.push([{ text: `hold: ${reason}`, color: LIGHT_COLOR.red }])
  lines.push([{ text: `${col('session', 16)} ${'self'.padStart(5)} ${'child'.padStart(5)}  agents`, dim: true }])
  for (const r of b.rows)
    lines.push([
      { text: `${col(r.where, 16)} ${num(r.selfMB)} ${num(r.childMB)}  ${r.agents === null ? '-' : r.agents}`, strong: r.isSelf },
      ...(r.isSelf ? [{ text: '  ← this', dim: true }] : []),
    ])
  lines.push([{ text: `${col('everything else', 16)} ${num(b.otherMB)}`, dim: true }, { text: '  desktop app, WSL, browsers…', dim: true }])
  return lines
}

