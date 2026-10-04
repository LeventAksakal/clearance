import type { Io } from './io.ts'
import { epochFile, registryFile, resignedFile, type Paths } from './paths.ts'
import { STALE_INTERVALS, isCurrent, parseBeat, parseEpochs, parseSnapshot, type Snapshot } from './snapshot.ts'

// Scribe election (0006, design.md § Scribe election). One session per machine
// runs the sampler. Every session runs the watchdog: when the holder of the
// highest epoch is dead it claims the next epoch with CreateNew, and the one
// winner starts the sampler. The sampler fences itself on every write.

export const INTERVAL_MS = 5000

/** Who claimed an epoch: the content of `scribe/epoch-<n>`. */
export type Holder = {
  sessionId: string
  /** The claude process; 0 when the session is not in the registry. */
  pid: number
  /** The registry's `procStart` for that pid, so a reused pid is not taken for the holder. */
  procStart: string
  at: number
}

/** Who this session is. The pid and procStart survive a /clear; the session id does not. */
export type Self = { sessionId: string; pid: number; procStart: string }

export const parseHolder = (text: string): Holder | undefined => {
  try {
    const h = JSON.parse(text) as Partial<Holder>
    if (typeof h.sessionId !== 'string' || typeof h.at !== 'number') return undefined
    return { sessionId: h.sessionId, pid: typeof h.pid === 'number' ? h.pid : 0, procStart: String(h.procStart ?? ''), at: h.at }
  } catch {
    return undefined
  }
}

export const isSelf = (h: Holder, me: Self) =>
  h.pid !== 0 && me.pid !== 0 ? h.pid === me.pid && h.procStart === me.procStart : h.sessionId === me.sessionId

/** What the watchdog saw on one tick. */
export type View = {
  me: Self
  now: number
  intervalMs: number
  highest: number | undefined
  /** The holder of `highest`; undefined while the winner is still writing it, or when it is unreadable. */
  holder: Holder | undefined
  /** Last modification of `epoch-<highest>`, for the grace while it is being written. */
  epochMtime: number | undefined
  isResigned: boolean
  /** The holder's registry entry exists with the same procStart. True when the holder has no pid. */
  isHolderAlive: boolean
  /** `t` of the snapshot, counted only when it was written under `highest`. */
  snapshotT: number | undefined
  /** The epoch this session's sampler runs under, if it runs. */
  running: number | undefined
}

export type Action =
  | { kind: 'idle' }
  | { kind: 'start'; epoch: number }
  | { kind: 'stop' }
  | { kind: 'claim'; epoch: number; reason: string }

const idle: Action = { kind: 'idle' }

/**
 * How long a new holder has for its first snapshot. A cold sampler pays the pwsh
 * start, the first perf-counter query (5.6 s measured) and the process query.
 */
export const FIRST_SAMPLE_GRACE_MS = 30_000

/** The watchdog's decision. Pure, so the election is tested without processes. */
export const decide = (v: View): Action => {
  const stale = STALE_INTERVALS * v.intervalMs
  if (v.highest === undefined) return v.running === undefined ? { kind: 'claim', epoch: 1, reason: 'no epoch claimed' } : { kind: 'stop' }
  const mine = v.holder !== undefined && isSelf(v.holder, v.me) && !v.isResigned
  if (mine) return v.running === v.highest ? idle : { kind: 'start', epoch: v.highest }
  // Deposed, or resigned: the sampler fences itself too, but stop it here as well.
  if (v.running !== undefined) return { kind: 'stop' }
  const claim = (reason: string): Action => ({ kind: 'claim', epoch: v.highest! + 1, reason })
  if (v.isResigned) return claim('holder resigned')
  if (!v.holder) return v.epochMtime !== undefined && v.now - v.epochMtime > stale ? claim('epoch file unreadable') : idle
  if (!v.isHolderAlive) return claim(`holder pid ${v.holder.pid} left the registry`)
  if (v.snapshotT === undefined)
    return v.now - v.holder.at > FIRST_SAMPLE_GRACE_MS ? claim(`no snapshot ${Math.round((v.now - v.holder.at) / 1000)} s after the claim`) : idle
  const lastSign = Math.max(v.snapshotT, v.holder.at)
  return v.now - lastSign > stale ? claim(`snapshot ${Math.round((v.now - lastSign) / 1000)} s old`) : idle
}

type Registry = { pid: number; sessionId: string; procStart: string }

const readRegistry = async (io: Io, path: string): Promise<Registry | undefined> => {
  try {
    const r = JSON.parse(await io.read(path)) as Partial<Registry>
    if (typeof r.pid !== 'number' || typeof r.sessionId !== 'string') return undefined
    return { pid: r.pid, sessionId: r.sessionId, procStart: String(r.procStart ?? '') }
  } catch {
    return undefined
  }
}

/** This session's registry entry, matched by session id (S1). Only `*.json` is read; never the `*.key` files. */
export const findSelf = async (io: Io, paths: Paths, sessionId: string): Promise<Self> => {
  try {
    for (const entry of await io.list(paths.registry)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const r = await readRegistry(io, `${paths.registry}\\${entry.name}`)
      if (r?.sessionId === sessionId) return { sessionId, pid: r.pid, procStart: r.procStart }
    }
  } catch {
    // no registry: fall back to the session id alone
  }
  return { sessionId, pid: 0, procStart: '' }
}

export type Scribe = {
  /** Writes `resigned-<n>` when this session holds the current epoch, so the next claim needn't wait out the stale timeout. */
  resign: () => Promise<void>
  stop: () => void
}

