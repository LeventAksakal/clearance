import type { ClearanceBadge } from '../types'
import { attributeContainers } from './checks.ts'
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
  agentBasis: '',
  rows: [],
  otherMB: 0,
  ramTrail: [],
  pagesInPerSec: null,
  floorBasis: '',
  desktopMB: 0,
  dockerVmMB: 0,
  unattributedContainersMB: 0,
})

/** What the chip needs beyond the snapshot: this session, and the gate's floor and asks. */
export type BadgeContext = { me: string; floorMB: number; agentAskMB: number; sessionAskMB: number; ramTrail?: number[]; floorBasis?: string; agentBasis?: string }

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
  const { bySession, unattributed } = attributeContainers(s)
  const sum = (xs: readonly { memMB: number }[] | undefined) => (xs ?? []).reduce((a, x) => a + x.memMB, 0)
  const sessionsMB = s.sessions.reduce((a, r) => a + r.selfMB + r.childMB, 0)
  const known = sessionsMB + (s.desktop?.privateMB ?? 0) + (s.dockerVm?.privateMB ?? 0)
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
    agentAskMB: Math.round(at.agentAskMB),
    sessionAskMB: Math.round(at.sessionAskMB),
    agentBasis: at.agentBasis ?? '',
    rows: s.sessions
      .map(r => ({
        where: r.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? r.cwd,
        selfMB: tenth(r.selfMB),
        childMB: tenth(r.childMB),
        agents: r.agentsInFlight ?? null,
        isSelf: r.sessionId === at.me,
        containersMB: tenth(sum(bySession.get(r.sessionId))),
      }))
      .sort((a, b) => b.selfMB + b.childMB - (a.selfMB + a.childMB)),
    otherMB: tenth(Math.max(0, m.totalMB - m.availableMB - known)),
    ramTrail: at.ramTrail ?? [],
    pagesInPerSec: m.pagesInPerSec ?? null,
    floorBasis: at.floorBasis ?? '',
    desktopMB: tenth(s.desktop?.privateMB ?? 0),
    dockerVmMB: tenth(s.dockerVm?.privateMB ?? 0),
    unattributedContainersMB: tenth(sum(unattributed)),
  }
}

export type BadgeTone = 'ok' | 'warn' | 'idle'

/** A run of the badge's line: `strong` is the word, `dim` the rest. */
export type BadgeRun = { text: string; tone?: BadgeTone; color?: string; strong?: boolean; dim?: boolean }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Text colors by tone, matching the sprite's paddles. */
export const TONE_COLOR: Record<BadgeTone, string> = { ok: '#3fb950', warn: '#f0a020', idle: '#94a3b8' }

/** Traffic-light tiers for the footer: what can still start. */
export type Light = 'green' | 'yellow' | 'red' | 'grey'

/** green: a session fits; yellow: only subagents fit; red: nothing fits; grey: no numbers. */
export const light = (b: ClearanceBadge): Light =>
  b.mood === 'WAITING' ? 'grey' : b.mood === 'THRASH' ? 'red' : b.mood === 'CLEARED' && b.fits > 0 ? 'green' : b.agentFits > 0 ? 'yellow' : 'red'

export const LIGHT_COLOR: Record<Light, string> = { green: '#3fb950', yellow: '#e3b341', red: '#f85149', grey: '#94a3b8' }

/** A size as the card says it: MB under 1 GB, so a 23 MB subagent doesn't read as 0.0 GB. */
export const size = (mb: number) => (mb < 1000 ? `${Math.round(mb)} MB` : `${gb(mb)} GB`)

/**
 * One cell of a hover-card row. A `width` (character cells; `ch` on the
 * desktop) makes it a column, cut with an ellipsis; `right` aligns it to its
 * column's end, so numbers line up whatever the font. No width: the rest of the row.
 */
export type CardCell = BadgeRun & { width?: number; right?: boolean }
export type CardRow = CardCell[]

/** Column widths: labels; then the table's name, three sizes and the subagent count. */
export const COL = { label: 8, name: 18, num: 7, agents: 8 } as const

const cell = (text: string, width: number, rest: Omit<CardCell, 'text' | 'width'> = {}): CardCell => ({ text, width, ...rest })
const n1 = (mb: number) => gb(mb)

const tableRow = (name: string, nums: (number | null)[], agents: string, rest: Omit<CardCell, 'text' | 'width'> = {}): CardRow => [
  cell(name, COL.name, rest),
  ...nums.map(mb => cell(mb === null ? '' : n1(mb), COL.num, { ...rest, right: true })),
  cell(agents, COL.agents, { ...rest, right: true }),
]

