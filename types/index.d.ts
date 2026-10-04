/** What the AbovePrompt band draws while the machine is on HOLD; null hides it. */
export type ClearanceBand = { state: 'HOLD'; headroomMB: number; reasons: string[] }

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
      band: ClearanceBand | null
      pane: ClearancePane | null
      /** The session-start check ran (once per session, not again on a hot reload). */
      startChecked: boolean
      /** The person chose to wait at the session-start dialog: toast once the machine clears. */
      waitingForClearance: boolean
    }
  }
}
