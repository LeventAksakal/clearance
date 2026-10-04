import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS, advance } from './gate.ts'
import { paneLines, paneModel, shortPath } from './pane.ts'
import type { SessionSample, Snapshot } from './snapshot.ts'

const row = (sessionId: string, over: Partial<SessionSample> = {}): SessionSample => ({
  sessionId,
  pid: 1,
  cwd: `C:\\Code\\${sessionId}`,
  entrypoint: 'claude-desktop',
  selfMB: 600,
  childMB: 200,
  children: 3,
  topChildren: [{ pid: 9, name: 'node.exe', privateMB: 150 }],
  ...over,
})

const snap: Snapshot = {
  schema: 1,
  epoch: 13,
  t: 100_000,
  sampleMs: 80,
  intervalMs: 5_000,
  machine: { totalMB: 16384, availableMB: 4096, commitMB: 30_720, commitLimitMB: 49_152 },
  sessions: [
    row('aaaaaaaa-small', { selfMB: 500, childMB: 0, children: 0, topChildren: [] }),
    row('bbbbbbbb-big', { childMB: 1500, agentsInFlight: 2, lastProgressAt: 40_000 }),
  ],
}

describe('pane model', () => {
  test('sorts sessions by memory and marks this one', () => {
    const m = paneModel(snap, advance(undefined, snap, DEFAULTS), DEFAULTS, 'aaaaaaaa-small', true, 100_000)
    expect(m.sessions.map(s => s.id)).toEqual(['bbbbbbbb', 'aaaaaaaa'])
    expect(m.sessions[0]).toMatchObject({ where: 'Code\\bbbbbbbb-big', agents: 2, progressAgoS: 60, top: 'node.exe 0.1', isSelf: false })
    expect(m.sessions[1]).toMatchObject({ agents: null, progressAgoS: null, top: '', isSelf: true })
    expect(m).toMatchObject({ state: 'CLEARED', headroomMB: 2560, fits: 3, agents: 2, epoch: 13, isScribe: true })
  })

  test('short paths keep the last two segments', () => {
    expect(shortPath('C:\\Users\\leven\\.claude\\worktrees\\lane-a')).toBe('worktrees\\lane-a')
    expect(shortPath('C:\\')).toBe('C:')
  })
})

describe('pane lines', () => {
  test('lead with the state, then the machine, then one row per session', () => {
    const m = paneModel(snap, advance(undefined, snap, DEFAULTS), DEFAULTS, 'aaaaaaaa-small', false, 100_000)
    const lines = paneLines(m, 100, 101_000)
    expect(lines[0]).toEqual({ text: 'CLEARED · headroom 2.5 GB · 3 more sessions', tone: 'ok' })
    expect(lines[1]?.text).toBe('available 4.0 of 16.0 GB (floor 1.5) · commit 30.0/48.0 GB (ceiling 90%)')
    expect(lines[2]?.text).toBe('sessions 2/6 · subagents 2/8 · reserved 0.0 GB · sampled 1 s ago · epoch 13')
    const header = lines[4]?.text ?? ''
    expect(header.startsWith('session  where')).toBe(true)
    expect(lines[5]?.text).toContain('bbbbbbbb ')
    expect(lines[5]?.text).toContain('1.5 (3)')
    expect(lines[5]?.text).toContain('1 min')
    expect(lines[6]?.text.startsWith('aaaaaaaa*')).toBe(true)
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(100)
  })

  test('list the reasons under HOLD', () => {
    const tight = { ...snap, machine: { ...snap.machine, availableMB: 1000 } }
    const m = paneModel(tight, advance(undefined, tight, DEFAULTS), DEFAULTS, 'x', false, 100_000)
    const lines = paneLines(m, 100, 100_000)
    expect(lines[0]).toEqual({ text: 'HOLD · headroom 0.0 GB', tone: 'warn' })
    expect(lines[1]).toEqual({ text: '  available 1.0 GB, floor 1.5 GB + 0.7 GB ask', tone: 'warn' })
  })

  test('wait for the first sample', () => {
    expect(paneLines(null, 80, 0)).toEqual([{ text: 'Waiting for the first machine sample…', tone: 'dim' }])
  })
})

describe('pane drawing', () => {
  test('opens from /clearance and draws on terminal and desktop', async ($, on) => {
    // Beneath the plugin, these answer $ calls as the engine would: { value }.
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('clock.now', () => ({ value: 0 }) as never)
    const ran = await $.command.run({ command: 'clearance', args: '' } as never)
    expect(ran).toMatchObject({ text: 'clearance pane opened.' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'clearance',
        surface,
        component: 'Pane',
        requestId: 'clearance',
        props: { bodyColumns: 100 } as never,
      })
      expect(await ui.find({ type: 'Text', text: 'Waiting for the first machine sample…' })).toBeDefined()
      await ui.unmount()
    }
  })
})
