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
- claude-mem with its local worker running
- Bun to run the test suite

Install claude-mem first if needed:

```bash
npx claude-mem install
curl -fsS http://127.0.0.1:37700/api/health
```

The bridge defaults to `http://127.0.0.1:37700`. If your worker uses another
port, set its complete base URL before starting Pi:

```bash
export CLAUDE_MEM_WORKER_URL=http://127.0.0.1:38000
```

## Install

Install directly from GitHub with Pi's package manager:

```bash
pi install git:github.com/proletariat64/pi-bridge
```

Restart Pi after installation, then check the connection:

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

## How It Works

```text
Pi lifecycle events
       |
       v
pi-bridge (HTTP client, short timeouts, non-throwing failures)
       |
       v
claude-mem worker at 127.0.0.1:37700
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

- `/claude-mem-status` checks whether the worker is reachable and reports the
  current bridge state.
- `/claude-mem-toggle` enables or disables capture for the current Pi session.

Set `CLAUDE_MEM_PI_ENABLED=false` before launching Pi to enforce the privacy
kill switch. A session command cannot override that environment setting.

If the worker requires an API key, set it without placing the secret in Pi's
configuration files:

```bash
export CLAUDE_MEM_API_KEY=your-key
```

## Development

```bash
bun test
```

The tests cover lifecycle ordering, stable IDs, reload and fork behavior,
failed tools, duplicate prevention, privacy toggles, timeout handling,
redaction, truncation, and exactly-once finalization.

## License

Apache-2.0. The bridge was extracted from the claude-mem project and retains
its license.
