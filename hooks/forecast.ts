// Step 5: forecasts learned from history (design.md § Step 5). Pure: no `$` here.
//
// The model follows the production recommenders for memory: size from peaks,
// not averages (a shortfall costs a stalled machine, not a slower one), take a
// high quantile of time-decayed samples and add a margin. Kubernetes VPA's
// defaults: p90 target, 15% margin. Google Autopilot: peaks or p98 for low
// tolerance, 48 h half-life. With few samples the learned value is shrunk
// toward the prior, so one odd run can't swing admission.

/** A finished subagent: how much its session's process tree grew while it ran. */
export type AgentRecord = {
  kind: 'agent'
  /** When it stopped. */
  t: number
  type: string
  durationMs: number
  /** Snapshots seen while it ran; 0 means it was too short to measure and the record is not used. */
  samples: number
  /** Peak of the session tree (self + children) above its value at the start. */
  growthMB: number
  /** Most subagents of this session in flight at once while it ran. */
  concurrent: number
  /** Its share: growth split evenly among the subagents that overlapped it. */
  costMB: number
}

/** A session's peaks: what a new session grows to. One per session, rewritten as it grows. */
export type SessionRecord = { kind: 'session'; t: number; sessionId: string; peakSelfMB: number; peakChildMB: number; samples: number }

export type HistoryRecord = AgentRecord | SessionRecord

export const MODEL = {
  quantile: 0.9,
  margin: 0.15,
  halfLifeMs: 3 * 24 * 3600_000,
  /** Effective samples at which the learned value and the prior weigh the same. */
  shrinkK: 5,
  /** Below this many records of a type, that type borrows the pool of every type. */
  minTypeSamples: 3,
  floorMB: 64,
  /** Records older than this are dropped when loading. */
  maxAgeMs: 60 * 24 * 3600_000,
} as const

export type Forecast = {
  mb: number
  /** Records it learned from. */
  n: number
  /** `prior` with no usable records; `type` from this type's own; `pool` from every type's. */
  source: 'prior' | 'type' | 'pool'
  /** The learned value before shrinkage, when there was one. */
  learnedMB?: number
}

const decay = (age: number) => Math.pow(0.5, Math.max(0, age) / MODEL.halfLifeMs)

/** The weighted `q` quantile: the smallest value whose cumulative weight reaches `q` of the total. */
export const weightedQuantile = (points: readonly { v: number; w: number }[], q: number): number => {
  const sorted = [...points].filter(p => p.w > 0).sort((a, b) => a.v - b.v)
  const total = sorted.reduce((s, p) => s + p.w, 0)
  if (total === 0) return NaN
  let acc = 0
  for (const p of sorted) {
    acc += p.w
    if (acc >= q * total - 1e-9) return p.v
  }
  return sorted[sorted.length - 1]!.v
}

/** Quantile plus margin of decayed samples, shrunk toward `priorMB` by how much evidence there is. */
const learn = (values: readonly { v: number; t: number }[], priorMB: number, now: number, q: number = MODEL.quantile) => {
  const points = values.map(x => ({ v: x.v, w: decay(now - x.t) }))
  const nEff = points.reduce((s, p) => s + p.w, 0)
  const learnedMB = weightedQuantile(points, q) * (1 + MODEL.margin)
  const w = nEff / (nEff + MODEL.shrinkK)
  return { mb: Math.max(MODEL.floorMB, Math.round(w * learnedMB + (1 - w) * priorMB)), learnedMB: Math.round(learnedMB) }
}

const usable = (r: HistoryRecord, now: number) => now - r.t <= MODEL.maxAgeMs && (r.kind === 'session' || r.samples > 0)

/** One more subagent of `type`: its own records, or every type's while it has few. */
export const forecastAgent = (records: readonly HistoryRecord[], type: string, priorMB: number, now: number): Forecast => {
  const agents = records.filter((r): r is AgentRecord => r.kind === 'agent' && usable(r, now))
  const own = agents.filter(r => r.type === type)
  const [pick, source] = own.length >= MODEL.minTypeSamples ? [own, 'type' as const] : [agents, 'pool' as const]
  if (pick.length === 0) return { mb: priorMB, n: 0, source: 'prior' }
  const { mb, learnedMB } = learn(
    pick.map(r => ({ v: r.costMB, t: r.t })),
    priorMB,
    now,
  )
  return { mb, n: pick.length, source, learnedMB }
}

/**
 * One more session: the p90 of a session's own peak plus the median of its
 * children's peak (the MCP servers every session starts, not the odd dev server).
 */
export const forecastSession = (records: readonly HistoryRecord[], priorMB: number, now: number): Forecast => {
  const sessions = records.filter((r): r is SessionRecord => r.kind === 'session' && usable(r, now) && r.samples > 0)
  if (sessions.length === 0) return { mb: priorMB, n: 0, source: 'prior' }
  const self = learn(
    sessions.map(r => ({ v: r.peakSelfMB, t: r.t })),
    priorMB * 0.6,
    now,
  )
  const child = learn(
    sessions.map(r => ({ v: r.peakChildMB, t: r.t })),
    priorMB * 0.4,
    now,
    0.5,
  )
  return { mb: self.mb + child.mb, n: sessions.length, source: 'type', learnedMB: self.learnedMB + child.learnedMB }
}

/** Reads a JSONL history file; a line that doesn't parse as a record is skipped. */
export const parseHistory = (text: string): HistoryRecord[] => {
  const out: HistoryRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Partial<HistoryRecord>
      const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
      if (r.kind === 'agent' && num(r.t) && typeof r.type === 'string' && num(r.costMB) && num(r.samples)) out.push(r as AgentRecord)
      else if (r.kind === 'session' && num(r.t) && num(r.peakSelfMB) && num(r.peakChildMB)) out.push(r as SessionRecord)
    } catch {
      // a torn line from a crash mid-write
    }
  }
  return out
}
