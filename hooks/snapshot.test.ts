import { describe, expect, test } from 'claude-code/testing'
import { isCurrent, isFresh, parseBeat, parseEpochs, parseSnapshot, statusLine, type Snapshot } from './snapshot.ts'

const snap: Snapshot = {
  schema: 1,
  epoch: 4,
  t: 100_000,
  sampleMs: 560,
  intervalMs: 5_000,
  machine: { totalMB: 15724, availableMB: 2150, commitMB: 33280, commitLimitMB: 48640 },
  sessions: [],
}

describe('parseSnapshot', () => {
  test('reads a schema-1 snapshot', () => {
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap)
  })

  test('drops other schemas, broken JSON and missing machine numbers', () => {
    expect(parseSnapshot(JSON.stringify({ ...snap, schema: 2 }))).toBeUndefined()
    expect(parseSnapshot('{"schema":1')).toBeUndefined()
    expect(parseSnapshot(JSON.stringify({ ...snap, machine: { availableMB: 1 } }))).toBeUndefined()
  })
})

describe('parseBeat', () => {
  test('reads epoch and t from any version of the snapshot', () => {
    expect(parseBeat('{"epoch":3,"t":5,"machine":{"freeMB":1}}')).toEqual({ epoch: 3, t: 5 })
    expect(parseBeat('{"t":5}')).toBeUndefined()
    expect(parseBeat('{')).toBeUndefined()
  })
})

describe('freshness and fencing', () => {
  test('a snapshot is fresh for three intervals', () => {
    expect(isFresh(snap, 115_000)).toBe(true)
    expect(isFresh(snap, 115_001)).toBe(false)
  })

  test('parses the scribe directory, newest epoch first', () => {
    const e = parseEpochs(['epoch-2', 'epoch-10', 'resigned-2', 'epoch-3.tmp', 'notes'])
    expect(e.highest).toBe(10)
    expect(e.claimed).toEqual([10, 2])
    expect([...e.resigned]).toEqual([2])
  })

  test('a reader drops a snapshot from an epoch below the highest claim', () => {
    expect(isCurrent(snap, parseEpochs(['epoch-4']))).toBe(true)
    expect(isCurrent(snap, parseEpochs(['epoch-4', 'epoch-5']))).toBe(false)
    expect(isCurrent(snap, parseEpochs([]))).toBe(true)
  })
})

describe('statusLine', () => {
  test('shows live machine numbers', () => {
    expect(statusLine(snap, 101_000, false)).toBe('clearance · avail 2.1 GB · commit 32.5/47.5 GB · 0 sessions')
    expect(statusLine({ ...snap, sessions: [{} as never] }, 101_000, true)).toBe(
      'clearance · avail 2.1 GB · commit 32.5/47.5 GB · 1 session · scribe',
    )
  })

  test('says when there are no live numbers', () => {
    expect(statusLine(undefined, 0, false)).toBe('clearance · waiting for a snapshot')
    expect(statusLine(snap, 130_000, false)).toBe('clearance · snapshot 30 s old')
  })
})
