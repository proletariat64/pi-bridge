#!/usr/bin/env bash

required_doc_dirs=(
  "docs/00_inbox"
  "docs/01_brd"
  "docs/02_prd"
  "docs/03_bdd"
  "docs/04_adr"
  "docs/05_design"
  "docs/06_testing"
  "docs/07_runbooks"
  "docs/08_releases"
  "docs/90_archive"
)

core_doc_files=(
  "docs/01_brd/brd-20260530-project-operating-model.md"
  "docs/02_prd/prd-20260530-document-governance.md"
  "docs/03_bdd/bdd-20260530-document-governance.md"
  "docs/04_adr/0001-use-github-actions-as-ci-authority.md"
  "docs/05_design/design-20260530-agent-charter.md"
)

front_matter_keys=(
  "title:"
  "doc_type:"
  "status:"
  "owner:"
  "source:"
  "created:"
  "updated:"
)

doc_rule_regex_for_file() {
  local file="$1"
  case "$file" in
    docs/01_brd/*.md) echo '^brd-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/02_prd/*.md) echo '^prd-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/03_bdd/*.md) echo '^bdd-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/04_adr/*.md) echo '^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/05_design/*.md) echo '^design-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/06_testing/*.md) echo '^test-[0-9]{8}-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/07_runbooks/*.md) echo '^runbook-[a-z0-9]+(-[a-z0-9]+)*\.md$' ;;
    docs/08_releases/*.md) echo '^release-v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+)*\.md$' ;;
    *) echo "" ;;
  esac
}

doc_rule_front_matter_block() {
  local file="$1"
  awk '
    NR == 1 && $0 == "---" { in_block = 1; next }
    in_block && $0 == "---" { exit }
    in_block { print }
  ' "$file"
}
