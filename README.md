# clearance

> Status: **pre-release**. Build steps 1–5 of 7 work: the shared snapshot, the scribe election, presence, the gate with its status line and the marshaller badge band, admission (spawn gate, subagent budget, headroom tool, session-start dialog) the `/clearance` pane, and forecasts learned from history; nothing is released yet.

A Claude Code mod that makes every session on a machine aware of the machine's resources and of the other sessions:

- **See** every Claude session, its subagents, child processes and containers, and what each one uses.
- **Know the headroom**: how many more local sessions or subagents fit right now, updated live as sessions finish.
- **Get clearance** before launching more. Over the cap, a new session is held, with the choice to divert to a cloud session, Remote Control or ssh, or to wait. A subagent spawn is refused with a forecast, so the agent can resize its fan-out.

Windows first; Linux and macOS samplers can follow behind the same interface.

## Install (once released)

```bash
claude plugin marketplace add LeventAksakal/clearance
claude plugin install clearance@clearance
```

## What it reaches

Shared state lives in `~/.claude/clearance/` (see [docs/design.md](docs/design.md)).

- `$.process`: runs `pwsh -File` on the scripts in `scripts/`. `verify.ps1` is a manual, read-only cross-check of the snapshot (`pwsh -File scripts/verify.ps1`). `sampler.ps1` reads memory and the process list through Win32 and writes only under `~/.claude/clearance/`; `claim.ps1` creates one epoch file there.
- `$.fs`: reads `~/.claude/sessions/*.json` (never the `*.key` files) and reads and writes `~/.claude/clearance/`, including this session's presence file and its history file `history/<yyyy-mm>/<sessionId>.jsonl` (one line per finished subagent: type, duration, growth; one line of the session's peaks). It reads every session's history of the last two months to learn the forecasts.
- Hooks: `session.start`, `session.end`, `tool.call` (every tool, after `next`, only to note progress; the call is never changed), `ui.render` of `AbovePrompt` (the badge band, always up; it yields to a survey and stacks above a band another plugin draws), `ui.render` of `SessionMode` (the footer chip on the desktop: marshaller, RAM bar, verdicts; it keeps the engine's mode labels), `agent.spawn` (refuses a subagent over the cap, with the forecast), `classic.SubagentStart` (adds the subagent's budget line; starts measuring it), `classic.SubagentStop` (records what it cost), `tool.call` of `Agent` (notes `isolation: "remote"` so a cloud subagent isn't gated by this machine).
- `$.tool.register`: `mcp__clearance__headroom`, the census for the model. `$.command.register`: `/clearance`, which opens the pane (`$.ui.open`, `ui.render` of `Pane`).
- `$.ui.ask` (the session-start dialog on HOLD), `$.session.append` (a system notice with the divert steps, only when chosen), `$.ui.toast`.
- `$.state` `clearance.badge`, `clearance.pane`, `clearance.startChecked`, `clearance.waitingForClearance`.
- `$.session.id`, `$.clock`, `$.env.get('USERPROFILE')`, `$.ui.status`, `$.ui.log` (debug log).

Options (`/config`): `minFreeGB` 0 (auto: 5% of RAM), `maxCommitPct` 90, `maxSessions` 6, `maxAgents` 8, `sessionBaselineGB` 0 (learned).
- No `$.http`.

## License

MIT
