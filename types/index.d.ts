/** The gate view's HOLD reasons (the badge and the pane show them); null while cleared. */
export type ClearanceBand = { state: 'HOLD'; headroomMB: number; reasons: string[] }

/** The band's badge, always up: the marshaller's mood and the line beside it. */
export type ClearanceBadge = {
  mood: 'CLEARED' | 'HOLD' | 'WAITING'
  /** Rounded to 0.1 GB; null while WAITING. */
  headroomMB: number | null
  /** More sessions that fit now. */
  fits: number
  sessions: number
  agents: number
  /** Why it holds; empty unless HOLD. */
  reasons: string[]
  /** Why there are no numbers while WAITING; empty otherwise. */
  note: string
}

/** One session row of the /clearance pane. */
export type ClearancePaneSession = {
  id: string
  /** The session's folder, last two segments. */
  where: string
  selfMB: number
  childMB: number
  children: number
  /** Subagents in flight; null for a session without the mod. */
  agents: number | null
  /** Seconds since the session last made progress; null without the mod. */
  progressAgoS: number | null
  /** Its largest child process, `name size`. */
  top: string
  isSelf: boolean
}

/** What the /clearance pane draws, rebuilt every sample. */
export type ClearancePane = {
  t: number
  epoch: number
  isScribe: boolean
  state: 'CLEARED' | 'HOLD'
  headroomMB: number
  fits: number
  reasons: string[]
  machine: { totalMB: number; availableMB: number; commitMB: number; commitLimitMB: number }
  limits: { minFreeGB: number; maxCommitPct: number; maxSessions: number; maxAgents: number }
  agents: number
  reservedMB: number
  sessions: ClearancePaneSession[]
}

declare module 'claude-code' {
  interface PluginState {
    clearance: {
      badge: ClearanceBadge | null
      pane: ClearancePane | null
      /** The session-start check ran (once per session, not again on a hot reload). */
      startChecked: boolean
      /** The person chose to wait at the session-start dialog: toast once the machine clears. */
      waitingForClearance: boolean
    }
  }
}
