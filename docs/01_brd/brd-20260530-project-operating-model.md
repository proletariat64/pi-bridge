---
title: "Dogsquard Project Operating Model"
doc_type: "brd"
status: "draft"
owner: "user"
source: "chat"
created: "2026-05-30"
updated: "2026-05-30"
related_issue: "#1"
related_pr: ""
supersedes: ""
---

# Dogsquard Project Operating Model

## 1. Purpose

`dogsquard` is the user's reusable vibe-coding bootstrap kit for future small and medium internal application repositories.

It is not primarily a business product. It is a personal project initialization system.

The expected workflow is:

```text
User manually creates a new GitHub repository
  -> apply Dogsquard initialization kit
  -> run basic validation
  -> confirm docs, agents, local commands, CI/CD, and deployment setup work
  -> begin real project development
```

## 2. Target Projects

Dogsquard targets internal full-stack applications, usually with:

- frontend dashboard
- form input
- data table
- CRUD workflow
- Go backend API
- JS/TS frontend
- automated tests
- GitHub-based delivery

Dogsquard should eventually contain a small example project proving that the template works for a realistic internal application.

## 3. Fixed Environment

The user's standard environment is:

```text
Local:
  Ubuntu desktop workstation

Cloud:
  Two Unix cloud servers
  Domains and SSL available
  Services exposed under HTTPS paths such as https://proletariat.icu/xxxxx

Source control:
  GitHub repositories
```

Dogsquard should optimize for this environment instead of trying to be a generic universal framework.

## 4. Agent Stack

Primary agents:

- Codex
- Claude Code with user-configured DeepSeek backend when available

Auxiliary agents:

- Kimi CLI
- Hermes CLI

Agents are expected to perform almost all coding and repetitive implementation work.

The user remains responsible for design, review, process control, and token allocation.

## 5. Development Method

Dogsquard must support:

- GitHub Issue driven work
- SDD / document-driven development
- PRD / DDD / BDD guided implementation
- TDD-friendly coding
- strict PR checks
- strict release rules
- agent-heavy implementation
- human-controlled decisions

## 6. Success Criteria

Dogsquard succeeds when:

- one person can maintain it
- agents perform nearly all coding work
- the user controls design and process
- PR checks are automatic and strict
- tests are consistently enforced
- releases are controlled and repeatable
- new repositories can be initialized from Dogsquard
- deployment becomes one-click or near one-click after setup
- documentation never becomes chaotic

## 7. Non-Goals

Dogsquard should not become:

- a public SaaS product
- a generic framework for every developer
- an autonomous production deployer
- a replacement for GitHub
- a system where agents invent business meaning without the user

## 8. Final Authority

The human user is the final product owner and decision maker.

Agents may propose, draft, clean, test, and implement.

Only the user can approve business meaning, major architecture decisions, production releases, and agent governance changes.
