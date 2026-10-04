import type { EngineInterface, Register } from 'claude-code'
import { pathsFor } from './paths.ts'
import { startScribe, type Io, type Scribe } from './scribe.ts'
import { statusLine } from './snapshot.ts'

// Wiring only: hooks to modules. Step 1 (backbone): the scribe election, the
// sampler and a status line with the machine's live numbers.

// The scribe's reach. `$` stays in this file: the validator follows it only
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

export const register: Register = on => {
  let scribe: Scribe | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = await $.env.get('USERPROFILE')
    if (!home) {
      $.ui.status('clearance · USERPROFILE is not set')
      return started
    }
    scribe?.stop()
    const paths = pathsFor(home)
    scribe = startScribe(ioFor($, `${paths.root}\\logs\\${await $.session.id()}.log`), {
      paths,
      scripts: `${$.plugin.root}\\scripts`,
      onTick: (snapshot, isScribe, now) => $.ui.status(statusLine(snapshot, now, isScribe)),
    })
    return started
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
