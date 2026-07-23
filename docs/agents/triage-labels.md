---
title: "Agent Triage Label Rules"
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

# Triage Labels

Engineering skills use five canonical triage roles. This file maps those roles to the label strings used in this repository's GitHub issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a canonical role, apply the corresponding GitHub label from this table.

Edit the right-hand column if this repository adopts different label vocabulary.
