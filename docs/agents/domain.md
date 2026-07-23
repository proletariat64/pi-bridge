---
title: "Agent Domain Documentation Rules"
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

# Domain docs

How engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root, when it exists.
- Relevant ADRs under `docs/04_adr/`.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The domain-modeling skill creates them lazily when terms or decisions are resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   └── 04_adr/
│       └── 0001-example-decision.md
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept—for example in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Avoid synonyms the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the repository already uses another term; otherwise note the gap for domain modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, state it explicitly rather than silently overriding it.
