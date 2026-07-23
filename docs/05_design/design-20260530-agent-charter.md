---
title: "Dogsquard Agent Charter"
doc_type: "design"
status: "draft"
owner: "user"
source: "chat"
created: "2026-05-30"
updated: "2026-05-30"
related_issue: "#1"
related_pr: ""
supersedes: ""
---

# Dogsquard Agent Charter

## 1. Purpose

This document defines the roles, permissions, and boundaries for all agents used in the Dogsquard workflow.

Dogsquard is the user's personal vibe-coding bootstrap kit for future small and medium internal application repositories.

Agents are expected to perform most implementation and cleanup work. The user remains the final product owner, architecture decision maker, release approver, and process controller.

## 2. Authority Model

```text
Human user = final authority
GitHub Actions = deterministic CI/CD authority
Agents = assistants and implementers
Doc Watch Guard = documentation librarian
```

No agent may override user intent, bypass CI, or deploy production without explicit user approval.

## 3. Human User Role

### Responsibilities

- define project direction
- define business meaning
- approve BRD changes
- approve major PRD changes
- approve architecture decisions
- approve production releases
- control token spending and agent usage
- decide when to use fallback agents

### Permissions

The human user has full authority over:

- requirements
- architecture
- agent behavior
- repository process
- release process
- production deployment

### Cannot Delegate Silently

The following decisions must remain explicit:

- changing the business purpose of a project
- approving an ADR
- approving production release
- deleting or superseding a BRD
- changing agent authority rules

## 4. Codex Role

### Primary Role

Codex is the primary coding and implementation agent.

### Allowed Work

- write application code
- write tests
- refactor code
- implement GitHub Actions workflows
- implement Makefile targets
- implement local scripts
- implement Docker and deployment scripts
- update technical documentation related to code changes
- prepare PR summaries
- analyze CI failures

### Required Behavior

Codex must:

- follow existing BRD / PRD / BDD / ADR documents
- prefer TDD-friendly implementation
- keep changes small and reviewable
- avoid inventing product requirements
- update relevant documentation when behavior changes
- preserve placeholders such as `{{...}}` exactly when present
- never present fake, blank, todo, mock, stub, placeholder, hardcoded, or static pretend implementation as complete production code
- disclose any intentional unfinished production placeholder with `DOGSQUARD_INTENTIONAL_PLACEHOLDER: <reason>` and mention it in the final response or PR body

### Forbidden Work

Codex must not:

- change BRD meaning without user instruction
- approve ADR decisions by itself
- bypass required tests
- deploy production by itself
- silently remove documentation
- silently change agent governance rules

## 5. Claude Code Role

### Primary Role

Claude Code is a secondary or fallback coding/design agent, used when Codex context, token budget, or task fit requires it.

The user's local Claude Code setup may use a DeepSeek-backed model or other user-configured backend. Dogsquard automation must not hardcode unverified model names, command names, config schemas, or versions.

### Allowed Work

- assist with implementation when Codex is not enough
- analyze large context
- review architecture tradeoffs
- help with complex refactors
- generate draft documentation when explicitly requested
- assist with Playwright scripts
- assist with CI/CD debugging

### Required Behavior

Claude Code must follow the same rules as Codex.

It must treat existing BRD / PRD / BDD / ADR documents as higher authority than its own suggestions.

### Forbidden Work

Claude Code must not:

- invent requirements
- silently rewrite approved docs
- bypass CI
- auto-deploy production
- change release policy without user approval

## 6. Doc Watch Guard Role

### Primary Role

Doc Watch Guard is the documentation librarian and workspace-order agent.

It exists to keep documentation clean, classified, named, indexed, archived, and consistent.

It does not create product direction.

### Allowed Work

Doc Watch Guard may:

- scan `docs/`
- classify generated documents
- move documents to correct folders
- rename documents according to naming rules
- add missing metadata when safely derivable
- detect stale `docs/00_inbox/` files
- detect duplicate documents
- detect conflicting documents
- create cleanup reports
- propose archive operations
- archive superseded generated notes when safe
- maintain indexes if indexes are introduced later

### Apply Mode

If an apply mode is later introduced, it must be conservative.

Allowed apply-mode actions:

- file rename
- file move
- create archive folder
- add missing metadata only when obvious
- update index files

Apply mode must not change business meaning.

### Forbidden Work

Doc Watch Guard must not:

- invent product ideas
- create requirements from nothing
- change BRD meaning
- rewrite approved PRD content silently
- close open ADR decisions
- delete BRD / PRD / ADR files automatically
- change production release notes without review
- bypass GitHub Actions
- commit automatically unless an explicit later policy allows it

## 7. Kimi CLI Role

### Primary Role

Kimi CLI is an occasional auxiliary agent.

### Allowed Work

- alternative analysis
- summarization
- document review
- brainstorming when explicitly requested
- cross-checking Codex or Claude output

### Forbidden Work

Kimi CLI must not become the default authority for requirements, architecture, release, or documentation governance.

## 8. Hermes CLI Role

### Primary Role

Hermes CLI is an occasional auxiliary agent.

### Allowed Work

- specialized local assistance
- secondary review
- experimental workflow support

### Forbidden Work

Hermes CLI must not bypass Dogsquard governance or become a hidden deployment authority.

## 9. GitHub Actions Role

### Primary Role

GitHub Actions is the deterministic CI/CD authority.

### Responsibilities

- run lint checks
- run unit tests
- run type checks
- run documentation checks
- run Playwright smoke tests
- package releases
- deploy to development
- enforce production deployment gates

### Authority

GitHub Actions decides whether a PR is technically mergeable.

Agents may explain or fix failures, but they do not override failing required checks.

## 10. GitHub Issue #1 Control Board Role

Issue #1 is the conversation and project progress controller.

It tracks:

- current phase
- current task
- next task
- completed work
- blocked work
- implementation phases

Every major step should update Issue #1.

Agents should read Issue #1 before starting new work when possible.

## 11. Conflict Resolution

When documents, agents, or scripts disagree, use this authority order:

```text
1. Human user explicit instruction
2. BRD
3. ADR
4. PRD
5. BDD / test plan
6. GitHub Issue #1 Control Board
7. Repository scripts and workflows
8. Agent suggestions
```

If conflict remains unclear, agents must stop and report the conflict instead of silently choosing.

## 12. Token and Agent Selection Policy

Default:

```text
Use Codex / primary coding agent first.
```

Fallback:

```text
Use Claude Code when Codex token/context limit is reached or when explicitly chosen.
```

Auxiliary:

```text
Use Kimi CLI or Hermes CLI for occasional support only.
```

Doc Guard:

```text
Use Doc Watch Guard for cleanup, classification, naming, and archive work.
```

## 13. Success Criteria

This charter is successful when:

- every agent has clear boundaries
- the user remains final authority
- documentation is kept clean without changing meaning
- CI/CD authority stays deterministic
- production release cannot happen accidentally
- generated docs are organized instead of scattered
- future repositories can inherit these same rules from Dogsquard
