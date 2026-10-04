# clearance: design

Status: draft v0.1, 2026-10-03; steps 1–4 built 2026-10-04 (see § Build findings). It is built on the decisions in wombraider-mods `docs/decisions/0001–0009` and on the API spike (all 7 checks passed on Claude Code 2.1.286).

## What it does

Each Claude session on the machine loads clearance. Together the sessions:

1. **See** the machine: every session, its child processes, the Desktop app, Docker containers, and free memory and commit, updated every 5 s.
2. **Decide** whether there is clearance for more work. The states are **CLEARED**, **HOLD** and **THRASH**, set by a memory-pressure gate plus count ceilings (0002).
3. **Act without killing anything** (0003):
   - **Session start:** a dialog over the cap offers to divert to a cloud session, Remote Control or ssh, to wait, or to start anyway.
   - **Subagent spawn:** refused over the cap, with a forecast in the reason so the agent can resize its fan-out (0004).
   - **Model tool:** `mcp__clearance__headroom` returns the same table, so an agent can plan before it spawns (0004).
4. **Learn:** every session and subagent leaves a usage record (0001). Forecasts come from that history.
5. **Check conventions**, read-only, for collisions that make attribution impossible (0001).

## Architecture

```
            one per machine (elected)                  every session
   ┌───────────────────────────────────────┐   ┌──────────────────────────────┐
   │ scribe session                        │   │ presence: sessions/<id>.json │
   │  └ sampler.ps1 (warm pwsh, -File)     │   │ gate: reads snapshot          │
   │     ├ Win32: memory, process tree     │──▶│ ui: status, band, pane        │
   │     ├ registry: pid → session → cwd   │   │ hooks: session.start,         │
   │     ├ docker ps/stats (every 6th tick)│   │   agent.spawn, SubagentStart, │
   │     └ writes snapshot.json atomically │   │   tool, /clearance            │
   └───────────────────────────────────────┘   │ history: own jsonl file       │
                    ▲ claim.ps1 (CreateNew)     └──────────────────────────────┘
                    └── watchdog in every session (5 s)
```

### Shared state: `~/.claude/clearance/`

Every file has exactly one writer, so nothing needs a lock.

| Path | Writer | Readers | Content |
|---|---|---|---|
| `scribe/epoch-<n>` | the claimant that wins `CreateNew` | all | `{ sessionId, pid, at }` |
| `snapshot.json` | sampler.ps1 (temp file + rename) | all sessions, leases mod, lane-supervisor | schema below |
| `sessions/<sessionId>.json` | that session (the scribe deletes it an hour after the session left the registry: `$.fs` has no delete) | sampler | presence: `{ schema, sessionId, agentsInFlight, reservations, reservedMB, lastProgressAt, t }` |
| `history/<yyyy-mm>/<sessionId>.jsonl` | that session | forecaster | one record per finished subagent or session |
| `logs/<sessionId>.log` | that session | people debugging | the last 200 election and sampler lines |

`$.store` is not used for shared state. It has no locking across sessions and other mods can't read it. It only keeps per-user UI prefs.

### Scribe election (0006)

