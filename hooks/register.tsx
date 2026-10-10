import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'
import { bandLine, badgeModel, cardRows, light, LIGHT_COLOR, TONE_COLOR, type BadgeRun } from './badge.ts'
import { DIALOG, budgetLine, decideSpawn, divertSteps, headroomReport, withOwnAgents, withoutSession } from './admission.ts'
import { describe, forecastAgent, forecastSession, type Forecast } from './forecast.ts'
import { startGrowthWatch, startHistory, startTracker, type History, type Tracker } from './history.ts'
import { checksReport, runChecks } from './checks.ts'
import { emptyPressure, fold, isPressured, isSameMachine, isThrash, lastBusyProgress, learnFloor, parsePressure, STALL_MS, type Floor, type Pressure } from './pressure.ts'
import { advance, floorMB, gate, gateOptions, type GateOptions, type GateView } from './gate.ts'
import type { Io } from './io.ts'
import { paneLines, paneModel, type Tone } from './pane.ts'
import { pathsFor } from './paths.ts'
import { startPresence, type Presence } from './presence.ts'
import { startScribe, type Scribe } from './scribe.ts'
import { isFresh, statusLine, type Snapshot } from './snapshot.ts'
import { H, SCALE, spriteSvg, W } from './sprite.ts'

// Wiring only: hooks to modules. Step 1: the scribe election and the sampler.
// Step 2: presence, the gate, the status line's states and the HOLD band.
// Step 3: admission: the spawn gate, each subagent's budget line, the
// headroom tool and the session-start dialog. Step 4: the /clearance pane.
// The band: an always-up badge, the marshaller sprite and one line.

const badge = atom({ plugin: 'clearance', key: 'badge' } as const, null)
const pane = atom({ plugin: 'clearance', key: 'pane' } as const, null)
const startChecked = atom({ plugin: 'clearance', key: 'startChecked' } as const, false)
const waitingForClearance = atom({ plugin: 'clearance', key: 'waitingForClearance' } as const, false)

const HEADROOM_TOOL = 'mcp__clearance__headroom'
const PANE = 'clearance'
const PANE_TITLE = 'clearance'

const TONE: Record<Tone, { color?: string; dimColor?: boolean; bold?: boolean }> = {
  plain: {},
  dim: { dimColor: true },
  ok: { color: 'green', bold: true },
  warn: { color: 'yellow', bold: true },
  head: { bold: true },
}

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

/** What the hooks share; the module's own, so a hot reload starts it over. */
type Ctx = {
  opts: GateOptions
  presence: Presence | undefined
  io: Io | undefined
  /** The latest snapshot read, if it was fresh then. */
  latest: Snapshot | undefined
  /** This session's id as of the last session.start (the pane marks its row). */
  sessionId: string
  /** The band has been drawn on the desktop: the status line then stays empty, not repeating it. */
  footerDrawn: boolean
  /** Agent calls with `isolation: "remote"`, by tool_use_id: they run in the cloud, so the gate lets them through. */
  remote: Set<string>
  /** Remote subagents by agentId: their growth isn't this machine's, so the tracker skips them. */
  remoteAgents: Set<string>
  history: History | undefined
  tracker: Tracker | undefined
  /** Largest growth step of any live session: the subagent stand-in before any run is measured. */
  growth: ReturnType<typeof startGrowthWatch>
  /** The person fixed the session cost in the options; otherwise it is learned. */
  sessionFixed: boolean
  /** The paging histogram: kept and written by the scribe, read by the others. */
  pressure: Pressure | undefined
  /** The machine's RAM in the latest fresh sample: a histogram learned on other RAM is set aside. */
  totalMB: number | undefined
  floor: Floor
  /** Pressured samples in a row (THRASH needs THRASH_RUN). */
  pressuredRun: number
  /** A THRASH episode is on: its one toast has been shown. */
  inThrash: boolean
}

/** The scribe writes the paging histogram this often (in samples: one minute). */
const PRESSURE_WRITE_SAMPLES = 12

const NO_FLOOR: Floor = { mb: undefined, calmP90: undefined, calmFromMB: undefined, n: 0, basis: 'learning: no paging samples yet' }

