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
})

/** Rounded to what the lines show (0.1 GB), so a few MB of drift doesn't redraw them. */
const tenth = (mb: number) => (Math.round(mb / 102.4) * 1024) / 10

/**
 * The badge for the latest snapshot read; rebuilt every tick, redrawn only when
 * it changes. `agent` is the gate's verdict for one more general-purpose subagent.
 */
export const badgeModel = (s: Snapshot | undefined, now: number, view: GateView | undefined, agent?: Verdict): ClearanceBadge => {
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
 * The footer's live line. The footer cuts it at about 22 characters and shows
 * the whole on hover, so the colored head says what can start and the dim tail
 * carries the numbers.
 */
export const footerLine = (b: ClearanceBadge): BadgeRun[] => {
  const tier = light(b)
  const head = (text: string): BadgeRun => ({ text, color: LIGHT_COLOR[tier], strong: true })
  if (tier === 'grey') return [head('● clearance'), { text: ` ${b.note}`, dim: true }]
  const free = `${gb(b.availableMB)} GB free, RAM ${b.usedPct}%`
  if (tier === 'green')
    return [head(`● cleared for ${plural(b.fits, 'session')}`), { text: ` · ${plural(b.agentFits, 'agent')} · ${free}`, dim: true }]
  if (tier === 'yellow')
    return [head(`● cleared for ${plural(b.agentFits, 'agent')}`), { text: ` · no new session · ${free}`, dim: true }]
  return [head('● on hold'), { text: ` · nothing fits · ${free}`, dim: true }]
}
