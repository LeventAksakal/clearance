# clearance

> Status: **pre-release**. Build step 1 of 7 (the backbone: shared snapshot, scribe election, status line) works; nothing is released yet.

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

- `$.process`: runs `pwsh -File` on the scripts in `scripts/`. `sampler.ps1` reads memory and the process list through Win32 and writes only under `~/.claude/clearance/`; `claim.ps1` creates one epoch file there.
- `$.fs`: reads `~/.claude/sessions/*.json` (never the `*.key` files) and reads and writes `~/.claude/clearance/`.
- `$.session.id`, `$.clock`, `$.env.get('USERPROFILE')`, `$.ui.status`, `$.ui.log` (debug log).
- No `$.http`.

## License

MIT
