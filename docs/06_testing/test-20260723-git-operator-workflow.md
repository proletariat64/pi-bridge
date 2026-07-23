---
title: "Git-only operator workflow release check"
doc_type: "test"
status: "draft"
owner: "coding-agent"
source: "github"
created: "2026-07-23"
updated: "2026-07-23"
related_issue: "https://github.com/proletariat64/pi-bridge/issues/5"
related_pr: ""
supersedes: ""
---

# Git-only Operator Workflow Release Check

## Purpose

Validate the packaged workflow against an already-running Claude-mem 13.11.0
or newer worker. This check must never install, create, start, repair, stop, or
reconfigure Claude-mem.

## Preconditions

- Pi 0.81.1 or newer and Bun are available.
- A supported Claude-mem worker is already healthy.
- Its data directory and any required API key are known.
- The test repository contains prior Pi-scoped memory suitable for recall.

## Procedure

1. Install with `pi install git:github.com/proletariat64/pi-bridge`.
2. Link the packaged CLI exactly as documented in `README.md`.
3. Start Pi once and inspect the atomically created user configuration.
4. Configure/select the existing worker without changing Claude-mem settings.
5. Run `pi-claude-mem status` and `pi-claude-mem doctor`.
6. In Pi, send a distinctive prompt, verify Pi-only recalled context, complete
   a harmless tool call, and exit normally to request the final summary.
7. Run `pi-claude-mem smoke-test --yes` and record its unique session ID.
8. Disable through `pi config`, then verify ordinary Pi use sends no memory
   traffic. Re-enable it before completing the release check.

## Evidence

Record the Pi and Claude-mem versions, selected worker and endpoint provenance,
status/doctor outcomes, recall/capture/summary evidence, smoke session ID, and
confirmation that no Claude-mem management action occurred. Do not record API
keys, prompts containing secrets, or memory contents.

### 2026-07-23 package staging

- Pi 0.81.1 installed the Git source into the documented
  `~/.pi/agent/git/github.com/proletariat64/pi-bridge` path in an isolated home.
- The packaged `bin/pi-claude-mem.ts` was present and executable; the explicit
  `~/.local/bin/pi-claude-mem` symlink ran `status` successfully when Bun was on
  `PATH`.
- Status correctly reported missing configuration without creating it.
- `pi remove git:github.com/proletariat64/pi-bridge` removed the isolated clone.
- `npm pack --dry-run` also included the CLI with mode `0755`.

Real-worker run: blocked. The available Claude-mem checkout is version 13.11.0,
but no worker was listening on its configured `127.0.0.1:37700` endpoint or the
UID-derived default during implementation. No Claude-mem process-management
action was attempted. An already-running supported worker is required before
this document can be marked complete.
