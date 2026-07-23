#!/usr/bin/env bash
set -euo pipefail

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Git status:"
  git status --short
  echo

  echo "Changed files:"
  changed_files="$(git diff --name-only HEAD; git diff --cached --name-only; git ls-files --others --exclude-standard)"
  if [[ -n "$changed_files" ]]; then
    sort -u <<<"$changed_files"
  else
    echo "- none"
  fi
else
  echo "Git repository not detected."
fi

cat <<'PROMPT'

Copy-paste prompt for a human-selected agent:

Review the current Dogsquard repository changes for documentation governance.

Context:
- GitHub Issue #1 is the Dogsquard Control Board.
- Dogsquard is a reusable bootstrap kit for future internal application repositories, not the business product itself.
- Key governance files:
  - docs/01_brd/brd-20260530-project-operating-model.md
  - docs/02_prd/prd-20260530-document-governance.md
  - docs/03_bdd/bdd-20260530-document-governance.md
  - docs/04_adr/0001-use-github-actions-as-ci-authority.md
  - docs/05_design/design-20260530-agent-charter.md

Tasks:
- Check whether changed files follow Dogsquard documentation folder, naming, metadata, and lifecycle rules.
- Identify whether PRD, BDD, ADR, test, runbook, release, or changelog updates are needed.
- Report stale inbox documents, duplicate generated documents, or missing metadata.
- Suggest precise documentation fixes only when they follow existing user-approved meaning.

Limits:
- Do not invent requirements.
- Do not rewrite business meaning.
- Do not approve architecture decisions.
- Do not hardcode unverified model names, CLI command names, config schemas, or versions.
- Do not call external services unless the human user explicitly chooses that tool.
- Do not modify files unless explicitly instructed.
PROMPT

