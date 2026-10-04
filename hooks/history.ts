import { MODEL, parseHistory, type AgentRecord, type HistoryRecord, type SessionRecord } from './forecast.ts'
import type { Io } from './io.ts'
import type { Paths } from './paths.ts'

// Step 5: history. Each session writes its own file,
// history/<yyyy-mm>/<sessionId>.jsonl (one writer per file, as everywhere under
// ~/.claude/clearance), and reads every session's to learn the forecasts.

/** What the tracker reads from this session's snapshot row each sample. */
export type Tree = { selfMB: number; childMB: number }

type Open = { type: string; t0: number; base: number; peak: number; samples: number; concurrent: number }

/**
 * Follows this session's subagents through the samples: a subagent's growth is
 * the tree's peak while it ran above the tree when it started. Pure but stateful.
 */
export const startTracker = () => {
  const open = new Map<string, Open>()
  let last: { t: number; tree: Tree } | undefined
  let peakSelf = 0
  let peakChild = 0
  let sessionSamples = 0
  const size = (tree: Tree) => tree.selfMB + tree.childMB

  return {
    /** One snapshot of this session's row; a repeat of the same sample is ignored. */
    sample(tree: Tree, t: number) {
      if (last && last.t === t) return
      last = { t, tree }
      sessionSamples++
      peakSelf = Math.max(peakSelf, tree.selfMB)
      peakChild = Math.max(peakChild, tree.childMB)
      for (const a of open.values()) {
        a.peak = Math.max(a.peak, size(tree))
        a.samples++
        a.concurrent = Math.max(a.concurrent, open.size)
      }
    },
    started(agentId: string, type: string, now: number) {
      const base = last ? size(last.tree) : NaN
      open.set(agentId, { type, t0: now, base, peak: base, samples: 0, concurrent: open.size + 1 })
      for (const a of open.values()) a.concurrent = Math.max(a.concurrent, open.size)
    },
    /** The finished subagent's record; undefined for one this tracker never saw start. */
    stopped(agentId: string, now: number): AgentRecord | undefined {
      const a = open.get(agentId)
      if (!a) return undefined
      open.delete(agentId)
      const measured = Number.isFinite(a.base) ? a.samples : 0
      const growthMB = measured > 0 ? Math.max(0, a.peak - a.base) : 0
      return {
        kind: 'agent',
        t: now,
        type: a.type,
        durationMs: now - a.t0,
        samples: measured,
        growthMB,
        concurrent: a.concurrent,
        costMB: Math.round(growthMB / Math.max(1, a.concurrent)),
      }
    },
    session(sessionId: string, now: number): SessionRecord | undefined {
      if (sessionSamples === 0) return undefined
      return { kind: 'session', t: now, sessionId, peakSelfMB: peakSelf, peakChildMB: peakChild, samples: sessionSamples }
    },
    inFlight: () => open.size,
  }
}

export type Tracker = ReturnType<typeof startTracker>

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7)

export const historyFile = (paths: Paths, sessionId: string, startedAt: number) => `${paths.history}\\${month(startedAt)}\\${sessionId}.jsonl`

/** This session's records (agents, then its one session record) as the file's text. */
export const historyText = (agents: readonly AgentRecord[], session: SessionRecord | undefined) =>
  [...agents, ...(session ? [session] : [])].map(r => JSON.stringify(r)).join('\n') + '\n'

/**
 * The store: loads every session's history (the last two months), and rewrites
 * this session's file when it records. A hot reload reads its own file back,
 * so nothing it recorded is lost.
 */
export const startHistory = async (io: Io, paths: Paths, sessionId: string, startedAt: number) => {
  const own = historyFile(paths, sessionId, startedAt)
  let others: HistoryRecord[] = []
  let agents: AgentRecord[] = []
  let session: SessionRecord | undefined
  /** The session record as loaded: what an earlier load of this module had seen. */
  let loaded: SessionRecord | undefined

  const load = async () => {
    const now = await io.now()
    const all: HistoryRecord[] = []
    let ownRecords: HistoryRecord[] = []
    let months: string[] = []
    try {
      months = (await io.list(paths.history))
        .filter(d => d.kind === 'dir' && /^\d{4}-\d{2}$/.test(d.name))
        .map(d => d.name)
        .sort()
        .slice(-2)
    } catch {
      // no history yet
    }
    for (const m of months) {
      const dir = `${paths.history}\\${m}`
      let files: { name: string; kind: string }[] = []
      try {
        files = await io.list(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.name.endsWith('.jsonl')) continue
        const path = `${dir}\\${f.name}`
        try {
          const records = parseHistory(await io.read(path)).filter(r => now - r.t <= MODEL.maxAgeMs)
          if (path === own) ownRecords = records
          else all.push(...records)
        } catch {
          // gone between list and read
        }
      }
    }
    others = all
    agents = ownRecords.filter((r): r is AgentRecord => r.kind === 'agent')
    session = ownRecords.find((r): r is SessionRecord => r.kind === 'session')
    loaded = session
  }

  const write = async () => {
    try {
      await io.write(own, historyText(agents, session))
    } catch (e) {
      io.log(`history write: ${String(e)}`)
    }
  }

  await load()
  return {
    reload: load,
    records: (): HistoryRecord[] => [...others, ...agents, ...(session ? [session] : [])],
    addAgent: async (r: AgentRecord) => {
      agents.push(r)
      await write()
    },
    /** The session's peaks only grow; written when they do. */
    setSession: async (r: SessionRecord) => {
      const grew = !session || r.peakSelfMB > session.peakSelfMB || r.peakChildMB > session.peakChildMB
      session = loaded
        ? { ...r, peakSelfMB: Math.max(r.peakSelfMB, loaded.peakSelfMB), peakChildMB: Math.max(r.peakChildMB, loaded.peakChildMB), samples: loaded.samples + r.samples }
        : r
      if (grew) await write()
    },
  }
}

export type History = Awaited<ReturnType<typeof startHistory>>
