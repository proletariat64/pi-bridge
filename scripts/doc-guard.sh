#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
source "$script_dir/lib-doc-rules.sh"

cd "$repo_root"

apply_mode=0
if [[ "${1:-}" == "--apply" ]]; then
  apply_mode=1
elif [[ "${1:-}" != "" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

if [[ "$apply_mode" -eq 1 ]]; then
  echo "Doc Watch Guard apply mode is intentionally conservative in Phase 2 and currently only reports."
  echo
fi

echo "Doc Watch Guard report"
echo "======================"
echo

echo "Inbox files:"
if find docs/00_inbox -type f ! -name '.gitkeep' | grep -q .; then
  find docs/00_inbox -type f ! -name '.gitkeep' | sort
else
  echo "- none"
fi
echo

if find docs/00_inbox -type f -name '*.md' | grep -q .; then
  echo "WARN: docs/00_inbox contains markdown files that should be classified:"
  find docs/00_inbox -type f -name '*.md' | sort | sed 's/^/- /'
else
  echo "PASS: docs/00_inbox has no markdown files waiting for classification."
fi
echo

bad_names=()
while IFS= read -r file; do
  regex="$(doc_rule_regex_for_file "$file")"
  [[ -z "$regex" ]] && continue
  base="$(basename "$file")"
  if [[ ! "$base" =~ $regex ]]; then
    bad_names+=("$file")
  fi
done < <(find docs -type f -name '*.md' | sort)

if [[ "${#bad_names[@]}" -gt 0 ]]; then
  echo "WARN: markdown files with naming rule issues:"
  for file in "${bad_names[@]}"; do
    echo "- $file"
  done
else
  echo "PASS: checked markdown filenames match configured folder rules."
fi
echo

missing_metadata=()
while IFS= read -r file; do
  block="$(doc_rule_front_matter_block "$file")"
  for key in "${front_matter_keys[@]}"; do
    if [[ -z "$block" ]] || ! grep -q "^$key" <<<"$block"; then
      missing_metadata+=("$file missing $key")
    fi
  done
done < <(find docs -type f -name '*.md' | sort)

if [[ "${#missing_metadata[@]}" -gt 0 ]]; then
  echo "WARN: missing front matter keys:"
  for item in "${missing_metadata[@]}"; do
    echo "- $item"
  done
else
  echo "PASS: checked markdown files include required front matter keys."
fi
echo

echo "Possible duplicate titles:"
title_tmp="$(mktemp)"
trap 'rm -f "$title_tmp"' EXIT
while IFS= read -r file; do
  block="$(doc_rule_front_matter_block "$file")"
  title_line="$(grep '^title:' <<<"$block" | head -n 1 || true)"
  [[ -z "$title_line" ]] && continue
  title_value="${title_line#title:}"
  title_value="${title_value//\"/}"
  title_value="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' <<<"$title_value")"
  [[ -z "$title_value" ]] && continue
  printf '%s\t%s\n' "$title_value" "$file" >> "$title_tmp"
done < <(find docs -type f -name '*.md' | sort)

if [[ -s "$title_tmp" ]] && cut -f1 "$title_tmp" | sort | uniq -d | grep -q .; then
  while IFS= read -r title; do
    echo "- $title"
    awk -F '\t' -v title="$title" '$1 == title { print "  " $2 }' "$title_tmp"
  done < <(cut -f1 "$title_tmp" | sort | uniq -d)
else
  echo "- none"
fi
echo

echo "Recommended next actions:"
echo "- Classify any markdown files in docs/00_inbox before they become project records."
echo "- Fix reported naming or metadata issues before opening a PR."
echo "- Keep BRD meaning under explicit user control."
echo "- Add or update PRD, BDD, ADR, test, runbook, or release docs when behavior changes."
echo "- Do not archive, delete, or rewrite documents automatically in Phase 2."

