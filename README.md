# clearance

> Status: **v0.1.1**. All 7 build steps are done: the shared snapshot and scribe election, presence and the gate, admission, the `/clearance` pane, empirical forecasts, Docker and desktop attribution with convention checks, and THRASH with a floor learned from paging pressure. Windows only.

A Claude Code mod that makes every session on a machine aware of the machine's resources and of the other sessions:

- **See** every Claude session, its subagents, child processes and containers, the desktop app and the WSL/Docker VM, and what each one uses.
- **Know the headroom**: how many more local sessions or subagents fit right now, updated every 5 s.
- **Get clearance** before launching more. Over the cap, a new session is held, with the choice to divert to a cloud session, Remote Control or ssh, or to wait. A subagent spawn is refused with a forecast, so the agent can resize its fan-out; a cloud subagent (`isolation: "remote"`) is never gated by this machine.
- **Learn, don't assume**: what a subagent and a session cost is an upper confidence bound on what this machine was seen to use, and the memory floor is where this machine was seen to start paging hard.

## What you see

The band above the prompt, always up:

```
[marshaller] ● cleared 2s·6a  RAM ▁▂▃▅▆▇ 82%  2.8 GB free
```

- `2s·6a`: two more sessions and six more subagents fit. The sparkline is RAM in use over the last 50 s.
- The pixel marshaller takes the traffic-light tier: green waves both paddles (a session fits), yellow waves one (only subagents fit), red crosses them overhead (nothing fits), grey dozes (no snapshot). In THRASH it shakes and the line reads `▲ THRASH … spawns refused`.
- Hover the band for the machine, the floor and what it rests on, the asks and what they rest on (sizes under 1 GB in MB), and a table of every session's own, child and container memory, then the desktop app, the VM and everything else. The table's columns are fixed-width cells, so they line up in the desktop's proportional font too.

`/clearance` opens the full pane; `/clearance check` runs the convention checks (read-only): Supabase `project_id` left as default or shared, compose stacks without a `working_dir` label, hard-coded host ports, and host-port or project-name collisions between running containers.

The band takes the `AbovePrompt` slot. Another plugin that draws there without passing the band on (token-weather does) hides it; clearance passes the band on, so a plugin beneath it still shows.

## Install

```bash
claude plugin marketplace add LeventAksakal/clearance
claude plugin install clearance@clearance
```

## What it reaches

Shared state lives in `~/.claude/clearance/` (see [docs/design.md](docs/design.md)).

- `$.process`: runs `pwsh -File` on the scripts in `scripts/`.
  - `sampler.ps1` (the scribe's, one per machine) reads memory, the process list with start times, and paging pressure (`\Memory\Pages Input/sec`, PDH) through Win32, and every 6th tick `docker ps` and `docker stats --no-stream` (read-only). It writes only under `~/.claude/clearance/`.
  - `claim.ps1` creates one epoch file there.
  - `verify.ps1` is a manual, read-only cross-check of the snapshot (`pwsh -File scripts/verify.ps1`).
- `$.fs`:
  - reads `~/.claude/sessions/*.json` (never the `*.key` files);
  - reads and writes `~/.claude/clearance/`: this session's presence file, its history file `history/<yyyy-mm>/<sessionId>.jsonl` (one line per finished subagent: type, duration, growth; one line of the session's peaks), and, while it is scribe, `pressure.json` (a histogram of paging against available memory; when the machine's RAM changes, the old one is kept as `pressure-<MB>.json` and learning starts over);
  - reads every session's history of the last two months and `pressure.json` to learn the forecasts and the floor;
  - for `/clearance check` only: reads `supabase/config.toml` and compose files in each session's folder and one level down.
- Hooks: `session.start`, `session.end`, `tool.call` (every tool, after `next`, only to note progress; the call is never changed), `turn.start` and `turn.complete` (only to note whether the session is working), `tool.call` of `Agent` (notes `isolation: "remote"`), `agent.spawn` (refuses a subagent over the cap or in THRASH), `classic.SubagentStart` (adds the subagent's budget line; starts measuring it), `classic.SubagentStop` (records what it cost), `command.run` of `clearance`, `ui.render` of `AbovePrompt` (the band) and of `Pane` (the pane).
- `$.tool.register`: `mcp__clearance__headroom`, the census for the model. `$.command.register`: `/clearance`.
- `$.ui.ask` (the session-start dialog on HOLD), `$.session.append` (a system notice with the divert steps, only when chosen), `$.ui.toast` (one per THRASH episode; when a held start clears), `$.ui.open`, `$.ui.status` (terminal), `$.ui.log` (debug log).
- `$.state` `clearance.badge`, `clearance.pane`, `clearance.startChecked`, `clearance.waitingForClearance`.
- `$.session.id`, `$.clock`, `$.env.get('USERPROFILE')`.
- No `$.http`.

Options (`/config`): `minFreeGB` 0 (learned from paging; 5% of RAM until pressure is seen), `maxCommitPct` 90, `maxSessions` 6, `maxAgents` 8, `sessionBaselineGB` 0 (learned). A positive `minFreeGB` or `sessionBaselineGB` fixes that value.

## Develop

```bash
claude plugin validate .
claude plugin test .
npx tsc -p .
```

`tsc` needs `.claude-plugin/types/`, which the engine writes when the mod is hot-loaded (or `/plugin-types`).

## License

MIT
