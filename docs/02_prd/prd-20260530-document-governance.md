---
title: "Document Governance"
doc_type: "prd"
status: "draft"
owner: "product-agent"
source: "agent"
created: "2026-05-30"
updated: "2026-05-30"
related_issue: "#1"
related_pr: ""
supersedes: ""
---

# Document Governance

## 1. Purpose

This document defines the documentation governance system for Dogsquard.

Dogsquard is a reusable initialization suite for future small and medium internal application repositories. Its documentation system must keep human intent, agent output, implementation behavior, architecture decisions, testing scope, operations notes, and release records organized without allowing agents to invent product direction.

## 2. Folder Model

All non-trivial project documents must live under `docs/`.

```text
docs/
  00_inbox/        unclassified generated or imported documents
  01_brd/          business requirement documents
  02_prd/          product requirement documents
  03_bdd/          behavior scenarios and acceptance criteria
  04_adr/          architecture decision records
  05_design/       agent, design, and non-code technical notes
  06_testing/      test plans, UAT notes, and E2E scope
  07_runbooks/     operations and deployment procedures
  08_releases/     release notes and release decisions
  90_archive/      superseded or obsolete documents preserved for history
```

Generated documents must not remain loose in the repository root. If the correct destination is unclear, the document goes to `docs/00_inbox/`.

## 3. Naming Rules

Filenames must use lowercase kebab-case.

Required patterns:

```text
BRD:     brd-YYYYMMDD-short-topic.md
PRD:     prd-YYYYMMDD-short-topic.md
BDD:     bdd-YYYYMMDD-short-topic.md
ADR:     0001-short-decision-title.md
Design:  design-YYYYMMDD-short-topic.md
Test:    test-YYYYMMDD-short-topic.md
Runbook: runbook-short-operation.md
Release: release-vX.Y.Z.md
```

Inbox documents should use a traceable temporary name when possible:

```text
inbox-YYYYMMDD-HHMM-source-short-topic.md
```

Archive documents should preserve origin and date context:

```text
archived-YYYYMMDD-original-name.md
```

## 4. Metadata Rules

Every non-trivial document must start with this front matter:

```yaml
---
title: ""
doc_type: "brd|prd|bdd|adr|design|test|runbook|release|inbox|archive"
status: "draft|review|approved|superseded|archived"
owner: "user|product-agent|coding-agent|doc-watch-guard|devops-agent"
source: "user|agent|chat|github|manual"
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
related_issue: ""
related_pr: ""
supersedes: ""
---
```

Field rules:

- `title` must describe the document topic.
- `doc_type` must match the folder purpose.
- `status` must reflect the lifecycle state.
- `owner` identifies the role responsible for maintenance.
- `source` records where the document originated.
- `created` and `updated` use `YYYY-MM-DD`.
- `related_issue` should link to the controlling issue when known.
- `related_pr` is filled when a PR exists.
- `supersedes` points to replaced documents when applicable.

## 5. Document Status Lifecycle

Documents move through this lifecycle:

```text
draft -> review -> approved -> superseded -> archived
```

Lifecycle rules:

- `draft` documents may be edited while preserving user intent.
- `review` documents need human or designated reviewer attention.
- `approved` documents cannot be silently rewritten.
- `superseded` documents must identify the replacement document.
- `archived` documents must preserve historical content.

## 6. Update Rules

Documentation changes must accompany meaningful project changes.

When business purpose or user intent changes, update `docs/01_brd/` with explicit user approval.

When product behavior or scope changes, update `docs/02_prd/` and `docs/03_bdd/`.

When architecture direction changes, add or update an ADR in `docs/04_adr/`.

When testing strategy, acceptance scope, or E2E policy changes, update `docs/06_testing/` or `docs/03_bdd/`.

When operational behavior changes, update `docs/07_runbooks/`.

When release behavior or release risk changes, update `docs/08_releases/` and `CHANGELOG.md` once those files exist.

When a major project phase changes, update GitHub Issue `#1` Control Board.

## 7. Archive Rules

Documents are archived only when they are obsolete, superseded, or no longer active but still historically useful.

Archive destination:

```text
docs/90_archive/YYYY/MM/
```

Archive requirements:

- Preserve the original document content unless a reviewed cleanup explicitly says otherwise.
- Set `status` to `archived` when editing metadata is safe.
- Set `supersedes` or reference the replacement document when applicable.
- Never automatically delete BRD, PRD, BDD, or ADR documents.
- Never hide unresolved conflicts by archiving one side silently.

## 8. Generated Chat Document Rules

Agents may generate draft documents, summaries, plans, and review notes.

Generated document rules:

- If document type is unclear, place it in `docs/00_inbox/`.
- If a generated document contains possible user requirements, keep it as draft until user confirmation.
- Do not promote generated notes into BRD without clear user source or explicit user approval.
- Do not merge conflicting generated documents silently.
- Duplicate generated documents must be reported before consolidation.
- Generated documents must receive metadata before becoming project records.

## 9. Doc Watch Guard Role

Doc Watch Guard is the documentation librarian.

Allowed work:

- scan `docs/`
- classify generated documents
- move documents to correct folders
- rename documents according to naming rules
- add missing metadata when safely derivable
- detect stale inbox documents
- detect duplicate documents
- detect conflicting documents
- propose archive operations
- archive superseded generated notes when safe
- maintain indexes if introduced later

Forbidden work:

- invent product direction
- rewrite business meaning
- silently modify approved documents
- approve ADRs
- delete source requirement documents automatically
- bypass GitHub Actions
- commit or merge automatically unless a later explicit policy allows it

## 10. Agent Permissions and Limits

Agents may draft, edit, organize, and validate documentation within the authority of existing BRD, PRD, BDD, ADR, user instruction, and Issue `#1`.

Agents must not:

- invent product direction
- rewrite business meaning
- hardcode unverified model names, CLI command names, config schemas, or versions
- treat local agent output as CI/CD authority
- silently rewrite approved documents
- bypass explicit user approval for production deployment

The human user remains final authority for business meaning, major architecture decisions, production releases, and agent governance changes.

GitHub Actions is the deterministic CI/CD authority once workflows are introduced.

## 11. Acceptance Criteria

- Required documentation folders exist under `docs/`.
- Core documents use the required metadata front matter.
- Filenames follow Dogsquard naming rules.
- Generated documents with unclear type go to `docs/00_inbox/`.
- BRD content is protected from silent agent modification.
- PRD and BDD updates are required when product behavior changes.
- ADRs are required when architecture direction changes.
- Approved documents cannot be silently rewritten.
- Stale inbox and duplicate generated documents are reported.
- Doc Watch Guard can organize documents but cannot invent product meaning.
- Issue `#1` Control Board is updated after major phase changes.

