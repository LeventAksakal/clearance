import type { GateState } from './gate.ts'

// snapshot.json, schema 1: the contract other mods read (0005). The scribe's
// sampler writes it; every session reads it. Pure: no `$` here.

export const SCHEMA = 1

/** A snapshot older than this many intervals means its scribe is gone. */
export const STALE_INTERVALS = 3

export type MachineSample = {
  totalMB: number
  /** Free plus standby: what can be handed out without paging. The headroom number. */
  availableMB: number
  commitMB: number
  commitLimitMB: number
}

export type ChildSample = { pid: number; name: string; privateMB: number }

export type SessionSample = {
  sessionId: string
  pid: number
  cwd: string
  entrypoint: string
  selfMB: number
  childMB: number
  children: number
  topChildren: ChildSample[]
  /** From the session's presence file; absent when it has none (a session without the mod). */
  agentsInFlight?: number
  reservedMB?: number
  lastProgressAt?: number
}

export type Snapshot = {
  schema: typeof SCHEMA
  epoch: number
  t: number
  sampleMs: number
  intervalMs: number
  machine: MachineSample
  sessions: SessionSample[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The snapshot in `text`, or undefined when it is not a schema-1 snapshot. */
export const parseSnapshot = (text: string): Snapshot | undefined => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof doc !== 'object' || doc === null) return undefined
  const s = doc as Partial<Snapshot>
  if (s.schema !== SCHEMA || !isNum(s.epoch) || !isNum(s.t) || !isNum(s.intervalMs)) return undefined
  const m = s.machine
  if (!m || !isNum(m.availableMB) || !isNum(m.totalMB) || !isNum(m.commitMB) || !isNum(m.commitLimitMB)) return undefined
  return { ...s, sessions: Array.isArray(s.sessions) ? s.sessions : [] } as Snapshot
}

/** Just the heartbeat, `epoch` and `t`, whatever else the snapshot carries. The election reads only this. */
export const parseBeat = (text: string): { epoch: number; t: number } | undefined => {
  try {
    const d = JSON.parse(text) as { epoch?: unknown; t?: unknown }
    return isNum(d.epoch) && isNum(d.t) ? { epoch: d.epoch, t: d.t } : undefined
  } catch {
    return undefined
  }
}

export const ageMs = (s: Snapshot, now: number) => now - s.t

export const isFresh = (s: Snapshot, now: number) => ageMs(s, now) <= STALE_INTERVALS * s.intervalMs

export type Epochs = {
  /** The highest claimed epoch, or undefined when none has been claimed. */
  highest: number | undefined
  /** Every claimed epoch, newest first. */
  claimed: number[]
  resigned: Set<number>
}

/** Reads the names in the scribe directory: `epoch-<n>` and `resigned-<n>`. */
export const parseEpochs = (names: readonly string[]): Epochs => {
  const claimed: number[] = []
  const resigned = new Set<number>()
  for (const name of names) {
    const m = /^(epoch|resigned)-(\d+)$/.exec(name)
    if (!m) continue
    const n = Number(m[2])
    if (m[1] === 'epoch') claimed.push(n)
    else resigned.add(n)
  }
  claimed.sort((a, b) => b - a)
  return { highest: claimed[0], claimed, resigned }
}

/** A reader drops a snapshot written under an epoch below the highest claimed one (fencing). */
export const isCurrent = (s: Snapshot, epochs: Epochs) => epochs.highest === undefined || s.epoch >= epochs.highest

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** What the status line shows for a fresh snapshot: the settled state, the headroom and how many more sessions fit. */
export type Shown = { state: GateState; headroomMB: number; fits: number }

/** The status line: `clearance ✓ 3.1 GB · 2 more`, `clearance ■ HOLD 0.4 GB`, or why there are no numbers. */
export const statusLine = (s: Snapshot | undefined, now: number, shown: Shown | undefined): string => {
  if (!s || !shown) return 'clearance · waiting for a snapshot'
  if (!isFresh(s, now)) return `clearance · snapshot ${Math.round(ageMs(s, now) / 1000)} s old`
  if (shown.state === 'HOLD') return `clearance ■ HOLD ${gb(shown.headroomMB)} GB`
  return `clearance ✓ ${gb(shown.headroomMB)} GB · ${shown.fits} more`
}