export type ScribeOptions = {
  paths: Paths
  scripts: string
  onTick: (snapshot: Snapshot | undefined, isScribe: boolean, now: number) => void
}

const pwsh = (script: string, ...args: string[]) => ['pwsh', '-NoProfile', '-NonInteractive', '-File', script, ...args]

export const startScribe = (io: Io, opts: ScribeOptions): Scribe => {
  const { paths, scripts } = opts
  let me: Self = { sessionId: '', pid: 0, procStart: '' }
  let sampler: { epoch: number; stream: AsyncGenerator<unknown, unknown> } | undefined
  let held: number | undefined
  let busy = false
  let lastSnapshot: Snapshot | undefined

  const log = io.log

  const stopSampler = () => {
    const s = sampler
    sampler = undefined
    if (s) void s.stream.return(undefined).catch(() => {})
  }

  const startSampler = (epoch: number) => {
    stopSampler()
    const stream = io.spawn(
      pwsh(`${scripts}\\sampler.ps1`, '-Root', paths.root, '-Registry', paths.registry, '-Epoch', String(epoch), '-IntervalMs', String(INTERVAL_MS), '-OwnerPid', String(me.pid)),
    )
    const mine = { epoch, stream }
    sampler = mine
    log(`sampler started under epoch ${epoch}`)
    void (async () => {
      let err = ''
      try {
        for await (const chunk of stream) {
          if (chunk.stream === 'stderr') {
            err = (err + chunk.text).slice(-600)
            log(`sampler stderr: ${chunk.text.trim()}`)
          }
        }
      } catch (e) {
        err = String(e)
      }
      if (sampler === mine) sampler = undefined
      log(`sampler under epoch ${epoch} ended${err ? `: ${err.trim()}` : ''}`)
    })()
  }

  const claim = async (epoch: number): Promise<boolean> => {
    const ran = await io.run(
      pwsh(`${scripts}\\claim.ps1`, '-Dir', paths.scribe, '-Epoch', String(epoch), '-SessionId', me.sessionId, '-OwnerPid', String(me.pid), '-ProcStart', me.procStart || '-'),
      20000,
    )
    const out = ran.stdout.trim()
    if (out !== 'won' && out !== 'lost') log(`claim ${epoch}: exit ${ran.exitCode}, ${ran.stderr.trim().slice(0, 300)}`)
    return out === 'won'
  }

  const look = async (now: number): Promise<View> => {
    let names: string[] = []
    try {
      names = (await io.list(paths.scribe)).map(e => e.name)
    } catch {
      // not created yet: the first claim creates it
    }
    const epochs = parseEpochs(names)
    let holder: Holder | undefined
    let epochMtime: number | undefined
    let isHolderAlive = true
    if (epochs.highest !== undefined) {
      const file = epochFile(paths, epochs.highest)
      try {
        epochMtime = await io.mtime(file)
        holder = parseHolder(await io.read(file))
      } catch {
        // being written by the winner, or just cleaned up
      }
      if (holder && holder.pid !== 0) {
        const r = await readRegistry(io, registryFile(paths, holder.pid))
        isHolderAlive = r !== undefined && (holder.procStart === '' || r.procStart === holder.procStart)
      }
    }
    let text: string | undefined
    try {
      text = await io.read(paths.snapshot)
    } catch {
      // none yet, or mid-rename
    }
    // Liveness reads only epoch and t, so sessions running different versions of
    // this mod never take each other's snapshots for silence.
    const beat = text === undefined ? undefined : parseBeat(text)
    const snapshot = text === undefined ? undefined : parseSnapshot(text)
    lastSnapshot = snapshot && isCurrent(snapshot, epochs) ? snapshot : undefined
    return {
      me,
      now,
      intervalMs: INTERVAL_MS,
      highest: epochs.highest,
      holder,
      epochMtime,
      isResigned: epochs.highest !== undefined && epochs.resigned.has(epochs.highest),
      isHolderAlive,
      snapshotT: beat && beat.epoch === epochs.highest ? beat.t : undefined,
      running: sampler?.epoch,
    }
  }

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const sessionId = await io.sessionId()
      if (sessionId !== me.sessionId || me.pid === 0) me = await findSelf(io, paths, sessionId)
      const now = await io.now()
      const view = await look(now)
      const action = decide(view)
      switch (action.kind) {
        case 'start':
          startSampler(action.epoch)
          break
        case 'stop':
          log(`stopping sampler under epoch ${sampler?.epoch}: no longer the holder`)
          stopSampler()
          break
        case 'claim':
          log(`claiming epoch ${action.epoch}: ${action.reason}`)
          if (await claim(action.epoch)) {
            log(`won epoch ${action.epoch}`)
            startSampler(action.epoch)
          }
          break
      }
      held = sampler?.epoch
      opts.onTick(lastSnapshot, held !== undefined, await io.now())
    } catch (e) {
      log(`watchdog: ${String(e)}`)
    } finally {
      busy = false
    }
  }

  log(`watchdog started, every ${INTERVAL_MS} ms`)
  void tick()
  const timer = io.every(INTERVAL_MS, () => void tick())

  return {
    resign: async () => {
      const epoch = held
      timer.cancel()
      stopSampler()
      if (epoch !== undefined) await io.write(resignedFile(paths, epoch), JSON.stringify({ sessionId: me.sessionId, at: await io.now() }))
    },
    stop: () => {
      timer.cancel()
      stopSampler()
    },
  }
}
