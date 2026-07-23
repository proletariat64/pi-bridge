#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
source "$script_dir/lib-doc-rules.sh"

cd "$repo_root"

failures=()

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1"
  failures+=("$1")
}

check_required_paths() {
  local missing=0
  for dir in "${required_doc_dirs[@]}"; do
    if [[ -d "$dir" ]]; then
      pass "required directory exists: $dir"
    else
      fail "missing required directory: $dir"
      missing=1
    fi
  done

  if [[ -f CHANGELOG.md ]]; then
    pass "required file exists: CHANGELOG.md"
  else
    fail "missing required file: CHANGELOG.md"
    missing=1
  fi

  return "$missing"
}

check_core_files() {
  local missing=0
  for file in "${core_doc_files[@]}"; do
    if [[ -f "$file" ]]; then
      pass "core document exists: $file"
    else
      fail "missing core document: $file"
      missing=1
    fi
  done

  return "$missing"
}

check_naming_rules() {
  local had_failure=0
  while IFS= read -r file; do
    local regex
    local base
    regex="$(doc_rule_regex_for_file "$file")"
    [[ -z "$regex" ]] && continue
    base="$(basename "$file")"
    if [[ "$base" =~ $regex ]]; then
      pass "filename matches rule: $file"
    else
      fail "filename violates rule: $file"
      had_failure=1
    fi
  done < <(find docs -type f -name '*.md' | sort)

  return "$had_failure"
}

check_metadata() {
  local had_failure=0
  while IFS= read -r file; do
    local block
    block="$(doc_rule_front_matter_block "$file")"
    if [[ -z "$block" ]]; then
      fail "missing front matter block: $file"
      had_failure=1
      continue
    fi

    for key in "${front_matter_keys[@]}"; do
      if grep -q "^$key" <<<"$block"; then
        pass "metadata key $key found in $file"
      else
        fail "metadata key $key missing in $file"
        had_failure=1
      fi
    done
  done < <(find docs -type f -name '*.md' | sort)

  return "$had_failure"
}

check_changelog() {
  if [[ -f CHANGELOG.md ]] && grep -q '^## Unreleased' CHANGELOG.md; then
    pass "CHANGELOG.md contains ## Unreleased"
  else
    fail "CHANGELOG.md must contain ## Unreleased"
    return 1
  fi
}

check_required_paths || true
check_core_files || true
check_naming_rules || true
check_metadata || true
check_changelog || true

if [[ "${#failures[@]}" -gt 0 ]]; then
  echo
  echo "Documentation check failed with ${#failures[@]} issue(s):"
  for failure in "${failures[@]}"; do
    echo "- $failure"
  done
  exit 1
fi

echo
echo "Documentation check passed."

