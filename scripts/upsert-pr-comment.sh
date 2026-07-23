#!/usr/bin/env bash
set -euo pipefail

MARKER="${1:-}"
BODY_FILE="${2:-}"

if [[ -z "$MARKER" || -z "$BODY_FILE" ]]; then
  echo "Usage: scripts/upsert-pr-comment.sh <marker> <body-file>" >&2
  exit 2
fi

if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${PR_NUMBER:-}" || -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_REPOSITORY, PR_NUMBER, and GITHUB_TOKEN are required." >&2
  exit 2
fi

if [[ ! -f "$BODY_FILE" ]]; then
  echo "Body file not found: $BODY_FILE" >&2
  exit 2
fi

list_api="https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments"
comment_api="https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/comments"
comments_json="$(mktemp)"
body_json="$(mktemp)"
trap 'rm -f "$comments_json" "$body_json"' EXIT

curl -fsSL \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$list_api?per_page=100" > "$comments_json"

comment_id="$(python3 - "$comments_json" "$MARKER" <<'PY'
import json
import sys

path, marker = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    comments = json.load(f)

for comment in comments:
    body = comment.get('body') or ''
    if marker in body:
        print(comment['id'])
        break
PY
)"

python3 - "$BODY_FILE" > "$body_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as f:
    body = f.read()

print(json.dumps({'body': body}))
PY

if [[ -n "$comment_id" ]]; then
  curl -fsSL \
    -X PATCH \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$comment_api/$comment_id" \
    --data-binary "@$body_json" >/dev/null
  echo "Updated PR comment $comment_id."
else
  curl -fsSL \
    -X POST \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$list_api" \
    --data-binary "@$body_json" >/dev/null
  echo "Created PR comment."
fi
