import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'
import type { ClearanceBadge } from '../types'
import { badgeLine, badgeModel, cardLines, footerLine, TONE_COLOR, type BadgeRun } from './badge.ts'
import { DIALOG, budgetLine, decideSpawn, divertSteps, headroomReport, withOwnAgents, withoutSession } from './admission.ts'
import { describe, forecastAgent, forecastSession, type Forecast } from './forecast.ts'
import { startGrowthWatch, startHistory, startTracker, type History, type Tracker } from './history.ts'
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
  /** The chip has been drawn (desktop): the status line then stays empty, not repeating it. */
  footerDrawn: boolean
  /** The hint line has drawn the chip: the footer's mode labels then go back to the engine. */
  hintDrawn: boolean
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
}

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

/** The chip: its line, and a card shown above it while the pointer is on it. */
const chip = (t: ElementTable, b: ClearanceBadge, key: string) => {
  const card = cardLines(b)
  return (
    <t.Box key={key} flexDirection="row">
      <t.Text wrap="truncate-end">{runs(t.Text, footerLine(b))}</t.Text>
      <t.Box
        position="absolute"
        bottom={1}
        left={0}
        display="none"
        hover={{ display: 'flex' }}
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        backgroundColor="#1b1b1b"
        paddingX={1}
      >
        {card.map((line, i) => (
          <t.Text key={`c${i}`} wrap="truncate-end">
            {runs(t.Text, line)}
          </t.Text>
        ))}
      </t.Box>
    </t.Box>
  )
}

/** A line's runs as nested Texts, colored by tone. */
const runs = (Text: ElementTable['Text'], line: BadgeRun[]) =>
  line.map((r, i) => (
    <Text key={`r${i}`} color={r.color ?? (r.tone ? TONE_COLOR[r.tone] : undefined)} bold={r.strong} dimColor={r.dim}>
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
    hintDrawn: false,
    remote: new Set(),
    remoteAgents: new Set(),
    history: undefined,
    tracker: undefined,
    growth: startGrowthWatch(),
    sessionFixed: opts.sessionBaselineGB > 0,
  }
  let sessionWrittenAt = 0
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
    await $.command.register({ name: 'clearance', description: "Show this machine's sessions, their memory and the headroom in a pane" })
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
        view = fresh ? advance(view, fresh, opts, presence.reservedSince(fresh.t, now)) : undefined
        const model = fresh && view ? paneModel(fresh, view, opts, ctx.sessionId, isScribe, now) : null
        void update($, pane, () => model)
        $.ui.status(ctx.footerDrawn ? undefined : statusLine(snapshot, now, view?.shown))
        const own = fresh?.sessions.find(r => r.sessionId === ctx.sessionId)
        if (fresh && own) ctx.tracker?.sample(own, fresh.t)
        if (fresh) {
          ctx.growth.observe(fresh.sessions, fresh.t)
          relearnSession(ctx, now)
        }
        void keepHistory(now).catch(err => sessionIo.log(`history: ${String(err)}`))
        const agent = fresh
          ? gate(fresh, opts, { kind: 'agent', mb: agentForecast(ctx, 'general-purpose', now).mb }, presence.reservedSince(fresh.t, now))
          : undefined
        const shown = badgeModel(snapshot, now, view, agent, {
          me: ctx.sessionId,
          floorMB: floorMB(opts, fresh?.machine.totalMB ?? 0),
          agentAskMB: agentForecast(ctx, 'general-purpose', now).mb,
          sessionAskMB: opts.sessionBaselineGB * 1024,
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

  // Progress for the THRASH detector: any tool result counts (throttled in presence).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    ctx.presence?.progress()
    return result
  })

  on('command.run', { command: 'clearance' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'clearance pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, pane), e.props.bodyColumns, await $.clock.now())
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={`l${i}`} wrap="truncate-end" {...TONE[line.tone]}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
    )
  })

  // The chip, live: one traffic-light line beside the prompt, and on hover a
  // card with the machine and every session's use. It sits in the hint line by
  // "Auto" where there is room, and in the footer's mode labels only until the
  // hint line has drawn it. Another plugin's band can't hide either.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    ctx.footerDrawn = true
    if (!ctx.hintDrawn) {
      ctx.hintDrawn = true
      $.ui.invalidate('ui.render')
    }
    const b = (await read($, badge)) ?? badgeModel(undefined, 0, undefined)
    const t = $.ui.resolve(e)
    return (
      <t.Box flexDirection="row" columnGap={2}>
        {e.props.hint ? <t.Text dimColor>{e.props.hint}</t.Text> : null}
        {chip(t, b, 'chip-hint')}
      </t.Box>
    )
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'terminal' || ctx.hintDrawn) return next(e)
    ctx.footerDrawn = true
    const b = (await read($, badge)) ?? badgeModel(undefined, 0, undefined)
    const t = $.ui.resolve(e)
    return (
      <t.Box flexDirection="row" columnGap={1}>
        {e.props.modes.length > 0 ? <t.Text dimColor>{e.props.modes.join(' & ')}</t.Text> : null}
        {chip(t, b, 'chip-modes')}
      </t.Box>
    )
  })

  // The badge, always up. It yields to a survey and keeps a band another
  // plugin draws beneath it, stacked above its own line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const b = (await read($, badge)) ?? badgeModel(undefined, 0, undefined)
    const below = await next(e)
    const t = $.ui.resolve(e)
    const { Box, Text } = t
    const tone = b.mood === 'CLEARED' ? 'ok' : b.mood === 'HOLD' ? 'warn' : 'idle'
    const sprite =
      // The terminal's table stands a fragment in for Svg; it gets a glyph.
      e.surface !== 'terminal' && 'Svg' in t ? (
        <t.Svg source={spriteSvg(b.mood)} alt={`clearance: ${b.mood.toLowerCase()}`} width={W * SCALE} height={H * SCALE} isInteractive />
      ) : (
        <Text color={TONE_COLOR[tone]} bold>
          {b.mood === 'CLEARED' ? '✓' : b.mood === 'HOLD' ? '■' : '·'}
        </Text>
      )
    const ours = (
      <Box flexDirection="row" alignItems="center" columnGap={1} paddingX={1}>
        {sprite}
        <Text wrap="truncate-end">
          {runs(Text, badgeLine(b, e.props.bodyColumns - 8))}
        </Text>
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