/** The learned floor goes into the gate (it applies while the floor option is 0, auto). */
const relearnFloor = (ctx: Ctx) => {
  ctx.floor = ctx.pressure ? learnFloor(ctx.pressure) : NO_FLOOR
  ctx.opts.learnedFloorMB = ctx.floor.mb
}

const floorBasis = (ctx: Ctx) =>
  ctx.opts.minFreeGB > 0 ? `set to ${ctx.opts.minFreeGB} GB in the options` : ctx.floor.mb !== undefined ? `learned: ${ctx.floor.basis}` : `policy 5% of RAM (${ctx.floor.basis})`

/** Reads the paging histogram written by the scribe; a missing or broken file leaves what is in memory. */
async function loadPressure($: EngineInterface, ctx: Ctx, path: string): Promise<void> {
  try {
    const p = parsePressure(await $.fs.read(path))
    if (p && (ctx.totalMB === undefined || isSameMachine(p, ctx.totalMB))) ctx.pressure = p
  } catch {
    // no histogram yet
  }
  relearnFloor(ctx)
}

/** Samples in the band's RAM sparkline: 10 × 5 s, the last 50 s. */
const TRAIL = 10

/** Every session's history reread from disk this often, to learn from the others. */
const HISTORY_RELOAD_MS = 10 * 60_000
/** This session's peaks written at most this often (they only grow). */
const SESSION_WRITE_MS = 60_000

/** The learned forecast for one more subagent of `type`, or the prior without history. */
const agentForecast = (ctx: Ctx, type: string, now: number): Forecast =>
  forecastAgent(ctx.history?.records() ?? [], type, ctx.growth.maxStepMB(), now)

const basis = describe

/** The session cost the gate uses, unless fixed in the options: recorded session peaks and every live session's size now. */
const relearnSession = (ctx: Ctx, now: number) => {
  if (ctx.sessionFixed) return
  const live = (ctx.latest?.sessions ?? []).map(r => r.selfMB + r.childMB)
  ctx.opts.sessionBaselineGB = forecastSession(ctx.history?.records() ?? [], live, now).mb / 1024
}



/** The latest snapshot if still fresh, with this session's subagents counted as they are now. */
async function current($: EngineInterface, ctx: Ctx, now: number): Promise<Snapshot | undefined> {
  if (!ctx.latest || !isFresh(ctx.latest, now) || !ctx.presence) return undefined
  return withOwnAgents(ctx.latest, await $.session.id(), ctx.presence.agentsInFlight())
}

/** Once per session, on the first fresh snapshot: was this session started over the cap? Asks unawaited (S5). */
async function checkStart($: EngineInterface, ctx: Ctx, s: Snapshot): Promise<void> {
  if (await read($, startChecked)) return
  await update($, startChecked, () => true)
  const v = gate(withoutSession(s, await $.session.id()), ctx.opts, { kind: 'session' })
  ctx.io?.log(`session-start check: ${v.state}${v.reasons.length ? ` (${v.reasons.join('; ')})` : ''}`)
  if (v.state === 'CLEARED') return
  void $.ui.ask(DIALOG.question(v), [DIALOG.divert, DIALOG.wait, DIALOG.anyway]).then(
    async answer => {
      ctx.io?.log(`session-start dialog: ${answer}`)
      if (answer === DIALOG.divert) await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: divertSteps(v) }] } })
      if (answer === DIALOG.wait) await update($, waitingForClearance, () => true)
    },
    err => ctx.io?.log(`session-start dialog not shown: ${String(err)}`),
  )
}

/** The person chose to wait at the session-start dialog and the machine has cleared: say so once. */
async function toastIfWaiting($: EngineInterface, headroomMB: number): Promise<void> {
  if (!(await read($, waitingForClearance))) return
  await update($, waitingForClearance, () => false)
  $.ui.toast(`clearance: cleared, ${(headroomMB / 1024).toFixed(1)} GB headroom`)
}

/** A run's Text style: its color or tone, strong, dim. */
const runStyle = (r: BadgeRun) => ({ color: r.color ?? (r.tone ? TONE_COLOR[r.tone] : undefined), bold: r.strong, dimColor: r.dim })

/** A line's runs as nested Texts, colored by tone. */
const runs = (Text: ElementTable['Text'], line: BadgeRun[]) =>
  line.map((r, i) => (
    <Text key={`r${i}`} {...runStyle(r)}>
      {r.text}
    </Text>
  ))

