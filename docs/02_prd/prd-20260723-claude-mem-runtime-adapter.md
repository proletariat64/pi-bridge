---
title: "Claude-Mem Runtime Adapter for Pi"
doc_type: "prd"
status: "draft"
owner: "user"
source: "chat"
created: "2026-07-23"
updated: "2026-07-23"
related_issue: "#1"
related_pr: ""
supersedes: ""
---

<!-- markdownlint-disable MD013 MD025 -->

# Claude-Mem Runtime Adapter for Pi

## 1. Purpose

Pi Bridge connects Pi agent lifecycle events to an existing Claude-mem runtime. It gives Pi the same memory capture and automatic recall behavior that Claude-mem provides for Claude Code and Codex, without creating or managing another memory service.

The bridge is installed separately after Claude-mem is installed. It discovers Claude-mem runtime configuration, selects a configured worker, checks compatibility, and communicates directly with the existing worker HTTP API.

## 2. Goals

- Install Pi Bridge independently after Claude-mem.
- Reuse an existing Claude-mem worker, server, database, and runtime configuration.
- Match the lifecycle behavior and platform isolation of Claude-mem's built-in Claude and Codex integrations.
- Discover worker host and port from Claude-mem configuration instead of duplicating endpoint configuration.
- Support deterministic selection when a host has multiple Claude-mem workers.
- Provide read-only diagnostics through Pi and a terminal CLI.
- Provide a confirmed, bounded end-to-end smoke test.
- Degrade gracefully when memory is unavailable so normal Pi work continues.

## 3. Non-Goals

Pi Bridge must not:

- install, initialize, repair, start, stop, or restart Claude-mem
- create a worker, server, database, or memory store
- manage Claude-mem credentials
- implement a second memory protocol or storage layer
- automatically fall back to a different worker
- automatically share memories across agent platforms
- provide separate write and recall toggles in v1
- wait for model-generated compression or search readback during its quick smoke test

## 4. Installation and Distribution

The initial release is Git-only:

```bash
pi install git:github.com/proletariat64/pi-bridge
```

Pi package configuration is the master enable or disable control, matching Claude-mem's built-in agent integrations.

The package also contains an executable terminal CLI. Users explicitly link that executable into `~/.local/bin`; installation must not modify `PATH` implicitly.

The package requires:

- Pi 0.81.1 or newer
- Claude-mem 13.11.0 or newer
- an existing Claude-mem data directory and configuration
- an existing Claude-mem worker when memory features or runtime tests are used

## 5. Configuration

### 5.1 Location

Pi Bridge uses one user-level configuration file:

```text
~/.pi/agent/claude-mem-bridge.json
```

The bridge creates a safe default atomically on first start if the file does not exist:

```json
{
  "version": 1,
  "activeWorker": "",
  "workers": {
    "default": {}
  }
}
```

An existing configuration file must never be silently rewritten.

### 5.2 Worker entries

Workers are named entries that refer to Claude-mem data directories. They do not duplicate worker URLs.

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

For the default worker, an omitted `dataDir` resolves in this order:

1. `CLAUDE_MEM_DATA_DIR`
2. `~/.claude-mem`

A named worker with `dataDir` reads `<dataDir>/settings.json`.

### 5.3 Endpoint precedence

The selected endpoint follows Claude-mem's own precedence:

1. `CLAUDE_MEM_WORKER_HOST` and `CLAUDE_MEM_WORKER_PORT`
2. selected data directory's `settings.json`
3. Claude-mem defaults

Diagnostics must report both the resolved values and their sources. Environment host and port overrides apply even when a named non-default worker is selected.

### 5.4 Invalid configuration

Malformed configuration, an unsupported schema version, or an unknown worker name disables the bridge for that run. The bridge must:

- preserve the invalid file unchanged
- avoid guessing or falling back
- explain the failure
- direct the user to the doctor command
- allow normal Pi work to continue without memory

## 6. Worker Selection

Selection rules are deterministic:

