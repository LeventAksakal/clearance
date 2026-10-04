import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { advance, gateOptions, type GateView } from './gate.ts'
import type { Io } from './io.ts'
import { pathsFor } from './paths.ts'
import { startPresence, type Presence } from './presence.ts'
import { startScribe, type Scribe } from './scribe.ts'
import { isFresh, statusLine } from './snapshot.ts'

// Wiring only: hooks to modules. Step 1: the scribe election and the sampler.
// Step 2: presence, the gate, the status line's states and the HOLD band.

const band = atom({ plugin: 'clearance', key: 'band' } as const, null)

// The modules' reach. `$` stays in this file: the validator follows it only
// within one file, so the other modules get these closures instead.
// Log lines also go to ~/.claude/clearance/logs/<sessionId>.log (this session
// its only writer), the last LOG_LINES of them, so an election can be read back
// from sessions that don't run with --debug.
const LOG_LINES = 200

const ioFor = ($: EngineInterface, logFile: string): Io => {
  const lines: string[] = []
  return {
    now: () => $.clock.now(),
    sessionId: () => $.session.id(),
    list: dir => $.fs.list(dir),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    mtime: async path => (await $.fs.stat(path)).mtimeMs,
    run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    spawn: argv => $.process.spawn({ argv }),
    every: (ms, fn) => $.clock.every(ms, fn),
    log: text => {
      $.ui.log(`clearance: ${text}`, { to: 'debug' })
      lines.push(`${new Date().toISOString()} ${text}`)
      if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
      void $.fs.write(logFile, lines.join('\n') + '\n').catch(() => {})
    },
  }
}

export const register: Register = (on, options) => {
  const opts = gateOptions(options)
  let scribe: Scribe | undefined
  let presence: Presence | undefined
  let view: GateView | undefined
  let shownBand = 'null'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = await $.env.get('USERPROFILE')
    if (!home) {
      $.ui.status('clearance · USERPROFILE is not set')
      return started
    }
    scribe?.stop()
    const paths = pathsFor(home)
    const io = ioFor($, `${paths.root}\\logs\\${await $.session.id()}.log`)
    presence = startPresence(io, paths)
    await presence.flush()
    scribe = startScribe(io, {
      paths,
      scripts: `${$.plugin.root}\\scripts`,
      onTick: (snapshot, _isScribe, now) => {
        const fresh = snapshot && isFresh(snapshot, now) ? snapshot : undefined
        view = fresh ? advance(view, fresh, opts, presence?.reservedSince(fresh.t) ?? 0) : undefined
        $.ui.status(statusLine(snapshot, now, view?.shown))
        const held = view?.band ?? null
        const key = JSON.stringify(held)
        if (key !== shownBand) {
          shownBand = key
          void update($, band, () => held)
        }
      },
    })
    return started
  })

  // Progress for the THRASH detector: any tool result counts (throttled in presence).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    presence?.progress()
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, band)
    if (!held || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow" bold>
          clearance HOLD{' '}
        </Text>
        <Text wrap="truncate-end">
          {held.reasons.join('; ')} · new sessions: divert to a cloud session, Remote Control or ssh, or wait
        </Text>
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the process: the scribe keeps its role.
    if (e.reason !== 'clear') {
      await scribe?.resign()
      scribe = undefined
    }
    return next(e)
  })
}