- **Epoch:** the highest `n` in `scribe/`. The holder is in that file: `{ sessionId, pid, procStart, at }`. Identity is the pid plus the registry's `procStart`, so the role survives a `/clear` (new session id, same process) and a reused pid is never taken for the holder.
- **Watchdog:** every session runs it every 5 s (file reads only). The scribe is **dead** when its registry entry is gone (or its `procStart` differs), when `snapshot.t` under its epoch is older than 3 intervals, or when it wrote no snapshot within 30 s of its claim (a cold sampler's first sample). Liveness reads only `epoch` and `t` from the snapshot, so sessions running different versions of the mod never take each other's snapshots for silence. The session then runs `claim.ps1 <n+1>`, and the `CreateNew` winner becomes scribe. Losers just read. Measured: 8 contenders, 1 winner.
- **Fencing:** sampler.ps1 is started with its epoch and its session's pid. Before each write it checks that no `epoch-<m>` with `m > epoch` and no `resigned-<epoch>` exists, and exits if one does, so a deposed scribe can't overwrite. It also exits when its session's pid is gone: `$.process.spawn` starts it through `cmd.exe`, so its parent is not the session, and an orphaned sampler would otherwise keep a dead scribe looking alive. Every snapshot carries `epoch`, and readers drop a snapshot whose epoch is below the highest claimed one.
- **Hot reload:** a reload kills the sampler (it's a `$.process.spawn` child). The same session wins the next epoch on its next watchdog tick.
- **Clean exit:** on `session.end` the scribe writes `scribe/resigned-<n>`, so the next claim happens without waiting out the stale timeout.
- **Cleanup:** epoch files older than the newest 5 are deleted by the current scribe.

### Snapshot schema (`schema: 1`, a contract with other mods: 0005)

```jsonc
{
  "schema": 1, "epoch": 12, "t": 1791036369900, "sampleMs": 563, "intervalMs": 5000,
  "machine": { "totalMB": 15724, "availableMB": 3230, "commitMB": 32533, "commitLimitMB": 47457 },
  "desktop": { "privateMB": 2480, "procs": 16 },                  // Claude Desktop (Electron) overhead
  "dockerVm": { "privateMB": 7029, "containersMB": 2479, "t": 1791036340000 },
  "sessions": [{
    "sessionId": "…", "pid": 4964, "cwd": "C:\\Code\\wombraider-mods", "entrypoint": "claude-desktop",
    "selfMB": 602, "childMB": 348, "children": 13,
    "topChildren": [{ "pid": 1, "name": "node.exe", "privateMB": 1812, "cmd": "vitest …" }],
    "containers": [{ "name": "ozu_aps_postgres", "project": "core", "memMB": 158 }],
    "agentsInFlight": 2, "lastProgressAt": 1791036300000            // from presence
  }],
  "unattributed": { "containers": [{ "name": "supabase_db_supabase", "project": "supabase", "memMB": 319 }] }
}
```

- Memory is **private bytes**, not working set, so shared pages aren't counted twice.
- `availableMB` is free plus standby (Task Manager's Available). The free list alone read 73 MB while 3.2 GB was available.
- `commitLimitMB` is read on every sample, because Windows grows the pagefile.
- A container is attributed through its `com.docker.compose.project.working_dir` label to the session whose `cwd` contains that path. Without the label it lands in `unattributed`, and the convention checks name it.
- **No machine verdict in schema 1 yet.** Each session runs `gate.ts` on the snapshot and adds its own reservations newer than the sample. The sampler has no thresholds, and the snapshot's one-writer rule keeps sessions from writing it; a `clearance` field moves in when a consumer (the leases mod) needs it.
- `agentsInFlight`, `reservedMB` and `lastProgressAt` on a session row come from its presence file, and are absent for a session without the mod.

### The gate (pure functions, `gate.ts`)

The inputs are the snapshot, this session's reservations and the options:

| Option (`userConfig`) | Default | Meaning |
|---|---|---|
| `minFreeGB` | 1.5 | Available RAM that must remain after admitting |
| `maxCommitPct` | 90 | Commit as a share of the commit limit, after admitting |
| `maxSessions` | 6 | Count ceiling for local sessions (0002) |
| `maxAgents` | 8 | Count ceiling for subagents in flight, machine-wide (summed from presence files) |
| `sessionBaselineGB` | 0.7 | Cost of a new session until history learns it (measured 0.5–0.8) |

- **States:**
  - **CLEARED:** every limit holds after adding the forecast.
  - **HOLD:** some limit would break.
  - **THRASH:** free memory is below half the floor **and** no session has made progress for 5 min. Progress is any tool result or file write recorded in presence.
- **THRASH effect:** the band turns red, every spawn is refused, and one toast fires per episode.
- **Hysteresis:** a state must hold for 2 samples before it changes, so the status line doesn't flicker.
- **Known gap:** two sessions can admit at the same moment and overshoot. Presence reservations narrow the window (a session records the reservation before it calls `next`), and the next sample corrects it. A ledger owned by the scribe is a v2 fix.

### Forecasts (`forecast.ts`, pure)

- **Session baseline:** the p85 of `selfMB` across past sessions, falling back to the default.
- **Subagent:** the p85 of the session tree's growth while that agent ran, keyed by `subagentType`, adjusted for how many agents ran at once. Subagents run inside the parent process, so this measures the children they start. A spawn with no history uses 0.3 GB.
- **Suggested parallelism:** `floor((headroom − reserve) / forecast)`, at least 0.
- An ETA estimate ("cleared in ~N min") waits for v2. The history it needs is recorded from v0.1.

### Hooks

| Event | Does |
|---|---|
| `session.start` | Resolve own pid (S1), write presence, start the watchdog, register the tool and `/clearance`, gate a new session. On HOLD, an **unawaited** `$.ui.ask` (S5) offers: Divert to cloud / Remote Control / ssh (copyable steps), Wait (toast once cleared), Start anyway. |
| `agent.spawn` | Gate with the forecast. Over: `{ deny: "clearance: HOLD. Forecast 0.4 GB for general-purpose, headroom 0.2 GB. Run at most 1 now, or divert…" }` (S4). Under: reserve, then `next`. |
| `classic.SubagentStart` | `additionalContext`: the agent's budget line (S3). |
| `classic.SubagentStop` | The subagent is no longer in flight. Its reservation runs out on its own after 30 s, by when samples count the memory it brought. (History records: step 5.) |
| `tool.call` (any, after `next`) | Bump `lastProgressAt` in presence, throttled to once per 15 s. |
| `tool.call` `mcp__clearance__headroom` | The census and forecast table as text (S2). |
| `command.run` `clearance` | Open the pane. `/clearance check` runs the convention checks. |
| `session.end` | Remove presence, resign if this session is scribe, flush history. |

### UI

- **Status line**, always: `clearance ✓ 3.1 GB · 2 more` / `clearance ■ HOLD 0.4 GB` / `clearance ▲ THRASH`.
- **AbovePrompt band**, only on HOLD or THRASH: one line with the reason and the offload options.
- **Pane `/clearance`:**
  - a machine row;
  - a table per session (session, worktree, self, children, containers, agents, last progress);
  - Desktop app and Docker VM rows;
  - unattributed containers;
  - the convention-check results.

### Convention checks (read-only, `checks.ts`)

| Check | Evidence today |
|---|---|
| Supabase `project_id` left as `"supabase"`, or the same id in two repos or worktrees | `ar-18`, `temizelisg` |
| A running compose project with no `working_dir` label (can't be attributed) | the Supabase CLI stack |
| Host ports hard-coded in compose (`"5432:5432"`) and no env indirection | `ozu-aps` 5432/8080/5050 |
| Two running containers or dev servers from different worktrees publishing the same port, or the same compose project name | — |

The checks report and suggest a fix. They never edit project files; that's the leases mod's job (0005).

## Files

```
.claude-plugin/plugin.json      userConfig: minFreeGB, maxCommitPct, maxSessions, maxAgents, sessionBaselineGB
hooks/hooks.json                { "modules": ["./register.ts"] }
hooks/register.ts               wiring only: hooks → modules
hooks/paths.ts                  ~/.claude/clearance layout
hooks/snapshot.ts               schema types, read, freshness, epoch check
hooks/scribe.ts                 watchdog, claim, sampler lifecycle, resign
hooks/presence.ts               own presence file, reservations, progress
hooks/gate.ts                   pure: state, headroom, reasons
hooks/forecast.ts               pure: percentiles from history
hooks/history.ts                record and load jsonl
hooks/checks.ts                 convention checks
hooks/ui.tsx                    status line, band, pane
hooks/*.test.ts                 gate, forecast, checks, election (claim mocked)
scripts/sampler.ps1             loop: CIM + registry + docker, write snapshot atomically, fencing
scripts/claim.ps1               CreateNew epoch claim; prints won/lost
types/index.d.ts                $.state contract
docs/design.md                  this file
```

Scripts run in place: `pwsh -NoProfile -NonInteractive -File <plugin root>/scripts/x.ps1`. Never pass a multi-line `-Command`, because it fails silently (found in the spike).

`$` stays in `register.ts`: the validator follows `$` only within one file, never across an import. The other modules get an `Io` port (closures over `$`) from `register.ts`, which also lets tests drive them with fakes.

**Reach:**
- `$.process` runs pwsh and docker, both read-only, except for files under `~/.claude/clearance/`.
- `$.fs` reads `~/.claude/sessions/*.json` (**never** `*.key`), project config files for the checks, and its own dir.
- `$.ui`, `$.tool`, `$.command`, `$.clock`, `$.session`, `$.env.get('USERPROFILE')`.
- No `$.http`.

## Build order

1. **Backbone:** `paths`, `snapshot` schema, `sampler.ps1` (machine and sessions only), `claim.ps1` and `scribe`. Done when the status line shows live numbers in two sessions, and killing the scribe's session moves the scribe role within 30 s.
2. **Presence and gate:** `presence`, `gate` and its tests, then the status line and band.
3. **Admission:** the spawn gate, the SubagentStart budget, the headroom tool and the session-start dialog.
4. **Pane** with the census table.
5. **History and forecast.**
6. **Docker attribution and convention checks.**
7. **THRASH** detection.

Each step is validated, tested and committed on its own.

## Build findings (2026-10-04, Claude Code 2.1.286)

### Step 1

- **No CIM in the sampler.** Under a CLI session, a pwsh child (the Store build in `C:\Program Files\WindowsApps`) is denied loading `Microsoft.Management.Infrastructure.Native.Unmanaged.DLL` (E_ACCESSDENIED), so every `Get-CimInstance` fails. The sampler now uses `GlobalMemoryStatusEx`, one Toolhelp snapshot for parent pids, and `Process.GetProcesses()` for private bytes (compiled once with `Add-Type`): 60–250 ms per sample against 560–830 ms with CIM, and a first snapshot 3–4 s after start.
- **CLI sessions are in the registry** (`~/.claude/sessions/<pid>.json`, `entrypoint: "cli"`).
- **Failover, measured:** a scribe killed with `taskkill /F` had its registry entry removed; the other session claimed the next epoch 11.8 s after the kill, and its snapshot was fresh within one interval. The killed scribe's sampler exited on its owner check.
- **Resign:** after `resigned-<n>`, the next claim lands within one watchdog tick (about 1–2 s, claim included).

### Step 2

- **Status line** shows the settled state: `clearance ✓ 3.1 GB · 2 more` (headroom, and how many more sessions fit) or `clearance ■ HOLD 0.4 GB`. Hysteresis advances once per sample (`snapshot.t`), not per tick.
- **Band** (`AbovePrompt`) draws from `$.state` `clearance.band`; while HOLD clears (one sample of CLEARED seen) it stays up and says so. Verified live with `minFreeGB: 64` in a CLI peer: the status line read `clearance ■ HOLD 0.0 GB` and the band listed both reasons (floor, and 6 sessions at a ceiling of 6).
- **Tests:** the `claude plugin test` engine exposes events only (no `$.state`), so the HOLD drawing is covered live; the cleared case is a mount test on terminal and desktop. A hook may not shadow `next` (validator).
- **Session ceiling semantics:** the gate asks for one more session, so 6 sessions at a ceiling of 6 is HOLD; the count includes sessions without the mod (from the registry).

### Step 3

- **Spawn gate:** `agent.spawn` gates with the forecast (0.3 GB until step 5's history) and this session's live reservations; over the cap it answers `{ deny }` with the forecast, the headroom, the reasons, how many fit, and the ways out. Under it, the memory is reserved (keyed by `tool_use_id`, renamed to the `agentId` the spawn returns) before `next`. Without a fresh snapshot the spawn is allowed: a missing census must not block work.
- **In flight** counts this session's subagents as they are now, not as last sampled, so a burst of spawns between samples meets the ceiling.
- **Budget line** reaches every subagent through `classic.SubagentStart` `additionalContext`.
- **Headroom tool** `mcp__clearance__headroom` `{ subagentType?, count? }`: census, per-session table, what fits. The tool's arguments arrive at the top level of `tool.call`'s input, beside `tool`.
- **Session-start dialog:** once per session (a `$.state` flag survives hot reloads), on the first fresh snapshot, gating the snapshot with this session's own row and memory taken off. On HOLD an unawaited `$.ui.ask` offers Divert (a system notice with the steps), Wait (a toast once the shown state is CLEARED) or Start anyway.
- **Validator:** a function `$` is passed to must be declared at the top of the module (not a closure inside `register`); the hooks share state through a `ctx` object.
- **Live checks pending:** a spawn denial and the dialog need a logged-in session running this code (the CLI peer used for steps 1–2 is not logged in). Unit tests cover the decisions and texts.

### Step 4

- **Pane `/clearance`:** `$.command.register` plus a `command.run` hook opens it; the `Pane` render hook lays out `$.state` `clearance.pane` (rebuilt every sample by the pure `paneModel`) to `bodyColumns`: the state and reasons, a machine line, a counts line (sessions, subagents, reserved, sample age, epoch, scribe), then one row per session sorted by memory (session, folder, self, children, subagents, last progress, largest child). Desktop-app and Docker rows, unattributed containers and the checks join in step 6.
- **Tests:** beneath the plugin, a test answers a `$` call's event with `{ value }` (`on('ui.open', () => ({ value: { isPlaced: true } }))`, likewise `clock.now`); the pane mount test runs on terminal and desktop.
- **Live check pending:** opening the pane needs a typed `/clearance` in a session on this code.

## Open questions

- **Divert actions in v0.1:** copyable steps only, or also use the Desktop app's own "move to cloud" when the session runs there? Proposal: steps only, because a mod can't call the app's tools.
- **Threshold defaults:** the table above is a guess from one day of measurements. Tune them after a week of history.