1. If `activeWorker` names a worker, use exactly that worker.
2. If `activeWorker` is empty and one worker exists, select it automatically.
3. If `activeWorker` is empty and multiple workers exist in Pi's interactive TUI, prompt the user at startup.
4. The interactive menu may select any configured worker; health and compatibility are checked after selection.
5. The interactive choice applies only to the current Pi process and is not written to configuration.
6. If selection is ambiguous without an interactive UI, disable the bridge for that run.
7. If an explicitly selected worker is unavailable or incompatible, disable the bridge for that run without fallback.
8. Terminal commands require `--worker <name>` when selection is ambiguous.

The bridge must never select the first configured or first healthy worker merely because interaction is unavailable.

## 7. Claude-Mem Compatibility

### 7.1 Version policy

Claude-mem 13.11.0 is the minimum supported version. The worker health response must contain a parseable version. A missing, invalid, or older version is incompatible and disables memory operations for that run.

Compatibility is enforced by both:

- the minimum version gate
- capability checks against the worker endpoints used by Pi Bridge

### 7.2 Runtime ownership

Pi Bridge communicates with the selected worker using direct HTTP. It must not invoke Claude-mem worker lifecycle commands or execute Claude-mem hook adapters.

### 7.3 Required endpoints

```text
GET  /api/health
POST /api/sessions/init
GET  /api/context/inject
POST /api/sessions/observations
POST /api/sessions/summarize
```

Pi Bridge must not call `/api/sessions/complete`.

## 8. Memory Behavior

### 8.1 Platform isolation

Pi Bridge must match Claude-mem's built-in agent integrations:

- every Pi session, observation, summary, and context request uses `platformSource: "pi"`
- automatic context injection filters to `platformSource=pi`
- Pi, Claude, and Codex may use the same worker and database while automatic recall remains isolated by platform
- cross-agent automatic recall is not part of v1

### 8.2 Project identity

Pi Bridge must replicate Claude-mem's repository and Git worktree project naming algorithm. A normal repository uses its project name. A worktree uses the parent project plus the composite `parent/worktree` project chain so Pi behaves consistently with Claude and Codex.

### 8.3 Lifecycle mapping

| Pi lifecycle | Bridge behavior |
| --- | --- |
| Session start or resume | Restore stable bridge session identity and selected worker state. |
| Before agent start | Check the worker, initialize with the real prompt, and inject Pi-scoped context. |
| Tool execution | Capture completed tool results in completion order, including failures. |
| Compaction | Flush pending observations and request a summary without changing the stable session identity. |
| Session shutdown | Flush pending observations, then request at most one final summary within a bounded deadline. |

The bridge must preserve ordered and idempotent observation delivery, redact sensitive fields, bound payload size, and skip recursive Claude-mem tool observations.

### 8.4 Failure isolation

Worker requests use short, bounded timeouts and structured failures. An unavailable or incompatible worker must not block prompts, tools, shutdown, or ordinary Pi operation.

## 9. Commands

### 9.1 Pi commands

```text
/claude-mem-status
/claude-mem-doctor
/claude-mem-smoke-test
```

The existing session toggle is removed. Users enable or disable the installed integration through Pi package configuration.

### 9.2 Terminal CLI

```text
pi-claude-mem status
pi-claude-mem doctor
pi-claude-mem smoke-test [--worker NAME] [--yes]
```

Pi commands and CLI commands share the same underlying configuration, selection, diagnostic, and smoke-test implementation.

## 10. Status

Status reports at least:

- whether the bridge is active for the current run
- configuration path
- selected worker name and data directory
- resolved worker URL
- worker health and version when reachable
- current Pi content session identity when running inside Pi
- failure or disabled reason

Status is observational and must not mutate either Pi Bridge or Claude-mem.

## 11. Doctor

Doctor is read-only. It checks:

- bridge configuration existence and schema
- Pi package registration
- Claude-mem data directory and settings file
- worker selection and ambiguity
- resolved host, port, and value sources
- duplicate resolved endpoints across configured workers
- worker health response
- parseable worker version and minimum-version compliance
- compatibility of required worker API behavior

