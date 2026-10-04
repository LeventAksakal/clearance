import { describe, expect, test } from 'claude-code/testing'
import type { Io } from './io.ts'
import { pathsFor } from './paths.ts'
import { isProgressDue, presenceDoc, startPresence } from './presence.ts'

const fakeIo = () => {
  let now = 100_000
  const writes: { path: string; doc: Record<string, unknown> }[] = []
  const io = {
    now: async () => now,
    sessionId: async () => 'sess-1',
    write: async (path: string, text: string) => void writes.push({ path, doc: JSON.parse(text) }),
    log: () => {},
  } as unknown as Io
  return { io, writes, advance: (ms: number) => (now += ms) }
}

const settleMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('presence', () => {
  test('the document sums its reservations for the sampler', () => {
    const doc = presenceDoc('s', 2, [{ id: 'a', mb: 300, at: 1 }, { id: 'b', mb: 200, at: 2 }], 5, 6)
    expect(doc).toEqual({
      schema: 1,
      sessionId: 's',
      agentsInFlight: 2,
      reservations: [{ id: 'a', mb: 300, at: 1 }, { id: 'b', mb: 200, at: 2 }],
      reservedMB: 500,
      lastProgressAt: 5,
      t: 6,
    })
  })

  test('progress is written at most every 15 s', () => {
    expect(isProgressDue(0, 15_000)).toBe(true)
    expect(isProgressDue(10_000, 24_999)).toBe(false)
  })

  test('writes under the current session id, and throttles progress', async () => {
    const f = fakeIo()
    const p = startPresence(f.io, pathsFor('C:\\Users\\u'))
    await p.flush()
    expect(f.writes[0]?.path).toBe('C:\\Users\\u\\.claude\\clearance\\sessions\\sess-1.json')
    f.advance(5_000)
    p.progress()
    await settleMicrotasks()
    expect(f.writes).toHaveLength(1)
    f.advance(11_000)
    p.progress()
    await settleMicrotasks()
    expect(f.writes).toHaveLength(2)
    expect(f.writes[1]?.doc.lastProgressAt).toBe(116_000)
  })
})
