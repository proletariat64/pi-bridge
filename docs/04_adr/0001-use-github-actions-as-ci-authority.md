---
title: "Use GitHub Actions as CI Authority"
doc_type: "adr"
status: "draft"
owner: "coding-agent"
source: "agent"
created: "2026-05-30"
updated: "2026-05-30"
related_issue: "#1"
related_pr: ""
supersedes: ""
---

# ADR 0001: Use GitHub Actions as CI Authority

## Status

Draft

## Context

Dogsquard is a reusable bootstrap kit for future small and medium internal application repositories.

The project is expected to support agent-heavy implementation, document-driven development, strict PR checks, strict release rules, TDD-friendly coding, and near one-click release after setup.

The user's fixed environment is:

- Ubuntu desktop workstation
- two Unix cloud servers
- GitHub repositories
- future services exposed through HTTPS paths such as `https://proletariat.icu/xxxxx`

Agents are important assistants, but their behavior can vary by prompt, context, available tools, token budget, backend, and local configuration. Dogsquard needs one deterministic authority for CI/CD decisions.

## Decision

Use GitHub Actions as the deterministic CI/CD authority for Dogsquard and repositories initialized from Dogsquard.

GitHub Actions will become responsible for official PR quality checks, documentation gates, build checks, release checks, and deployment gates once those workflows are introduced.

Production deployment must require explicit approval. Normal PRs and ordinary merges must not deploy production automatically.

## Consequences

Positive consequences:

- PR checks can be enforced consistently.
- CI results are visible in GitHub review.
- Agents can fix failures but cannot redefine pass/fail status.
- Release and deployment history can be traced.
- Production approval can be tied to GitHub environment controls.

Tradeoffs:

- CI/CD behavior depends on GitHub availability.
- Workflow changes must be reviewed carefully because they affect project authority.
- Local checks remain useful but are not the final merge authority.

## Alternatives Considered

### Local workstation scripts as final authority

Rejected as final authority. Local scripts are useful for fast feedback, but they depend on workstation state and are easier to bypass accidentally.

### Agent judgment as final authority

Rejected. Agents are assistants and implementers, not deterministic governance systems. They may summarize, propose, code, test, and debug, but they must not decide that a failing check is acceptable.

### Cloud server as main CI runner from the start

Rejected for the initial phase. The cloud servers should first be deployment targets, not the default place where all PR code executes.

### Self-hosted runner first

Rejected for initial CI. Self-hosted runners add operational and security complexity before Dogsquard has enough workload to justify them.

## Why Agents Are Not Final Authority

Agents can produce useful implementation and review work, but they are not stable enough to serve as final CI/CD authority.

Reasons:

- prompts and context can change
- local tool availability can change
- backend model configuration can change
- agents can miss hidden project rules
- agents cannot replace explicit production approval

Agents may help interpret CI results, but GitHub Actions owns deterministic pass/fail status.

## Why GitHub-Hosted Runners Are Used First

GitHub-hosted runners are the default starting point because they provide repeatable infrastructure without requiring the user to maintain runner hosts immediately.

Initial GitHub-hosted runner scope:

- lint checks
- unit tests
- type checks
- documentation checks
- build checks
- PR smoke checks
- release packaging

## When a Self-Hosted Runner May Be Introduced

A self-hosted runner may be introduced later if GitHub-hosted runners are not enough.

Valid reasons include:

- heavy Playwright UAT
- private network verification
- server-local deployment verification
- Docker cache needs
- trusted branch integration tests that require local infrastructure

Self-hosted runners must not run untrusted public PR code.

## Production Deployment Approval

Production deployment must require explicit approval.

Acceptable production gates may include:

- GitHub Environment required reviewers
- manual workflow dispatch with reviewed inputs
- version tag based release with approval

Agents may prepare release notes and deployment scripts, but they must not approve or trigger production deployment without explicit user authorization.

