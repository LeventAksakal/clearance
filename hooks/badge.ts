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
export type BadgeRun = { text: string; tone?: BadgeTone; strong?: boolean; dim?: boolean }

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

const BAR = 8

/**
 * The footer's live line: a RAM bar, then what fits. Short, since it shares the
 * footer with the model and effort labels.
 */
export const footerLine = (b: ClearanceBadge): BadgeRun[] => {
  if (b.mood === 'WAITING') return [{ text: 'clearance', tone: 'idle', strong: true }, { text: ` ${b.note}`, dim: true }]
  const lit = Math.min(BAR, Math.max(0, Math.round((b.usedPct / 100) * BAR)))
  const ram: BadgeTone = b.mood === 'HOLD' ? 'warn' : 'ok'
  return [
    { text: '▰'.repeat(lit), tone: ram },
    { text: '▱'.repeat(BAR - lit), dim: true },
    { text: ` ${b.usedPct}% · ${gb(b.availableMB)} GB free` },
    { text: ` · sessions `, dim: true },
    b.mood === 'HOLD' ? { text: 'hold', tone: 'warn', strong: true } : { text: `+${b.fits}`, tone: 'ok', strong: true },
    { text: ` · agents `, dim: true },
    b.agentFits > 0 ? { text: `+${b.agentFits}`, tone: 'ok', strong: true } : { text: 'hold', tone: 'warn', strong: true },
  ]
}
