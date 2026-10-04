// Step 5: forecasts from what this machine was seen to use (design.md § Step 5).
// Pure: no `$` here.
//
// No assumed sizes. A forecast is an upper confidence bound on a high quantile
// of observed costs, distribution-free (order statistics), so it needs no model
// of the distribution and no safety margin: fewer observations give a looser,
// higher bound by construction. With too few for a bound, the largest observed;
// with none, a stand-in the caller observed (never a constant).
//
// The two numbers below are policy, not sizes: how high a quantile to cover and
// how sure to be of covering it.

/** A finished subagent: how much its session's process tree grew while it ran. */
/**
 * Record version: 2 from the sampler that checks process start times. Records
 * without it were measured when a reused pid could adopt an orphaned tree (one
 * session read 8.4 GB of children), so they are not used.
 */
export const RECORD_VERSION = 2

export type AgentRecord = {
  kind: 'agent'
  v: typeof RECORD_VERSION
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

/** A session's peaks: what a session grows to. One per session, rewritten as it grows. */
export type SessionRecord = { kind: 'session'; v: typeof RECORD_VERSION; t: number; sessionId: string; peakSelfMB: number; peakChildMB: number; samples: number }

export type HistoryRecord = AgentRecord | SessionRecord

export const POLICY = {
  /** Cover this share of runs... */
  quantile: 0.9,
  /** ...with this confidence. */
  confidence: 0.9,
  /** Records older than this are dropped when loading: a machine and its tools change. */
  maxAgeMs: 60 * 24 * 3600_000,
} as const

export type Forecast = {
  mb: number
  /** Observations it rests on. */
  n: number
  /**
   * `bound`: the quantile's upper confidence bound; `max`: too few for a bound,
   * the largest seen; `standIn`: nothing recorded, the caller's observed stand-in.
   */
  method: 'bound' | 'max' | 'standIn'
  /** For subagents: whether the records are this type's own or every type's. */
  scope?: 'type' | 'pool'
}

/** P(X ≤ k) for X ~ Binomial(n, p). */
const binomCdf = (k: number, n: number, p: number) => {
  let term = Math.pow(1 - p, n)
  let sum = term
  for (let i = 1; i <= k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p))
    sum += term
  }
  return sum
}

/**
 * The distribution-free upper confidence bound on the `q` quantile: the
 * smallest order statistic X(k) with P(X(k) ≥ x_q) ≥ `c`, that is
 * P(Binomial(n, q) ≤ k − 1) ≥ c. Undefined when n is too small for any k
 * (n < ln(1 − c) / ln(q), 22 at 0.9 / 0.9).
 */
export const quantileUpperBound = (values: readonly number[], q: number = POLICY.quantile, c: number = POLICY.confidence): number | undefined => {
  const x = [...values].sort((a, b) => a - b)
  for (let k = 1; k <= x.length; k++) if (binomCdf(k - 1, x.length, q) >= c) return x[k - 1]
  return undefined
}

/** How many observations a bound needs under the policy. */
export const needed = (q: number = POLICY.quantile, c: number = POLICY.confidence) => Math.ceil(Math.log(1 - c) / Math.log(q))

const usable = (r: HistoryRecord, now: number) => now - r.t <= POLICY.maxAgeMs && r.samples > 0

const estimate = (values: readonly number[], standInMB: number): Omit<Forecast, 'scope'> => {
  const bound = quantileUpperBound(values)
  if (bound !== undefined) return { mb: Math.max(1, Math.round(bound)), n: values.length, method: 'bound' }
  if (values.length > 0) return { mb: Math.max(1, Math.round(Math.max(...values))), n: values.length, method: 'max' }
  return { mb: Math.max(1, Math.round(standInMB)), n: 0, method: 'standIn' }
}

/**
 * One more subagent of `type`: its own runs once they support a bound, else
 * every type's runs. `standInMB` is used only before any run was measured.
 */
export const forecastAgent = (records: readonly HistoryRecord[], type: string, standInMB: number, now: number): Forecast => {
  const agents = records.filter((r): r is AgentRecord => r.kind === 'agent' && usable(r, now))
  const own = agents.filter(r => r.type === type).map(r => r.costMB)
  if (quantileUpperBound(own) !== undefined) return { ...estimate(own, standInMB), scope: 'type' }
  return { ...estimate(agents.map(r => r.costMB), standInMB), scope: 'pool' }
}

/**
 * One more session: recorded session peaks (self + children) and every live
 * session's size now, which is a lower bound of its own peak and is observed
 * from the first sample.
 */
export const forecastSession = (records: readonly HistoryRecord[], liveMB: readonly number[], now: number): Forecast => {
  const recorded = records.filter((r): r is SessionRecord => r.kind === 'session' && usable(r, now)).map(r => r.peakSelfMB + r.peakChildMB)
  const values = [...recorded, ...liveMB]
  return estimate(values, values.length ? Math.max(...values) : 0)
}

/** Reads a JSONL history file; a line that doesn't parse as a record is skipped. */
export const parseHistory = (text: string): HistoryRecord[] => {
  const out: HistoryRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Partial<HistoryRecord>
      const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
      if (r.v !== RECORD_VERSION) continue
      if (r.kind === 'agent' && num(r.t) && typeof r.type === 'string' && num(r.costMB) && num(r.samples)) out.push(r as AgentRecord)
      else if (r.kind === 'session' && num(r.t) && num(r.peakSelfMB) && num(r.peakChildMB) && num(r.samples)) out.push(r as SessionRecord)
    } catch {
      // a torn line from a crash mid-write
    }
  }
  return out
}

/** Says what a forecast rests on, for the headroom tool and the hover card. */
export const describe = (f: Forecast) =>
  f.method === 'bound'
    ? `p${POLICY.quantile * 100} bound at ${POLICY.confidence * 100}% confidence over ${f.n} ${f.scope === 'type' ? 'runs of this type' : 'runs'}`
    : f.method === 'max'
      ? `largest of ${f.n} observed (a bound needs ${needed()})`
      : 'nothing measured yet: the largest growth step seen in a live session'
