/** What the AbovePrompt band draws while the machine is on HOLD; null hides it. */
export type ClearanceBand = { state: 'HOLD'; headroomMB: number; reasons: string[] }

declare module 'claude-code' {
  interface PluginState {
    clearance: { band: ClearanceBand | null }
  }
}