export const register: Register = (on, options) => {
  const opts = gateOptions(options)
  const ctx: Ctx = {
    opts,
    presence: undefined,
    io: undefined,
    latest: undefined,
    sessionId: '',
    footerDrawn: false,
    remote: new Set(),
    remoteAgents: new Set(),
    history: undefined,
    tracker: undefined,
    growth: startGrowthWatch(),
    sessionFixed: opts.sessionBaselineGB > 0,
    pressure: undefined,
    totalMB: undefined,
    floor: NO_FLOOR,
    pressuredRun: 0,
    inThrash: false,
  }
  let sessionWrittenAt = 0
  let pressureT = -1
  let pressureFolded = 0
  let pressurePath = ''
  let isScribeNow = false
  let lastThrash: string | undefined
  let loadPressureNow: () => Promise<void> = async () => {}
  /** RAM in use, percent, one per sample: the band's sparkline. */
  const ramTrail: number[] = []
  let trailT = -1
  let historyLoadedAt = 0
  let scribe: Scribe | undefined
  let view: GateView | undefined
  let shownBadge = 'null'

  /** Writes this session's peaks as they grow, and rereads every session's history now and then. */
  const keepHistory = async (now: number) => {
    const history = ctx.history
    if (!history || !ctx.tracker) return
    if (now - sessionWrittenAt >= SESSION_WRITE_MS) {
      sessionWrittenAt = now
      const r = ctx.tracker.session(ctx.sessionId, now)
      if (r) await history.setSession(r)
    }
    if (now - historyLoadedAt >= HISTORY_RELOAD_MS) {
      historyLoadedAt = now
      await history.reload()
      relearnSession(ctx, now)
      if (!isScribeNow && pressurePath) await loadPressureNow()
    }
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = await $.env.get('USERPROFILE')
    if (!home) {
      $.ui.status('clearance · USERPROFILE is not set')
      return started
    }
    scribe?.stop()
    const paths = pathsFor(home)
    const sessionIo = ioFor($, `${paths.root}\\logs\\${await $.session.id()}.log`)
    const presence = startPresence(sessionIo, paths)
    ctx.sessionId = await $.session.id()
    ctx.io = sessionIo
    ctx.presence = presence
    await presence.flush()
    const startedAt = await $.clock.now()
    ctx.tracker = startTracker()
    try {
      ctx.history = await startHistory(sessionIo, paths, ctx.sessionId, startedAt)
      historyLoadedAt = startedAt
      relearnSession(ctx, startedAt)
      const f = agentForecast(ctx, 'general-purpose', startedAt)
      sessionIo.log(
        `history: ${ctx.history.records().length} records; subagent ${f.mb} MB (${basis(f)}); session ${Math.round(opts.sessionBaselineGB * 1024)} MB`,
      )
    } catch (err) {
      sessionIo.log(`history: ${String(err)}`)
    }
    pressurePath = paths.pressure
    loadPressureNow = () => loadPressure($, ctx, paths.pressure)
    await loadPressureNow()
    sessionIo.log(`floor: ${floorBasis(ctx)}`)
    await $.command.register({
      name: 'clearance',
      description: "Show this machine's sessions, their memory and the headroom in a pane; `/clearance check` runs the convention checks",
    })
    await $.tool.register({
      name: 'headroom',
      description:
        "clearance: this machine's memory headroom, every Claude session's use, and how many subagents of a type fit now. " +
        'Call it before spawning several subagents, and size the fan-out to what it says fits.',
      inputSchema: {
        type: 'object',
        properties: {
          subagentType: { type: 'string', description: 'The subagent type you plan to spawn (default general-purpose).' },
          count: { type: 'integer', minimum: 1, description: 'How many you plan to spawn.' },
        },
      },
    })
    scribe = startScribe(sessionIo, {
      paths,
      scripts: `${$.plugin.root}\\scripts`,
      onTick: (snapshot, isScribe, now) => {
        const fresh = snapshot && isFresh(snapshot, now) ? snapshot : undefined
        ctx.latest = fresh
        isScribeNow = isScribe
        // Step 7: fold the sample into the paging histogram (the scribe), count a
        // pressured run, and judge THRASH, once per sample.
        let thrash: string | undefined = lastThrash
        if (fresh && fresh.t !== pressureT) {
          pressureT = fresh.t
          ctx.totalMB = fresh.machine.totalMB
          // The RAM changed: the histogram learned on the old RAM is kept aside
          // (pressure-<MB>.json, by the scribe) and learning starts over.
          const old = ctx.pressure
          if (old && !isSameMachine(old, fresh.machine.totalMB)) {
            ctx.pressure = undefined
            relearnFloor(ctx)
            sessionIo.log(`pressure: the histogram was learned on ${old.totalMB} MB of RAM, this machine has ${fresh.machine.totalMB} MB; learning the floor again`)
            if (isScribe)
              void $.fs.write(paths.pressure.replace(/\.json$/, `-${old.totalMB}.json`), JSON.stringify(old)).catch(err => sessionIo.log(`pressure archive: ${String(err)}`))
          }
          const pages = fresh.machine.pagesInPerSec
          if (isScribe && pages !== undefined) {
            ctx.pressure = fold(ctx.pressure ?? emptyPressure(fresh.machine.totalMB), fresh.machine.availableMB, pages, fresh.t)
            if (++pressureFolded % PRESSURE_WRITE_SAMPLES === 0) {
              relearnFloor(ctx)
              void $.fs.write(paths.pressure, JSON.stringify(ctx.pressure)).catch(err => sessionIo.log(`pressure write: ${String(err)}`))
            }
          }
          ctx.pressuredRun = isPressured(pages, ctx.floor) ? ctx.pressuredRun + 1 : 0
          const floor = floorMB(opts, fresh.machine.totalMB)
          thrash = isThrash({ pressuredRun: ctx.pressuredRun, availableMB: fresh.machine.availableMB, floorMB: floor, lastProgressAt: lastBusyProgress(fresh.sessions), now })
            ? ctx.pressuredRun >= 3
              ? `THRASH: paging ${Math.round(pages ?? 0)}/s (calm ≤ ${ctx.floor.calmP90}/s) with ${(fresh.machine.availableMB / 1024).toFixed(1)} GB free, under the ${(floor / 1024).toFixed(1)} GB floor`
              : `THRASH: ${(fresh.machine.availableMB / 1024).toFixed(1)} GB free, under half the floor, and no busy session progressed for ${STALL_MS / 60_000} min`
            : undefined
          lastThrash = thrash
        }
        view = fresh ? advance(view, fresh, opts, presence.reservedSince(fresh.t, now), thrash) : undefined
        if (view?.shown.state === 'THRASH' && !ctx.inThrash) {
          ctx.inThrash = true
          sessionIo.log(thrash ?? 'THRASH')
          $.ui.toast(`clearance: THRASH. The machine is paging hard below its floor; every spawn is refused until it recovers.`)
        } else if (view && view.shown.state !== 'THRASH') ctx.inThrash = false
        const model = fresh && view ? paneModel(fresh, view, opts, ctx.sessionId, isScribe, now, floorBasis(ctx)) : null
        void update($, pane, () => model)
        $.ui.status(ctx.footerDrawn ? undefined : statusLine(snapshot, now, view?.shown))
        const own = fresh?.sessions.find(r => r.sessionId === ctx.sessionId)
        if (fresh && own) ctx.tracker?.sample(own, fresh.t)
        if (fresh && fresh.t !== trailT) {
          trailT = fresh.t
          ramTrail.push(Math.round(((fresh.machine.totalMB - fresh.machine.availableMB) / fresh.machine.totalMB) * 100))
          if (ramTrail.length > TRAIL) ramTrail.shift()
        }
        if (fresh) {
          ctx.growth.observe(fresh.sessions, fresh.t)
          relearnSession(ctx, now)
        }
        void keepHistory(now).catch(err => sessionIo.log(`history: ${String(err)}`))
        const agentAsk = agentForecast(ctx, 'general-purpose', now)
        const agent = fresh ? gate(fresh, opts, { kind: 'agent', mb: agentAsk.mb }, presence.reservedSince(fresh.t, now)) : undefined
        const shown = badgeModel(snapshot, now, view, agent, {
          me: ctx.sessionId,
          floorMB: floorMB(opts, fresh?.machine.totalMB ?? 0),
          agentAskMB: agentAsk.mb,
          agentBasis: basis(agentAsk),
          sessionAskMB: opts.sessionBaselineGB * 1024,
          ramTrail: [...ramTrail],
          floorBasis: floorBasis(ctx),
        })
        const key = JSON.stringify(shown)
        if (key !== shownBadge) {
          shownBadge = key
          void update($, badge, () => shown)
        }
        if (!fresh) return
        void checkStart($, ctx, fresh).catch(err => sessionIo.log(`session-start check: ${String(err)}`))
        if (view?.shown.state === 'CLEARED') void toastIfWaiting($, view.shown.headroomMB)
      },
    })
    return started
  })

  // The spawn gate (S4): over the cap the Agent call fails with the forecast;
  // under it the memory is reserved before the spawn runs.
  on('agent.spawn', async ($, e, next) => {
    const presence = ctx.presence
    if (ctx.remote.delete(e.tool_use_id)) {
      ctx.io?.log(`spawn cleared, remote: ${e.subagentType} "${e.description}"`)
      const result = await next(e)
      if (result.agentId) ctx.remoteAgents.add(result.agentId)
      return result
    }
    if (!presence) return next(e)
    if (view?.shown.state === 'THRASH') {
      ctx.io?.log(`spawn denied, THRASH: ${e.subagentType} "${e.description}"`)
      return {
        deny:
          `clearance: THRASH. ${view.band?.reasons[0] ?? 'The machine is paging hard below its floor.'} Every spawn is refused until it recovers: ` +
          'finish the work in this conversation, stop heavy processes, or divert to a cloud session (claude.ai/code) or another machine.',
      }
    }
    const now = await $.clock.now()
    const s = await current($, ctx, now)
    const mb = agentForecast(ctx, e.subagentType, now).mb
    const decision = decideSpawn(s, opts, e.subagentType, mb, s ? presence.reservedSince(s.t, now) : 0)
    if (!decision.allow) {
      ctx.io?.log(`spawn denied: ${e.subagentType} "${e.description}": ${decision.verdict.reasons.join('; ')}`)
      return { deny: decision.deny }
    }
    await presence.reserve(e.tool_use_id, mb)
    try {
      const result = await next(e)
      await presence.started(e.tool_use_id, result.agentId)
      return result
    } catch (err) {
      await presence.started(e.tool_use_id, undefined)
      throw err
    }
  })

  // Every subagent learns its budget (S3).
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    if (!ctx.remoteAgents.has(e.agent_id)) ctx.tracker?.started(e.agent_id, e.agent_type, now)
    const line = budgetLine(await current($, ctx, now), opts, e.agent_type, agentForecast(ctx, e.agent_type, now).mb)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), line] }
  })

  // A finished subagent: in flight no more, and one more record to learn from.
  on('classic.SubagentStop', async ($, e, next) => {
    await ctx.presence?.stopped(e.agent_id)
    ctx.remoteAgents.delete(e.agent_id)
    const now = await $.clock.now()
    const record = ctx.tracker?.stopped(e.agent_id, now)
    if (record && ctx.history) {
      await ctx.history.addAgent(record)
      const f = agentForecast(ctx, record.type, now)
      ctx.io?.log(
        `history: ${record.type} ran ${Math.round(record.durationMs / 1000)} s, grew ${record.growthMB} MB over ${record.samples} samples ` +
          `(${record.concurrent} at once, cost ${record.costMB} MB); forecast now ${f.mb} MB (${basis(f)})`,
      )
    }
    return next(e)
  })

  // The headroom tool (S2): the census and what fits, for planning a fan-out.
  on('tool.call', { tool: HEADROOM_TOOL }, async ($, e) => {
    const now = await $.clock.now()
    const s = await current($, ctx, now)
    // The tool's own arguments sit beside `tool` in the input.
    const args = e as unknown as { subagentType?: unknown; count?: unknown }
    const ask = {
      subagentType: typeof args.subagentType === 'string' && args.subagentType ? args.subagentType : undefined,
      count: typeof args.count === 'number' && args.count > 0 ? Math.floor(args.count) : undefined,
    }
    const mbFor = (type: string) => {
      const f = agentForecast(ctx, type, now)
      return { mb: f.mb, basis: basis(f) }
    }
    return { result: headroomReport(s, opts, s && ctx.presence ? ctx.presence.reservedSince(s.t, now) : 0, ask, now, mbFor) }
  })

  // A remote Agent call is the divert the gate recommends: note it, so its
  // spawn isn't counted against this machine. The arguments sit beside `tool`.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const args = e as unknown as { isolation?: unknown }
    const id = e.tool_use_id
    if (args.isolation === 'remote' && id) ctx.remote.add(id)
    try {
      return await next(e)
    } finally {
      if (id) ctx.remote.delete(id)
    }
  })

  // Busy for the THRASH stall rule: a main-loop turn in flight (a subagent's
  // runs raise no turn.start; its turns carry agentId and are left alone).
  on('turn.start', async ($, e, next) => {
    await ctx.presence?.turn(true)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.agentId === undefined) await ctx.presence?.turn(false)
    }
  })

  // Progress for the THRASH detector: any tool result counts (throttled in presence).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    ctx.presence?.progress()
    return result
  })

  on('command.run', { command: 'clearance' }, async ($, e) => {
    if (e.args.trim() === 'check') {
      const s = ctx.latest
      if (!s || !ctx.io) return { text: 'clearance: no fresh snapshot yet; try again in a few seconds.' }
      return { text: checksReport(await runChecks(ctx.io, s), s.containers !== undefined) }
    }
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'clearance pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, pane), e.props.bodyColumns, await $.clock.now())
    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          line.cells ? (
            <Box key={`l${i}`} flexDirection="row">
              {line.cells.map((c, j) =>
                c.width === undefined ? (
                  <Text key={`t${j}`} wrap="truncate-end" {...TONE[line.tone]}>
                    {c.text || ' '}
                  </Text>
                ) : (
                  <Box key={`w${j}`} width={c.width} flexShrink={0} justifyContent={c.right ? 'flex-end' : 'flex-start'}>
                    <Text wrap="truncate-end" {...TONE[line.tone]}>
                      {c.text || ' '}
                    </Text>
                  </Box>
                ),
              )}
            </Box>
          ) : (
            <Text key={`l${i}`} wrap="truncate-end" {...TONE[line.tone]}>
              {line.text || ' '}
            </Text>
          ),
        )}
      </Box>
    )
  })

  // The band, always up: the marshaller in the tier's color and one dense line;
  // hovering it opens the machine and every session's use above the line. It
  // yields to a survey and keeps a band another plugin draws beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const b = (await read($, badge)) ?? badgeModel(undefined, 0, undefined)
    const below = await next(e)
    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const tier = light(b)
    if (e.surface !== 'terminal') ctx.footerDrawn = true
    const sprite =
      // The terminal's table stands a fragment in for Svg; it gets a glyph.
      e.surface !== 'terminal' && 'Svg' in t ? (
        // An image, not an interactive frame: the desktop rebuilds the band on
        // every redraw, and a rebuilt frame blanks and restarts its animation,
        // while an image of the same source comes from cache, still running.
        <t.Svg source={spriteSvg(b.mood === 'THRASH' ? 'thrash' : tier)} alt={`clearance: ${b.mood === 'THRASH' ? 'THRASH' : tier}`} width={W * SCALE} height={H * SCALE} />
      ) : (
        <Text color={LIGHT_COLOR[tier]} bold>
          ●
        </Text>
      )
    const ours = (
      <Box key="clearance-band" flexDirection="column" paddingX={1}>
        <Box display="none" hover={{ display: 'flex' }} flexDirection="column" marginBottom={1}>
          {cardRows(b).map((row, i) => (
            <Box key={`c${i}`} flexDirection="row">
              {row.map((c, j) =>
                c.width === undefined ? (
                  <Text key={`t${j}`} wrap="truncate-end" {...runStyle(c)}>
                    {c.text}
                  </Text>
                ) : (
                  <Box key={`w${j}`} width={c.width} flexShrink={0} justifyContent={c.right ? 'flex-end' : 'flex-start'}>
                    <Text wrap="truncate-end" {...runStyle(c)}>
                      {c.text || ' '}
                    </Text>
                  </Box>
                ),
              )}
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {sprite}
          <Text wrap="truncate-end">{runs(Text, bandLine(b))}</Text>
        </Box>
      </Box>
    )
    if (below.type === 'engine') return ours
    return (
      <Box flexDirection="column">
        {below}
        {ours}
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
