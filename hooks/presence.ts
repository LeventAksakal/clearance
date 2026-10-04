import type { Io } from './io.ts'
import type { Paths } from './paths.ts'

// This session's presence file, `sessions/<sessionId>.json` (design.md §
// Shared state): its subagents in flight, its memory reservations and when it
// last made progress. Only this session writes it; the sampler joins it onto
// the session's snapshot row.
//
// `busy` is whether the session is working: a turn in flight, or a subagent
// still running after it. A session waiting for its person is idle, not
// stalled, so THRASH's stall rule reads only busy sessions.

/** Progress (any tool result) is written at most this often. */
export const PROGRESS_EVERY_MS = 15_000

/**
 * How long a reservation stands. It covers a cleared subagent until the
 * memory it brings shows in samples; by then the sample counts it instead.
 */
export const RESERVATION_TTL_MS = 30_000

/** Memory set aside for something admitted but not yet visible in a sample (a subagent just cleared). */
export type Reservation = { id: string; mb: number; at: number }

export type PresenceDoc = {
  schema: 1
  sessionId: string
  agentsInFlight: number
  reservations: Reservation[]
  /** The sum of `reservations`, so the sampler needn't add them. */
  reservedMB: number
  /** A turn is in flight or a subagent is still running. */
  busy: boolean
  lastProgressAt: number
  t: number
}

export const presenceDoc = (sessionId: string, agentsInFlight: number, reservations: Reservation[], busy: boolean, lastProgressAt: number, t: number): PresenceDoc => ({
  schema: 1,
  sessionId,
  agentsInFlight,
  reservations,
  reservedMB: reservations.reduce((sum, r) => sum + r.mb, 0),
  busy,
  lastProgressAt,
  t,
})

/** Whether a progress bump at `now` is worth a write. */
export const isProgressDue = (lastWrittenAt: number, now: number) => now - lastWrittenAt >= PROGRESS_EVERY_MS

export const liveReservations = (all: readonly Reservation[], now: number) => all.filter(r => now - r.at < RESERVATION_TTL_MS)

export const presenceFile = (paths: Paths, sessionId: string) => `${paths.presence}\\${sessionId}.json`

export type Presence = {
  /** A tool result came back: bump `lastProgressAt`, written at most every PROGRESS_EVERY_MS. */
  progress: () => void
  /** A main-loop turn started (`true`: it counts as progress too) or ended; written now. */
  turn: (inFlight: boolean) => Promise<void>
  /** Writes the file now, under the current session id (a /clear changes it). */
  flush: () => Promise<void>
  /** This session's live reservations made after the sample taken at `t` (the sample can't count them yet). */
  reservedSince: (t: number, now: number) => number
  /** Sets memory aside for a cleared spawn, before the spawn runs, and writes it. */
  reserve: (id: string, mb: number) => Promise<void>
  /** The spawn started as `agentId` (its reservation is renamed), or never started (`undefined`: the reservation goes). */
  started: (reservationId: string, agentId: string | undefined) => Promise<void>
  /** The subagent stopped: it is no longer in flight (its reservation runs out on its own). */
  stopped: (agentId: string) => Promise<void>
  agentsInFlight: () => number
}

export const startPresence = (io: Io, paths: Paths): Presence => {
  const agents = new Set<string>()
  let reservations: Reservation[] = []
  let lastProgressAt = 0
  let turnInFlight = false
  let lastWrittenAt = 0
  let writing: Promise<void> | undefined

  const flush = async () => {
    const now = await io.now()
    const sessionId = await io.sessionId()
    lastWrittenAt = now
    reservations = liveReservations(reservations, now)
    const doc = presenceDoc(sessionId, agents.size, reservations, turnInFlight || agents.size > 0, lastProgressAt || now, now)
    try {
      await io.write(presenceFile(paths, sessionId), JSON.stringify(doc))
    } catch (e) {
      io.log(`presence write: ${String(e)}`)
    }
  }

  const progress = () => {
    void (async () => {
      const now = await io.now()
      lastProgressAt = now
      if (writing || !isProgressDue(lastWrittenAt, now)) return
      writing = flush().finally(() => (writing = undefined))
    })()
  }

  return {
    progress,
    turn: async inFlight => {
      turnInFlight = inFlight
      if (inFlight) lastProgressAt = await io.now()
      await flush()
    },
    flush,
    reservedSince: (t, now) => liveReservations(reservations, now).filter(r => r.at > t).reduce((sum, r) => sum + r.mb, 0),
    reserve: async (id, mb) => {
      reservations.push({ id, mb, at: await io.now() })
      await flush()
    },
    started: async (reservationId, agentId) => {
      if (agentId === undefined) {
        reservations = reservations.filter(r => r.id !== reservationId)
      } else {
        agents.add(agentId)
        for (const r of reservations) if (r.id === reservationId) r.id = agentId
      }
      await flush()
    },
    stopped: async agentId => {
      if (agents.delete(agentId)) await flush()
    },
    agentsInFlight: () => agents.size,
  }
}
