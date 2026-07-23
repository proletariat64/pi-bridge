#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

base_ref="${FAKE_GUARD_BASE:-}"
if [[ -z "$base_ref" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]] && git rev-parse --verify "origin/${GITHUB_BASE_REF}" >/dev/null 2>&1; then
    base_ref="origin/${GITHUB_BASE_REF}"
  elif git rev-parse --verify origin/main >/dev/null 2>&1; then
    base_ref="$(git merge-base HEAD origin/main)"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    base_ref="HEAD~1"
  else
    base_ref=""
  fi
fi

tmp_diff="$(mktemp)"
tmp_untracked="$(mktemp)"
trap 'rm -f "$tmp_diff" "$tmp_untracked"' EXIT

is_scannable_file() {
  local file="$1"

  case "$file" in
    ""|docs/*|*.md|*.markdown|CHANGELOG.md|README.md) return 1 ;;
    node_modules/*|*/node_modules/*|dist/*|*/dist/*|build/*|*/build/*|coverage/*|*/coverage/*) return 1 ;;
    vendor/*|*/vendor/*|frontend/package-lock.json|package-lock.json|*.lock|*.sum) return 1 ;;
    .github/workflows/*|scripts/fake-implementation-guard.sh|scripts/test-*.sh|Makefile|*.mk) return 1 ;;
    *.snap|*.snapshot|*/snapshots/*|*/__snapshots__/*) return 1 ;;
    */test/*|*/tests/*|test/*|tests/*|*/fixtures/*|*/fixture/*|fixtures/*|fixture/*) return 1 ;;
    */testdata/*|testdata/*|*/mockbin/*|mockbin/*|*/__tests__/*|__tests__/*) return 1 ;;
    *_test.go|*.test.ts|*.test.tsx|*.test.js|*.test.jsx|*.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx) return 1 ;;
  esac

  case "$file" in
    *.go|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.sh|*.bash|*.sql|*.json) return 0 ;;
    *) return 1 ;;
  esac
}

line_has_allow_marker() {
  local line="$1"
  [[ "$line" == *"DOGSQUARD_INTENTIONAL_PLACEHOLDER:"* ]]
}

matches_fake_marker() {
  local line="$1"
  local lowered
  lowered="$(tr '[:upper:]' '[:lower:]' <<<"$line")"

  case "$lowered" in
    *fake-check*|*fake-implementation-guard*|*fake-completion*|*"fake implementation guard"*|*"fake-complete markers"*) return 1 ;;
  esac

  [[ "$line" =~ (TODO|FIXME|XXX|HACK) ]] && return 0
  [[ "$line" =~ (Mock|Fake|Stub|Dummy)[A-Z][A-Za-z0-9_]* ]] && return 0

  case "$lowered" in
    *stub*|*mock*|*fake*|*dummy*|*placeholder*) return 0 ;;
    *"not implemented"*|*"coming soon"*|*"temporary implementation"*) return 0 ;;
    *"hardcoded for now"*|*"return static"*|*"sample data"*) return 0 ;;
    *'panic("todo")'*|*"panic('todo')"*) return 0 ;;
    *'throw new error("not implemented")'*|*"throw new error('not implemented')"*) return 0 ;;
  esac

  return 1
}

append_diff() {
  if [[ "$#" -gt 0 ]]; then
    git diff --unified=0 --no-ext-diff "$@" >> "$tmp_diff" || true
  fi
}

if [[ -n "$base_ref" ]]; then
  append_diff "$base_ref...HEAD"
fi
append_diff --cached
append_diff

git ls-files --others --exclude-standard > "$tmp_untracked"

violations=()
allowed=()

record_line() {
  local file="$1"
  local line_no="$2"
  local line="$3"

  is_scannable_file "$file" || return 0
  matches_fake_marker "$line" || return 0

  if line_has_allow_marker "$line"; then
    allowed+=("$file:$line_no: $line")
  else
    violations+=("$file:$line_no: $line")
  fi
}

current_file=""
current_line=0
while IFS= read -r diff_line || [[ -n "$diff_line" ]]; do
  case "$diff_line" in
    "+++ b/"*)
      current_file="${diff_line#+++ b/}"
      ;;
    "+++ /dev/null")
      current_file=""
      ;;
    "@@ "*)
      if [[ "$diff_line" =~ \+([0-9]+)(,([0-9]+))? ]]; then
        current_line="${BASH_REMATCH[1]}"
      fi
      ;;
    "+"*)
      [[ "$diff_line" == "+++"* ]] && continue
      record_line "$current_file" "$current_line" "${diff_line#+}"
      current_line=$((current_line + 1))
      ;;
    "-"*)
      ;;
    *)
      if [[ -n "$current_file" ]]; then
        current_line=$((current_line + 1))
      fi
      ;;
  esac
done < "$tmp_diff"

while IFS= read -r file; do
  is_scannable_file "$file" || continue
  line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    record_line "$file" "$line_no" "$line"
  done < "$file"
done < "$tmp_untracked"

{
  echo "AI fake-completion guard"
  echo "========================"
  echo
  if [[ -n "$base_ref" ]]; then
    echo "Base: $base_ref"
  else
    echo "Base: none; scanning local changes only"
  fi
  echo

  if [[ "${#allowed[@]}" -gt 0 ]]; then
    echo "Allowed disclosed placeholders:"
    printf -- '- %s\n' "${allowed[@]}"
    echo
  fi

  if [[ "${#violations[@]}" -gt 0 ]]; then
    echo "FAIL: suspicious fake-completion markers found in changed production code."
    printf -- '- %s\n' "${violations[@]}"
    echo
    echo "Implement the behavior, move test doubles into test/fixture paths, or disclose an intentional placeholder with DOGSQUARD_INTENTIONAL_PLACEHOLDER: <reason> on the same line."
  else
    echo "PASS: no suspicious fake-completion markers found in changed production code."
  fi
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [[ "${#violations[@]}" -gt 0 ]]; then
  exit 1
fi
