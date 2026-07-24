---
title: "Pi Bridge v0.1.1"
doc_type: "release"
status: "approved"
owner: "user"
source: "github"
created: "2026-07-24"
updated: "2026-07-24"
related_issue: ""
related_pr: ""
supersedes: ""
---

## Pi Bridge v0.1.1

### Summary

Pi Bridge v0.1.1 is the first public Git-only release. It connects Pi to an
existing Claude-mem 13.11.0 or newer worker without managing the worker
process or installation.

### Included

- Deterministic runtime discovery and multi-worker selection.
- Pi-scoped recall, observation capture, and session summarization.
- Shared status, doctor, and confirmed smoke-test diagnostics.
- Git installation and CLI setup documentation.
- Automated lifecycle, failure, redaction, timeout, and diagnostics coverage.

### Validation

- `bun test`: 43 tests passed.
- `bun run typecheck`: passed with TypeScript 5.9.3.
- The real Git-only operator workflow is recorded in
  `docs/06_testing/test-20260723-git-operator-workflow.md`.

### Distribution

Install from GitHub:

```bash
pi install git:github.com/proletariat64/pi-bridge
```

This release is not published to npm. Pi Bridge does not install, start,
repair, stop, or reconfigure Claude-mem.
