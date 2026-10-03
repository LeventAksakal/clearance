# clearance

> Status: **pre-release**. The API spike is in progress and nothing is installable yet.

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

## License

MIT
