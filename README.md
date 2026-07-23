# Pi Bridge for claude-mem

A native [Pi](https://github.com/earendil-works/pi) extension that connects Pi's
session and tool lifecycle to a local [claude-mem](https://github.com/thedotmack/claude-mem)
worker.

The bridge does not run a second memory service. Claude Code, Codex, and Pi can
all send events to one claude-mem worker and its SQLite store. Each client still
has its own session identity and `platformSource`; this bridge always records Pi
sessions as `pi`.

## Requirements

- Pi 0.81.1 or newer
- Claude-mem 13.11.0 or newer, already installed and managed separately
- an existing Claude-mem worker when memory operations are used
- Bun to run the test suite or the terminal command

Pi Bridge is only an HTTP adapter. It never installs, creates, starts, repairs,
restarts, stops, or otherwise manages Claude-mem, its worker, server, database,
or credentials.

## Install

Install directly from GitHub with Pi's package manager:

```bash
pi install git:github.com/proletariat64/pi-bridge
```

Restart Pi after installation. Loading the package is the only bridge enable
control. On first load, the bridge atomically creates its safe user
configuration if it does not already exist. Check the selected runtime with:

```text
/claude-mem-status
```

For a local checkout, either load the entry point for one invocation:

```bash
pi --no-extensions -e ~/dev/pi-bridge/index.ts
```

Or install it globally with a symlink:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn ~/dev/pi-bridge ~/.pi/agent/extensions/claude-mem
```

Pi discovers the repository through the `pi.extensions` entry in
`package.json`. The extension has no runtime npm dependencies.

The Git package also includes `bin/pi-claude-mem.ts`. Linking the terminal
command is deliberately explicit; installation does not edit `PATH` or shell
startup files. For a checkout, for example:

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/bin/pi-claude-mem.ts" ~/.local/bin/pi-claude-mem
pi-claude-mem status
```

Pass `--worker NAME` when a terminal command must select among multiple
configured workers:

```bash
pi-claude-mem status --worker work
```

## Runtime Configuration

Pi Bridge stores one versioned user configuration at:

```text
~/.pi/agent/claude-mem-bridge.json
```

The safe first-start configuration is:

```json
{
  "version": 1,
  "activeWorker": "",
  "workers": {
    "default": {}
  }
}
```

Worker entries name Claude-mem data directories, not duplicated URLs. Named
workers must set `dataDir`; `~` is expanded against the user's home directory:

```json
{
  "version": 1,
  "activeWorker": "work",
  "workers": {
    "default": {},
    "work": {
      "dataDir": "~/.claude-mem-work"
    }
  }
}
```

For the `default` worker, an omitted data directory resolves from
`CLAUDE_MEM_DATA_DIR`, then `~/.claude-mem`. Host and port each follow
Claude-mem precedence independently:

1. `CLAUDE_MEM_WORKER_HOST` or `CLAUDE_MEM_WORKER_PORT`
2. the selected data directory's `settings.json`
3. Claude-mem defaults: `127.0.0.1` and `37700 + (UID % 100)`

Environment host and port overrides apply to every named worker, matching
Claude-mem process semantics. Status reports the resolved values and sources.
Existing configuration is never silently rewritten; malformed or unsupported
configuration is preserved and disables memory for that Pi run.

Selection is deterministic. `activeWorker` is authoritative and never falls
back. One configured worker is automatic. Multiple workers prompt only in an
interactive Pi UI, and that choice remains process-local. Ambiguous headless
operation disables memory rather than guessing; ambiguous terminal use requires
`--worker NAME`.

## How It Works

```text
Pi lifecycle events
       |
       v
pi-bridge (HTTP client, short timeouts, non-throwing failures)
       |
       v
selected existing claude-mem worker
       |
       +-- session initialization
       +-- context injection
       +-- observation generation
       +-- session summaries
       `-- SQLite / vector memory storage
```

The extension maps Pi events onto the worker API:

| Pi event | Bridge action |
| --- | --- |
| `session_start` | Restores or creates durable bridge state. It does not send a synthetic prompt. |
| `before_agent_start` | Health-checks the worker, initializes the session with the real user prompt, and injects prior Pi context. |
| `tool_execution_start` | Retains tool arguments until the matching result arrives. |
| `tool_execution_end` | Queues a completed observation, including failed tool calls. |
| `session_before_compact` | Flushes observations and summarizes while retaining the same stable session ID. |
| `session_shutdown` | Flushes pending observations and requests at most one final summary. |

The worker endpoints used are:

```text
GET  /api/health
POST /api/sessions/init
GET  /api/context/inject
POST /api/sessions/observations
POST /api/sessions/summarize
```

The bridge intentionally does not call `/api/sessions/complete`.

## Design

### Stable sessions

The claude-mem content session ID is derived from Pi's session file when one is
available, otherwise from Pi's session ID. Reloading or resuming restores the
same ID. New and forked sessions receive a new ID.

### Ordered and idempotent observations

Tool results are placed onto a single promise queue so the worker receives them
in completion order. Pi's tool call ID is forwarded as `tool_use_id`, allowing
the worker to reject duplicate deliveries. Tools whose name starts with
`claude_mem_` are skipped to avoid recording memory operations recursively.

### Failure isolation

Worker calls have short timeouts and return structured failures instead of
throwing into Pi. An unavailable worker does not block the agent. Shutdown uses
one bounded deadline: observations are flushed before summarization, and a
summary is never sent ahead of an unfinished observation queue.

### Privacy and payload bounds

Tool inputs recursively redact keys such as `apiKey`, `token`, `password`,
`authorization`, and `cookie`. Binary values are omitted. Inputs are capped at
16 KiB and tool responses at 1,000 characters before transmission.

### Source-scoped recall

All writes carry `platformSource: "pi"`, and context injection requests Pi
memories for the current project. Claude, Codex, and Pi can use the same worker
and database, but automatic recall remains separated by platform source. This
prevents one agent's history from being injected into another agent by default.

## Commands

- `/claude-mem-status` observes the current Pi run without changing selection,
  configuration, or status-bar state. It reports the configuration path,
  current worker and endpoint, value sources, health, compatible version,
  failure reason, and Pi content-session identity.
- `pi-claude-mem status [--worker NAME]` exposes the same runtime inspection at
  the terminal. It requires an explicit worker when configuration is ambiguous.

If the worker requires an API key, set it without placing the secret in Pi's
configuration files:

```bash
export CLAUDE_MEM_API_KEY=your-key
```

## Development

```bash
bun test
```

The tests cover runtime discovery, deterministic worker selection, version
gating, lifecycle ordering, stable IDs, reload and fork behavior, failed tools,
duplicate prevention, timeout handling, redaction, truncation, and exactly-once
finalization.

## License

Apache-2.0. The bridge was extracted from the claude-mem project and retains
its license.
