/** What the AbovePrompt band draws while the machine is on HOLD; null hides it. */
export type ClearanceBand = { state: 'HOLD'; headroomMB: number; reasons: string[] }

declare module 'claude-code' {
  interface PluginState {
    clearance: {
      band: ClearanceBand | null
      /** The session-start check ran (once per session, not again on a hot reload). */
      startChecked: boolean
      /** The person chose to wait at the session-start dialog: toast once the machine clears. */
      waitingForClearance: boolean
    }
  }
}
