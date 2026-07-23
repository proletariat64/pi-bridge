#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$script_dir/fake-implementation-guard.sh"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run_case() {
  local name="$1"
  local expected="$2"
  local file="$3"
  local content="$4"
  local work="$tmp_root/$name"

  mkdir -p "$work"
  (
    cd "$work"
    git init -q
    git config user.email test@example.com
    git config user.name "Test User"
    printf 'package main\n\nfunc main() {}\n' > main.go
    git add main.go
    git commit -q -m initial
    mkdir -p "$(dirname "$file")"
    printf '%s\n' "$content" > "$file"

    if [[ "$expected" == "pass" ]]; then
      "$guard" >/tmp/fake-guard-output 2>&1 || {
        cat /tmp/fake-guard-output >&2
        fail "$name should pass"
      }
    else
      if "$guard" >/tmp/fake-guard-output 2>&1; then
        cat /tmp/fake-guard-output >&2
        fail "$name should fail"
      fi
    fi
  )
}

run_case "production-todo" "fail" "internal/service.go" 'func run() { panic("TODO") }'
run_case "production-symbol" "fail" "src/client.ts" 'export class MockService {}'
run_case "docs-ignored" "pass" "docs/notes.md" 'TODO describe future behavior'
run_case "tests-ignored" "pass" "backend/internal/task/handler_test.go" 'func TestMockClient(t *testing.T) {}'
run_case "fixture-ignored" "pass" "frontend/tests/fixtures/client.ts" 'export class FakeClient {}'
run_case "disclosed-placeholder" "pass" "src/later.ts" 'export const value = "placeholder"; // DOGSQUARD_INTENTIONAL_PLACEHOLDER: waiting for upstream API'
run_case "guard-infrastructure-wording" "pass" "scripts/bootstrap-project.sh" 'run: make fake-check'

echo "Fake implementation guard self-test passed."
