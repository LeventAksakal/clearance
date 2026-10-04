import { needed, POLICY } from './forecast.ts'

// Step 7: the floor learned from paging pressure, and THRASH. Pure: no `$` here.
//
// The sampler reads hard page reads per second (\Memory\Pages Input/sec) with
// every sample. The scribe folds each sample into a histogram: available memory
// in bins of 1% of RAM, paging in power-of-two buckets. From it:
//
// - calm: the paging seen while available memory is at or above its median;
//   its p90 is this machine's ordinary paging, file reads and launches included;
// - pressured bin: a bin below the median whose median paging is above the calm
//   p90, that is, a typical sample there pages more than 90% of calm samples;
// - floor: the top edge of the highest pressured bin with enough samples to
//   judge (`needed()`, the same 22 a forecast bound needs). With no pressured
//   bin yet, the policy floor (5% of RAM) stands, and the basis says so.

/** Paging buckets: 0, then [2^(i-1), 2^i) pages/s, up to 2^19 and above. */
export const BUCKETS = 21

export const bucketOf = (pagesPerSec: number) => (pagesPerSec < 1 ? 0 : Math.min(BUCKETS - 1, 1 + Math.floor(Math.log2(pagesPerSec))))

/** A bucket's upper edge in pages/s: what a quantile landing in it is reported as. */
export const bucketTop = (b: number) => (b === 0 ? 1 : Math.pow(2, b))

export type Pressure = {
  schema: 1
  /** Bin width in MB: 1% of total RAM when the histogram started. */
  binMB: number
  totalMB: number
  /** Per available-memory bin (index = floor(availableMB / binMB)), counts per paging bucket. */
  bins: Record<string, number[]>
  /** Samples folded in. */
  n: number
  /** Last sample time folded in: a sample is folded once. */
  t: number
}

/** Halve every count past this many samples (about 2.9 days at 5 s): old evidence fades and the file stays small. */
export const MAX_SAMPLES = 50_000

export const emptyPressure = (totalMB: number): Pressure => ({ schema: 1, binMB: Math.max(1, Math.round(totalMB / 100)), totalMB, bins: {}, n: 0, t: 0 })

export const parsePressure = (text: string): Pressure | undefined => {
  try {
    const p = JSON.parse(text) as Partial<Pressure>
    if (p.schema !== 1 || typeof p.binMB !== 'number' || typeof p.bins !== 'object' || p.bins === null) return undefined
    return { schema: 1, binMB: p.binMB, totalMB: p.totalMB ?? 0, bins: p.bins as Record<string, number[]>, n: p.n ?? 0, t: p.t ?? 0 }
  } catch {
    return undefined
  }
}

/** One sample folded in (a new object); a repeat of the last sample's time is ignored. */
export const fold = (p: Pressure, availableMB: number, pagesPerSec: number, t: number): Pressure => {
  if (t <= p.t) return p
  const bins: Record<string, number[]> = {}
  const halve = p.n + 1 > MAX_SAMPLES
  for (const [k, counts] of Object.entries(p.bins)) bins[k] = halve ? counts.map(c => c / 2) : [...counts]
  const key = String(Math.floor(availableMB / p.binMB))
  const row = bins[key] ?? Array<number>(BUCKETS).fill(0)
  row[bucketOf(pagesPerSec)]! += 1
  bins[key] = row
  return { ...p, bins, n: (halve ? p.n / 2 : p.n) + 1, t }
}

/** The bucket where cumulative weight reaches `q` of the total, or -1 for no weight. */
const quantileBucket = (counts: readonly number[], q: number) => {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 0) return -1
  let acc = 0
  for (let b = 0; b < counts.length; b++) {
    acc += counts[b]!
    if (acc >= q * total - 1e-9) return b
  }
  return counts.length - 1
}

export type Floor = {
  /** The learned floor in MB, or undefined when no pressure has been seen. */
  mb: number | undefined
  /** Ordinary paging: the calm p90, pages/s (bucket top); undefined without enough calm samples. */
  calmP90: number | undefined
  /** The available level, MB, at and above which paging is calm: the median sample's bin. */
  calmFromMB: number | undefined
  n: number
  basis: string
}

const gb = (mb: number) => (mb / 1024).toFixed(1)

export const learnFloor = (p: Pressure): Floor => {
  const keys = Object.keys(p.bins)
    .map(Number)
    .sort((a, b) => a - b)
  const weight = (k: number) => p.bins[String(k)]!.reduce((a, b) => a + b, 0)
  const total = keys.reduce((s, k) => s + weight(k), 0)
  if (total < needed() * 2) return { mb: undefined, calmP90: undefined, calmFromMB: undefined, n: total, basis: `learning: ${Math.round(total)} samples` }

  // The median sample's bin splits calm (at or above) from the candidates below.
  let acc = 0
  let medianKey = keys[keys.length - 1]!
  for (const k of keys) {
    acc += weight(k)
    if (acc >= total / 2) {
      medianKey = k
      break
    }
  }
  const calm = Array<number>(BUCKETS).fill(0)
  for (const k of keys) if (k >= medianKey) p.bins[String(k)]!.forEach((c, b) => (calm[b]! += c))
  const calmBucket = quantileBucket(calm, POLICY.quantile)
  const calmP90 = bucketTop(calmBucket)
  const calmFromMB = medianKey * p.binMB

  let pressuredTop: number | undefined
  for (const k of keys) {
    if (k >= medianKey || weight(k) < needed()) continue
    if (quantileBucket(p.bins[String(k)]!, 0.5) > calmBucket) pressuredTop = (k + 1) * p.binMB
  }
  if (pressuredTop === undefined)
    return { mb: undefined, calmP90, calmFromMB, n: total, basis: `no pressure seen below ${gb(calmFromMB)} GB (calm paging ≤ ${calmP90}/s)` }
  return {
    mb: pressuredTop,
    calmP90,
    calmFromMB,
    n: total,
    basis: `paging above ${calmP90}/s (calm p90) is typical below ${gb(pressuredTop)} GB`,
  }
}

/** A sample is pressured when it pages above the calm p90. */
export const isPressured = (pagesPerSec: number | undefined, f: Floor) => pagesPerSec !== undefined && f.calmP90 !== undefined && pagesPerSec > f.calmP90

/** Samples in a row a THRASH needs, as hysteresis does for HOLD. */
export const THRASH_RUN = 3
/** No session progressed for this long (design: THRASH's stall). */
export const STALL_MS = 5 * 60_000

/**
 * THRASH: the machine is paging hard below its floor for THRASH_RUN samples in
 * a row, or (the design's rule) available memory is under half the floor while
 * no session has made progress for STALL_MS.
 */
export const isThrash = (args: { pressuredRun: number; availableMB: number; floorMB: number; lastProgressAt: number | undefined; now: number }) =>
  (args.pressuredRun >= THRASH_RUN && args.availableMB < args.floorMB) ||
  (args.availableMB < args.floorMB / 2 && args.lastProgressAt !== undefined && args.now - args.lastProgressAt > STALL_MS)
