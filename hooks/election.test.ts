import { describe, expect, test } from 'claude-code/testing'
import { decide, isSelf, parseHolder, type Holder, type Self, type View } from './scribe.ts'

const me: Self = { sessionId: 'me', pid: 100, procStart: 'p100' }
const other: Holder = { sessionId: 'other', pid: 200, procStart: 'p200', at: 1_000 }
const mine: Holder = { sessionId: 'me', pid: 100, procStart: 'p100', at: 1_000 }

const view = (over: Partial<View>): View => ({
  me,
  now: 10_000,
  intervalMs: 5_000,
  highest: 3,
  holder: other,
  epochMtime: 1_000,
  isResigned: false,
  isHolderAlive: true,
  snapshotT: 9_000,
  running: undefined,
  ...over,
})

describe('decide', () => {
  test('claims epoch 1 when nobody ever claimed', () => {
    expect(decide(view({ highest: undefined, holder: undefined }))).toMatchObject({ kind: 'claim', epoch: 1 })
  })

  test('stays idle while a live holder keeps the snapshot fresh', () => {
    expect(decide(view({}))).toEqual({ kind: 'idle' })
  })

  test('claims the next epoch when the holder has left the registry', () => {
    expect(decide(view({ isHolderAlive: false }))).toMatchObject({ kind: 'claim', epoch: 4 })
  })

  test('claims the next epoch when the holder resigned', () => {
    expect(decide(view({ isResigned: true }))).toMatchObject({ kind: 'claim', epoch: 4 })
  })

  test('claims the next epoch when the snapshot is older than three intervals', () => {
    expect(decide(view({ now: 30_000, snapshotT: 14_000 }))).toMatchObject({ kind: 'claim', epoch: 4 })
    expect(decide(view({ now: 29_000, snapshotT: 14_000 }))).toEqual({ kind: 'idle' })
  })

  test('gives a fresh holder 30 s for its cold first snapshot', () => {
    expect(decide(view({ snapshotT: undefined, now: 20_000 }))).toEqual({ kind: 'idle' })
    expect(decide(view({ snapshotT: undefined, now: 32_000 }))).toEqual({
      kind: 'claim',
      epoch: 4,
      reason: 'no snapshot 31 s after the claim',
    })
  })

  test('says why it claims', () => {
    expect(decide(view({ isHolderAlive: false }))).toMatchObject({ reason: 'holder pid 200 left the registry' })
    expect(decide(view({ now: 30_000, snapshotT: 14_000 }))).toMatchObject({ reason: 'snapshot 16 s old' })
  })

  test('waits while the winner is still writing its epoch file', () => {
    expect(decide(view({ holder: undefined, epochMtime: 9_000 }))).toEqual({ kind: 'idle' })
    expect(decide(view({ holder: undefined, epochMtime: 1_000, now: 20_000 }))).toMatchObject({ kind: 'claim', epoch: 4 })
  })

  test('starts the sampler for its own epoch, as after a hot reload', () => {
    expect(decide(view({ holder: mine }))).toEqual({ kind: 'start', epoch: 3 })
    expect(decide(view({ holder: mine, running: 3 }))).toEqual({ kind: 'idle' })
  })

  test('stops a deposed sampler', () => {
    expect(decide(view({ running: 2 }))).toEqual({ kind: 'stop' })
    expect(decide(view({ holder: mine, isResigned: true, running: 3 }))).toEqual({ kind: 'stop' })
  })
})

describe('holder identity', () => {
  test('matches by pid and procStart, so it survives a /clear', () => {
    expect(isSelf(mine, { ...me, sessionId: 'after-clear' })).toBe(true)
  })

  test('does not take a reused pid for the holder', () => {
    expect(isSelf({ ...mine, procStart: 'older' }, me)).toBe(false)
  })

  test('falls back to the session id when either side has no pid', () => {
    expect(isSelf({ ...mine, pid: 0 }, me)).toBe(true)
    expect(isSelf({ ...other, pid: 0 }, me)).toBe(false)
  })

  test('parses what claim.ps1 writes, and nothing else', () => {
    expect(parseHolder('{"sessionId":"s","pid":7,"procStart":"x","at":5}')).toEqual({ sessionId: 's', pid: 7, procStart: 'x', at: 5 })
    expect(parseHolder('')).toBeUndefined()
    expect(parseHolder('{"pid":7}')).toBeUndefined()
  })
})
