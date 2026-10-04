import type { ClearanceBadge } from '../types'
import { census, type GateView } from './gate.ts'
import { ageMs, isFresh, type Snapshot } from './snapshot.ts'

// The band's badge: the marshaller sprite and one line, always up, so the
// machine's clearance reads at a glance beside the prompt. Pure: no `$` here.

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** The badge for the latest snapshot read; rebuilt every tick, redrawn only when it changes. */
export const badgeModel = (s: Snapshot | undefined, now: number, view: GateView | undefined): ClearanceBadge => {
  if (!s || !view) return { mood: 'WAITING', headroomMB: null, fits: 0, sessions: 0, agents: 0, reasons: [], note: 'waiting for a snapshot' }
  if (!isFresh(s, now))
    return { mood: 'WAITING', headroomMB: null, fits: 0, sessions: 0, agents: 0, reasons: [], note: `snapshot ${Math.round(ageMs(s, now) / 1000)} s old` }
  const c = census(s)
  return {
    mood: view.shown.state,
    // Rounded to what the line shows, so a few MB of drift doesn't redraw it.
    headroomMB: Math.round(view.shown.headroomMB / 102.4) * 102.4,
    fits: view.shown.fits,
    sessions: c.sessions,
    agents: c.agents,
    reasons: view.band?.reasons ?? [],
    note: '',
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
    const runs: BadgeRun[] = [{ text: 'Hold', tone: 'warn', strong: true }, { text: `  ${head} GB headroom` }]
    if (columns >= 60) runs.push({ text: `  ${b.reasons.join('; ')}`, dim: true })
    if (columns >= 100) runs.push({ text: '  · divert: cloud session, Remote Control or ssh', dim: true })
    return runs
  }
  const runs: BadgeRun[] = [{ text: 'Cleared', tone: 'ok', strong: true }, { text: `  ${head} GB headroom` }]
  if (columns >= 50) runs.push({ text: `  room for ${plural(b.fits, 'more session')}`, dim: true })
  if (columns >= 80) runs.push({ text: `  · ${census}`, dim: true })
  return runs
}

/** Text colors by tone, matching the sprite's paddles. */
export const TONE_COLOR: Record<BadgeTone, string> = { ok: '#3fb950', warn: '#f0a020', idle: '#94a3b8' }