Doctor must not repair configuration or manage Claude-mem. It prints actionable remediation.

The terminal doctor exits nonzero when a required check fails, including an unreachable selected worker. The Pi extension itself continues to degrade gracefully rather than stopping the agent.

## 12. Smoke Test

The smoke test requires explicit confirmation because it creates persistent Claude-mem records. The CLI accepts `--yes` as explicit confirmation for automation.

The test:

1. resolves and validates the selected worker
2. verifies health and minimum version
3. creates a UUID content session under reserved project `__pi_bridge_smoke__`
4. initializes the session with a fixed harmless test prompt
5. calls context injection for the reserved project
6. submits one fixed, clearly marked harmless observation
7. requests a session summary
8. verifies that each lifecycle request was accepted within bounded timeouts

The test does not wait for AI compression or search readback. Claude-mem has no session-delete API, so test records remain permanently but isolated under the reserved project.

## 13. Security and Privacy

- Configuration stores data-directory references, not credentials.
- Pi Bridge does not introduce a credential-management layer.
- Tool payloads retain recursive secret-key redaction and binary omission.
- Tool inputs and outputs remain bounded before transmission.
- No project-local configuration may redirect the bridge to a different worker.
- Invalid or ambiguous selection fails closed.
- Cross-platform automatic recall remains disabled through source scoping.

## 14. Acceptance Criteria

### Installation and boundaries

- Pi Bridge installs with `pi install git:github.com/proletariat64/pi-bridge` after Claude-mem.
- The package loads without creating or starting any worker, server, or database.
- A separately linked Git-package CLI provides the documented terminal commands.
- Pi package configuration enables and disables the whole integration.

### Configuration and selection

- First start creates the versioned safe default user configuration.
- The default worker honors `CLAUDE_MEM_DATA_DIR` and Claude-mem endpoint precedence.
- Named data directories resolve their Claude-mem settings.
- Explicit worker selection never falls back.
- One unnamed candidate auto-selects; multiple candidates prompt only with an interactive UI.
- Ambiguous headless operation disables the bridge instead of guessing.
- Invalid configuration is preserved and fails closed.

### Compatibility

- Workers older than 13.11.0 are rejected.
- Missing or unparseable worker versions are rejected.
- Required endpoint incompatibility is reported before normal memory capture proceeds.
- An unavailable worker does not prevent normal Pi work.

### Memory behavior

- All automatic writes and recall use `platformSource=pi`.
- Pi does not automatically recall Claude or Codex memories.
- Project and worktree naming matches Claude-mem.
- Session identity, observation order, idempotency, privacy redaction, bounded payloads, and exactly-once finalization remain covered by tests.

### Operations

- Status is non-mutating and reports selected runtime details.
- Doctor is read-only, actionable, and returns meaningful exit status.
- Smoke test requires confirmation, uses the reserved project, and verifies lifecycle acceptance.
- Automated tests prove that no code path spawns or manages a Claude-mem process.

## 15. Test Scope

Automated tests must cover:

- default configuration creation and atomicity
- configuration parsing, schema versions, and preservation on error
- environment, settings, and default precedence
- tilde and data-directory resolution
- single-worker, multi-worker, explicit, interactive, and headless selection
- explicit-worker no-fallback behavior
- duplicate endpoint diagnostics
- health version parsing and semantic comparison
- minimum-version and unknown-version failures
- normal repository and Git worktree project naming
- Pi-only source scoping across every request
- lifecycle request ordering and timeouts
- graceful degradation
- doctor check results and process exit codes
- smoke-test confirmation, `--yes`, reserved project, and lifecycle payloads
- absence of worker/server process spawning

## 16. Release Readiness

The feature is ready for release when:

- all acceptance criteria have automated coverage where practical
- `bun test` passes
- documentation describes install, configuration, worker selection, doctor, smoke test, and uninstall
- a manual test against Claude-mem 13.11.0 confirms status, doctor, Pi-scoped recall, capture, and smoke-test behavior
- GitHub Actions remains the deterministic quality authority
