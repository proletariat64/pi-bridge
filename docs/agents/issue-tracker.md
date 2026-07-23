---
title: "Agent Issue Tracker Rules"
doc_type: "design"
status: "draft"
owner: "coding-agent"
source: "agent"
created: "2026-07-23"
updated: "2026-07-23"
related_issue: ""
related_pr: ""
supersedes: ""
---

<!-- markdownlint-disable MD013 MD025 -->

# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, also fetching labels when relevant.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`, with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically from this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
