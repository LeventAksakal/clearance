import type { ClearancePane, ClearancePaneSession } from '../types'
import { attributeContainers } from './checks.ts'
import { census, floorMB, type GateOptions, type GateView } from './gate.ts'
import type { Snapshot } from './snapshot.ts'

// The /clearance pane (design.md § UI): the model built from each sample, and
// its lines laid out to the pane's width. Pure: no `$` here. Desktop-app and
// Docker rows, unattributed containers and the convention checks join in step 6.

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** The last two segments of a folder: `Code\clearance`. */
export const shortPath = (path: string) => path.split(/[\\/]+/).filter(Boolean).slice(-2).join('\\')

export const paneModel = (s: Snapshot, view: GateView, o: GateOptions, me: string, isScribe: boolean, now: number, floorBasis = ''): ClearancePane => {
  const c = census(s)
  const { bySession, unattributed } = attributeContainers(s)
  const others: string[] = []
  if (s.machine.pagesInPerSec !== undefined) others.push(`paging ${Math.round(s.machine.pagesInPerSec)} pages/s · floor ${floorBasis || 'policy'}`)
  if (s.desktop) others.push(`desktop app ${gb(s.desktop.privateMB)} GB (${s.desktop.procs} processes)`)
  if (s.dockerVm) others.push(`WSL/Docker VM ${gb(s.dockerVm.privateMB)} GB · containers ${gb(s.dockerVm.containersMB)} GB`)
  for (const ctr of unattributed) others.push(`  unattributed container ${ctr.name} (${ctr.project ?? 'no project'}) ${gb(ctr.memMB)} GB`)
  const sessions: ClearancePaneSession[] = s.sessions
    .map(r => {
      const top = r.topChildren[0]
      return {
        id: r.sessionId.slice(0, 8),
        where: shortPath(r.cwd),
        selfMB: r.selfMB,
        childMB: r.childMB,
        children: r.children,
        agents: r.agentsInFlight ?? null,
        progressAgoS: r.lastProgressAt ? Math.max(0, Math.round((now - r.lastProgressAt) / 1000)) : null,
        top: [top ? `${top.name} ${gb(top.privateMB)}` : '', ...(bySession.get(r.sessionId) ?? []).map(ctr => `${ctr.name} ${gb(ctr.memMB)}`)].filter(Boolean).join(', '),
        isSelf: r.sessionId === me,
      }
    })
    .sort((a, b) => b.selfMB + b.childMB - (a.selfMB + a.childMB))
  return {
    t: s.t,
    epoch: s.epoch,
    isScribe,
    state: view.shown.state,
    headroomMB: view.shown.headroomMB,
    fits: view.shown.fits,
    reasons: view.band?.reasons ?? [],
    machine: s.machine,
    limits: { minFreeGB: Math.round(floorMB(o, s.machine.totalMB) / 102.4) / 10, maxCommitPct: o.maxCommitPct, maxSessions: o.maxSessions, maxAgents: o.maxAgents },
    agents: c.agents,
    reservedMB: c.reservedMB,
    sessions,
    others,
  }
}

export type Tone = 'plain' | 'dim' | 'ok' | 'warn' | 'head'
/** A table cell: a fixed `width` in character cells (`ch` on the desktop), `right` aligned for numbers; no width takes the rest. */
export type PaneCell = { text: string; width?: number; right?: boolean }
/** A line; a table row also carries its cells, so a proportional font still lines the columns up. */
export type PaneLine = { text: string; tone: Tone; cells?: PaneCell[] }

const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width))
const right = (text: string, width: number) => (text.length > width ? text.slice(0, width) : text.padStart(width))

const ago = (s: number | null) => (s === null ? '-' : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)

/** The pane's lines for a body `columns` wide. */
export const paneLines = (m: ClearancePane | null, columns: number, now: number): PaneLine[] => {
  if (!m) return [{ text: 'Waiting for the first machine sample…', tone: 'dim' }]
  const w = Math.max(40, columns)
  const out: PaneLine[] = []
  const held = m.state !== 'CLEARED'
  out.push({
    text: m.state === 'THRASH' ? `THRASH · every spawn refused` : held ? `HOLD · headroom ${gb(m.headroomMB)} GB` : `CLEARED · headroom ${gb(m.headroomMB)} GB · ${m.fits} more session${m.fits === 1 ? '' : 's'}`,
    tone: held ? 'warn' : 'ok',
  })
  for (const r of m.reasons) out.push({ text: `  ${r}`, tone: 'warn' })
  const mm = m.machine
  out.push({
    text: `available ${gb(mm.availableMB)} of ${gb(mm.totalMB)} GB (floor ${m.limits.minFreeGB}) · commit ${gb(mm.commitMB)}/${gb(mm.commitLimitMB)} GB (ceiling ${m.limits.maxCommitPct}%)`,
    tone: 'plain',
  })
  out.push({
    text: `sessions ${m.sessions.length}/${m.limits.maxSessions} · subagents ${m.agents}/${m.limits.maxAgents} · reserved ${gb(m.reservedMB)} GB · sampled ${Math.max(0, Math.round((now - m.t) / 1000))} s ago · epoch ${m.epoch}${m.isScribe ? ' (this session is scribe)' : ''}`,
    tone: 'dim',
  })
  out.push({ text: '', tone: 'plain' })

  // session(9) self(7) children(12) agents(7) progress(9) = 44, then where and top share the rest.
  const rest = Math.max(10, w - 44 - 2)
  const whereW = Math.min(28, Math.ceil(rest / 2))
  const topW = Math.max(0, rest - whereW)
  const text = (id: string, where: string, self: string, kids: string, agents: string, progress: string, top: string) =>
    `${fit(id, 9)}${fit(where, whereW)} ${right(self, 6)} ${right(kids, 11)} ${right(agents, 6)} ${right(progress, 8)}  ${fit(top, topW)}`.trimEnd()
  const cells = (id: string, where: string, self: string, kids: string, agents: string, progress: string, top: string): PaneCell[] => [
    { text: id, width: 9 },
    { text: where, width: whereW },
    { text: self, width: 7, right: true },
    { text: kids, width: 12, right: true },
    { text: agents, width: 7, right: true },
    { text: progress, width: 9, right: true },
    { text: '', width: 2 },
    { text: top },
  ]
  const row = (...c: Parameters<typeof text>) => ({ text: text(...c), cells: cells(...c) })
  out.push({ ...row('session', 'where', 'self', 'children', 'agents', 'progress', 'largest child'), tone: 'head' })
  for (const s of m.sessions) {
    out.push({
      ...row(
        `${s.id}${s.isSelf ? '*' : ''}`,
        s.where,
        gb(s.selfMB),
        `${gb(s.childMB)} (${s.children})`,
        s.agents === null ? '-' : String(s.agents),
        ago(s.progressAgoS),
        s.top,
      ),
      tone: s.isSelf ? 'plain' : 'dim',
    })
  }
  out.push({ text: '', tone: 'plain' })
  for (const line of m.others ?? []) out.push({ text: fit(line, w).trimEnd(), tone: 'dim' })
  out.push({ text: fit('GB, private bytes. * this session. "-": a session without clearance. /clearance check: the convention checks.', w).trimEnd(), tone: 'dim' })
  return out
}