/** The hover card: the machine, why, and every session's use, in columns. */
export const cardRows = (b: ClearanceBadge): CardRow[] => {
  if (b.mood === 'WAITING') return [[{ text: `clearance: ${b.note}`, dim: true }]]
  const used = b.totalMB - b.availableMB
  const label = (text: string) => cell(text, COL.label, { strong: true })
  const rows: CardRow[] = [
    [label('RAM'), { text: `${gb(used)} of ${gb(b.totalMB)} GB in use, ${gb(b.availableMB)} GB free, floor ${gb(b.floorMB)} GB` }],
    [label('paging'), { text: `${b.pagesInPerSec === null ? 'not read' : `${Math.round(b.pagesInPerSec)}/s`} · floor: ${b.floorBasis || 'policy, 5% of RAM'}`, dim: true }],
    [
      label('asks'),
      { text: `session ${size(b.sessionAskMB)}, subagent ${size(b.agentAskMB)} → ` },
      { text: `${plural(b.fits, 'session')}, ${plural(b.agentFits, 'agent')} fit`, color: LIGHT_COLOR[light(b)] },
    ],
  ]
  if (b.agentBasis) rows.push([cell('', COL.label), { text: `subagent: ${b.agentBasis}`, dim: true }])
  for (const reason of b.reasons) rows.push([label('hold'), { text: reason, color: LIGHT_COLOR.red }])
  rows.push([{ text: ' ' }])
  const head = { dim: true }
  rows.push([cell('GB', COL.name, head), ...['self', 'child', 'ctr'].map(h => cell(h, COL.num, { ...head, right: true })), cell('agents', COL.agents, { ...head, right: true })])
  for (const r of b.rows)
    rows.push([
      ...tableRow(r.where, [r.selfMB, r.childMB, r.containersMB], r.agents === null ? '–' : String(r.agents), { strong: r.isSelf }),
      ...(r.isSelf ? [{ text: '  ← this', dim: true }] : []),
    ])
  const other = { dim: true }
  if (b.desktopMB) rows.push(tableRow('desktop app', [b.desktopMB, null, null], '', other))
  if (b.dockerVmMB) rows.push(tableRow('WSL/Docker VM', [b.dockerVmMB, null, b.unattributedContainersMB], '', other).concat([{ text: '  ctr: no session', dim: true }]))
  rows.push(tableRow('everything else', [b.otherMB, null, null], '', other).concat([{ text: '  browsers, system', dim: true }]))
  return rows
}

/** A row as plain text, cells padded to their columns: the terminal's fallback and the tests'. */
export const rowText = (row: CardRow) =>
  row
    .map(c => {
      if (c.width === undefined) return c.text
      const t = c.text.length > c.width ? c.text.slice(0, c.width - 1) + '…' : c.text
      return c.right ? t.padStart(c.width) : t.padEnd(c.width)
    })
    .join('')

const SPARK = '▁▂▃▄▅▆▇█'

/** RAM in use as a sparkline, scaled 0–100%, so its height reads as how full the machine is. */
export const sparkline = (pcts: readonly number[]) =>
  pcts.map(p => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.floor((p / 100) * SPARK.length)))]).join('')

/**
 * The band's one dense line, beside the marshaller: the verdict in its tier's
 * color (`2s·6a`: sessions and subagents that fit), the RAM trail, use, free.
 */
export const bandLine = (b: ClearanceBadge): BadgeRun[] => {
  const tier = light(b)
  const color = LIGHT_COLOR[tier]
  if (tier === 'grey') return [{ text: '● clearance', color, strong: true }, { text: `  ${b.note}`, dim: true }]
  if (b.mood === 'THRASH')
    return [
      { text: '▲ THRASH', color, strong: true },
      { text: `  paging ${b.pagesInPerSec === null ? '?' : Math.round(b.pagesInPerSec)}/s  ${gb(b.availableMB)} GB free, floor ${gb(b.floorMB)}`, color },
      { text: '  spawns refused', dim: true },
    ]
  const verdict = tier === 'red' ? '● hold' : '● cleared'
  return [
    { text: verdict, color, strong: true },
    { text: ` ${b.fits}s·${b.agentFits}a`, color },
    { text: '  RAM ', dim: true },
    { text: sparkline(b.ramTrail.length ? b.ramTrail : [b.usedPct]), color },
    { text: ` ${b.usedPct}%` },
    { text: tier === 'red' ? `  ${gb(b.availableMB)} GB free, floor ${gb(b.floorMB)}` : `  ${gb(b.availableMB)} GB free`, dim: tier !== 'red', color: tier === 'red' ? color : undefined },
  ]
}
