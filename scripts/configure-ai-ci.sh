#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
settings_file=".github/ai-review/settings.json"

usage() {
  cat <<'USAGE'
Usage:
  scripts/configure-ai-ci.sh
  scripts/configure-ai-ci.sh --dry-run
  scripts/configure-ai-ci.sh --apply
  scripts/configure-ai-ci.sh --apply --apply-github-vars
  scripts/configure-ai-ci.sh --enabled true --engine qoder --qoder-model Qwen3.7-Max --qoder-model GLM-5.2 --apply
  scripts/configure-ai-ci.sh --enabled true --engine claude-deepseek --claude-provider deepseek --apply
  scripts/configure-ai-ci.sh --enabled false --apply

Options:
  --help                    Show this help.
  --dry-run                 Print generated config without writing files. Default.
  --apply                   Write .github/ai-review/settings.json atomically.
  --apply-github-vars       With --apply, set non-secret repo variables through gh.
  --enabled true|false      Enable or disable Dogsquard AI CI review.
  --engine ENGINE           claude-deepseek or qoder.
  --claude-provider NAME    Claude provider. MVP supports deepseek.
  --qoder-model NAME        Add one Qoder user-selected model. Repeat at most twice.

Interactive Qoder mode:
  Shows available models as a checkbox-style list. Enter a model number to
  toggle it, then press Enter or type done to continue. New selections move to
  the front of the runtime sequence. Auto is always implicit and not selectable.

Secrets:
  This script never reads, prints, or stores secret values.
  Interactive apply can optionally call gh secret set for the required secret.
  Claude+DeepSeek requires secret: DEEPSEEK_AUTH_TOKEN
  Qoder requires secret: QODER_PERSONAL_ACCESS_TOKEN
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 2
}

cd "$repo_root"

apply=false
apply_github_vars=false
enabled=""
engine=""
claude_provider=""
qoder_models=()
interactive=true
engine_flag_set=false
qoder_model_flag_count=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --dry-run)
      apply=false
      interactive=false
      shift
      ;;
    --apply)
      apply=true
      interactive=false
      shift
      ;;
    --apply-github-vars)
      apply_github_vars=true
      interactive=false
      shift
      ;;
    --enabled)
      [[ "$#" -ge 2 ]] || die "--enabled requires true or false"
      enabled="$2"
      interactive=false
      shift 2
      ;;
    --engine)
      [[ "$#" -ge 2 ]] || die "--engine requires a value"
      engine="$2"
      engine_flag_set=true
      interactive=false
      shift 2
      ;;
    --claude-provider)
      [[ "$#" -ge 2 ]] || die "--claude-provider requires a value"
      claude_provider="$2"
      interactive=false
      shift 2
      ;;
    --qoder-model)
      [[ "$#" -ge 2 ]] || die "--qoder-model requires a value"
      qoder_models+=("$2")
      qoder_model_flag_count=$((qoder_model_flag_count + 1))
      interactive=false
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

if [[ "$apply_github_vars" == true && "$apply" != true ]]; then
  die "--apply-github-vars requires --apply"
fi

current_json() {
  python3 - "$settings_file" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
default = {
    "enabled": True,
    "engine": "qoder",
    "claude": {"provider": "deepseek"},
    "qoder": {"models": ["Qwen3.7-Max"], "implicit_auto_fallback": True},
}
if path.is_file():
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"{path} must contain a JSON object")
else:
    data = default
print(json.dumps(data))
PY
}

json_get() {
  local expr="$1"
  CURRENT_JSON="$current" python3 - "$expr" <<'PY'
import json
import os
import sys

data = json.loads(os.environ["CURRENT_JSON"])
expr = sys.argv[1]
value = data
for part in expr.split("."):
    value = value.get(part, {}) if isinstance(value, dict) else {}
if isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, list):
    for item in value:
        print(item)
elif value not in ({}, None):
    print(value)
PY
}

list_qoder_models() {
  command -v qodercli >/dev/null 2>&1 || die "qodercli is required to list Qoder models"
  qodercli --list-models | awk 'NF && toupper($0) != "MODEL" && tolower($0) != "auto" { print $0 }'
}

join_models_with_auto() {
  local joined=""
  local model
  for model in "${qoder_models[@]}"; do
    if [[ -z "$joined" ]]; then
      joined="$model"
    else
      joined="$joined,$model"
    fi
  done
  if [[ -n "$joined" ]]; then
    echo "$joined,auto"
  else
    echo "auto"
  fi
}

join_models_arrow() {
  local joined=""
  local model
  for model in "${qoder_models[@]}"; do
    if [[ -z "$joined" ]]; then
      joined="$model"
    else
      joined="$joined -> $model"
    fi
  done
  if [[ -n "$joined" ]]; then
    echo "$joined -> Auto"
  else
    echo "Auto"
  fi
}

qoder_model_is_selected() {
  local candidate="$1"
  local model
  for model in "${qoder_models[@]}"; do
    [[ "$model" == "$candidate" ]] && return 0
  done
  return 1
}

toggle_qoder_model() {
  local selected="$1"
  local next=()
  local model

  if qoder_model_is_selected "$selected"; then
    for model in "${qoder_models[@]}"; do
      [[ "$model" == "$selected" ]] || next+=("$model")
    done
    qoder_models=("${next[@]}")
    return 0
  fi

  if [[ "${#qoder_models[@]}" -ge 2 ]]; then
    echo "No Qoder model slots left. Uncheck one model before selecting another." >&2
    return 0
  fi

  qoder_models=("$selected" "${qoder_models[@]}")
}

render_qoder_model_menu() {
  local available_models=("$@")
  local slots_left=$((2 - ${#qoder_models[@]}))
  local index model mark

  echo
  echo "Available Qoder models [$(join_models_with_auto)] $slots_left available model slots left:"
  for index in "${!available_models[@]}"; do
    model="${available_models[$index]}"
    if qoder_model_is_selected "$model"; then
      mark="x"
    else
      mark=" "
    fi
    printf '  %2d) [%s] %s\n' "$((index + 1))" "$mark" "$model"
  done
  echo "Enter a number to toggle a model. Press Enter or type done to continue."
}

select_qoder_models_interactively() {
  local available_models=()
  local answer answer_num model
  mapfile -t available_models < <(list_qoder_models)
  [[ "${#available_models[@]}" -gt 0 ]] || die "qodercli --list-models returned no selectable models"

  while true; do
    render_qoder_model_menu "${available_models[@]}"
    read -r -p "Qoder model selection: " answer
    case "$answer" in
      ""|done|Done|DONE)
        [[ "${#qoder_models[@]}" -ge 1 ]] || {
          echo "Select at least one Qoder model before continuing." >&2
          continue
        }
        break
        ;;
      *[!0-9]*)
        echo "Enter a model number, press Enter, or type done." >&2
        ;;
      *)
        answer_num=$((10#$answer))
        if (( answer_num < 1 || answer_num > ${#available_models[@]} )); then
          echo "Model number out of range." >&2
          continue
        fi
        model="${available_models[$((answer_num - 1))]}"
        toggle_qoder_model "$model"
        ;;
    esac
  done
}

validate_qoder_models_available() {
  local model
  local available
  available="$(list_qoder_models)"
  for model in "${qoder_models[@]}"; do
    if ! grep -Fxq "$model" <<<"$available"; then
      die "Qoder model is not available from qodercli --list-models: $model"
    fi
  done
}

ensure_gh_ready() {
  command -v gh >/dev/null 2>&1 || die "gh is required for GitHub activation"
  gh auth status >/dev/null 2>&1
  git remote get-url origin >/dev/null
}

apply_github_variables() {
  ensure_gh_ready
  gh variable set AI_REVIEW_ENGINE --body "$engine"
  gh variable set AI_REVIEW_CONFIGURED --body "true"
  echo "Updated non-secret GitHub repository variables: AI_REVIEW_ENGINE, AI_REVIEW_CONFIGURED"
}

print_manual_activation_commands() {
  cat <<EOF
To activate this config in GitHub Actions manually, run:
  git add $settings_file
  git commit -m "Update AI review config"
  git push
EOF
}

tracked_config_change_is_isolated() {
  local changed
  changed="$(git diff --name-only && git diff --cached --name-only)"
  while IFS= read -r file; do
    [[ -z "$file" || "$file" == "$settings_file" ]] || return 1
  done <<<"$changed"
  return 0
}

commit_and_push_config() {
  local upstream

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Skipped commit/push because this directory is not inside a git repository."
    print_manual_activation_commands
    return 0
  fi

  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "Skipped commit/push because this repository has no origin remote."
    print_manual_activation_commands
    return 0
  fi

  if git diff --quiet -- "$settings_file" && git diff --cached --quiet -- "$settings_file"; then
    echo "No config changes to commit."
    return 0
  fi

  if ! tracked_config_change_is_isolated; then
    echo "Skipped automatic commit because tracked local changes are not limited to $settings_file."
    echo "Review your worktree, then commit the config intentionally."
    print_manual_activation_commands
    return 0
  fi

  git add -- "$settings_file"
  if git diff --cached --quiet -- "$settings_file"; then
    echo "No config changes to commit."
    return 0
  fi

  git commit -m "Update AI review config"
  if upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    git push
    echo "Pushed config to $upstream. GitHub Actions will use it on the next workflow run for this branch."
  else
    git push -u origin HEAD
    echo "Pushed config and set upstream for the current branch. GitHub Actions will use it on the next workflow run for this branch."
  fi
}

github_secret_exists() {
  local secret_name="$1"
  gh secret list 2>/dev/null | awk '{print $1}' | grep -Fxq "$secret_name"
}

print_secret_status() {
  local secret_name="$1"
  if ! command -v gh >/dev/null 2>&1; then
    echo "$secret_name status: unknown (gh is not installed)"
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "$secret_name status: unknown (gh is not authenticated)"
    return 1
  fi
  if github_secret_exists "$secret_name"; then
    echo "$secret_name status: exists"
  else
    echo "$secret_name status: missing"
  fi
}

prompt_github_activation() {
  local should_apply_vars
  local should_set_secret
  local should_commit_push
  local secret_name

  if [[ "$engine" == "claude-deepseek" ]]; then
    secret_name="DEEPSEEK_AUTH_TOKEN"
  else
    secret_name="QODER_PERSONAL_ACCESS_TOKEN"
  fi

  echo
  echo "GitHub repository variables are optional compatibility hints."
  echo "This sets AI_REVIEW_ENGINE=$engine and AI_REVIEW_CONFIGURED=true in GitHub."
  echo "AI_REVIEW_CONFIGURED means this repo was configured; it is not the enabled/disabled switch."
  echo "It does not commit or push $settings_file; the config file remains the source of truth."
  should_apply_vars="$(prompt_yes_no "Sync these non-secret GitHub variables now?" "no")"
  if [[ "$should_apply_vars" == "true" ]]; then
    apply_github_variables
  else
    echo "Skipped GitHub repository variable update."
  fi

  echo
  print_secret_status "$secret_name" || true
  should_set_secret="$(prompt_yes_no "Set or update $secret_name now?" "no")"
  if [[ "$should_set_secret" == "true" ]]; then
    ensure_gh_ready
    gh secret set "$secret_name"
    echo "Updated GitHub secret: $secret_name"
  else
    echo "Skipped GitHub secret update."
  fi

  echo
  echo "To make GitHub Actions use $settings_file, the file must be committed and pushed."
  echo "This only stages $settings_file, but git push sends the current branch to GitHub."
  should_commit_push="$(prompt_yes_no "Commit this config and push the current branch now?" "no")"
  if [[ "$should_commit_push" == "true" ]]; then
    commit_and_push_config
  else
    echo "Skipped commit/push."
    print_manual_activation_commands
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local default="$2"
  local answer
  read -r -p "$prompt [$default]: " answer
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|yes|YES|true|TRUE) echo "true" ;;
    n|N|no|NO|false|FALSE) echo "false" ;;
    *) die "expected yes or no" ;;
  esac
}

prompt_choice() {
  local prompt="$1"
  local default="$2"
  local answer
  read -r -p "$prompt [$default]: " answer
  echo "${answer:-$default}"
}

interactive_menu() {
  echo "Dogsquard AI CI configuration"
  echo
  enabled="$(prompt_yes_no "Enable AI CI review?" "$(json_get enabled)")"
  engine="$(prompt_choice "Engine (claude-deepseek/qoder)" "$(json_get engine)")"

  if [[ "$engine" == "claude-deepseek" ]]; then
    echo "Claude providers:"
    echo "  - deepseek (requires secret DEEPSEEK_AUTH_TOKEN)"
    claude_provider="$(prompt_choice "Claude provider" "$(json_get claude.provider)")"
  elif [[ "$engine" == "qoder" ]]; then
    qoder_models=()
    while IFS= read -r model; do
      [[ -n "$model" ]] && qoder_models+=("$model")
    done < <(json_get qoder.models)
    select_qoder_models_interactively
    echo "Final runtime sequence: $(join_models_with_auto)"
  else
    die "invalid engine: $engine"
  fi

  echo
  echo "This command is dry-run unless you answer apply here."
  local should_apply
  should_apply="$(prompt_yes_no "Apply local file changes?" "no")"
  [[ "$should_apply" == "true" ]] && apply=true || apply=false
}

current="$(current_json)"
if [[ "$interactive" == true ]]; then
  interactive_menu
fi

enabled="${enabled:-$(json_get enabled)}"
engine="${engine:-$(json_get engine)}"
claude_provider="${claude_provider:-$(json_get claude.provider)}"
if [[ "${#qoder_models[@]}" -eq 0 ]]; then
  while IFS= read -r model; do
    [[ -n "$model" ]] && qoder_models+=("$model")
  done < <(json_get qoder.models)
fi

case "$enabled" in
  true|false) ;;
  *) die "--enabled must be true or false" ;;
esac

case "$engine" in
  claude-deepseek) ;;
  qoder) ;;
  *) die "--engine must be claude-deepseek or qoder" ;;
esac

[[ "$claude_provider" == "deepseek" ]] || die "--claude-provider must be deepseek"

if [[ "$engine" == "qoder" ]]; then
  if [[ "$interactive" != true && "$engine_flag_set" == true && "$qoder_model_flag_count" -eq 0 ]]; then
    die "explicit --engine qoder requires at least one --qoder-model"
  fi
  [[ "${#qoder_models[@]}" -ge 1 ]] || die "Qoder requires at least one --qoder-model"
  [[ "${#qoder_models[@]}" -le 2 ]] || die "Qoder allows at most two --qoder-model values"
  for model in "${qoder_models[@]}"; do
    [[ -n "$model" ]] || die "Qoder model cannot be empty"
    [[ "${model,,}" != "auto" ]] || die "Auto is an implicit fallback and cannot be selected"
  done
  if [[ "${#qoder_models[@]}" -eq 2 && "${qoder_models[0]}" == "${qoder_models[1]}" ]]; then
    die "Qoder models must be unique"
  fi
  validate_qoder_models_available
fi

models_env="$(printf '%s\n' "${qoder_models[@]}")"
generated_json="$(
  ENABLED="$enabled" \
  ENGINE="$engine" \
  CLAUDE_PROVIDER="$claude_provider" \
  QODER_MODELS="$models_env" \
  python3 <<'PY'
import json
import os

models = [line for line in os.environ["QODER_MODELS"].splitlines() if line]
data = {
    "enabled": os.environ["ENABLED"] == "true",
    "engine": os.environ["ENGINE"],
    "claude": {"provider": os.environ["CLAUDE_PROVIDER"]},
    "qoder": {"models": models, "implicit_auto_fallback": True},
}
print(json.dumps(data, indent=2, sort_keys=False))
PY
)"

echo "Affected files:"
echo "  - $settings_file"
if [[ "$apply_github_vars" == true ]]; then
  echo "  - GitHub repository variables: AI_REVIEW_ENGINE, AI_REVIEW_CONFIGURED"
fi
echo
echo "Generated $settings_file:"
echo "$generated_json"
echo
if [[ "$engine" == "claude-deepseek" ]]; then
  echo "Required secret: DEEPSEEK_AUTH_TOKEN"
else
  echo "Required secret: QODER_PERSONAL_ACCESS_TOKEN"
  echo "Runtime fallback sequence: ${qoder_models[*]} Auto"
fi

if [[ "$apply" != true ]]; then
  echo
  echo "Dry-run only. No files written."
  exit 0
fi

mkdir -p "$(dirname "$settings_file")"
SETTINGS_FILE="$settings_file" GENERATED_JSON="$generated_json" python3 <<'PY'
import json
import os
import tempfile
from pathlib import Path

path = Path(os.environ["SETTINGS_FILE"])
data = json.loads(os.environ["GENERATED_JSON"])
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f"{path.name}.", delete=False) as f:
    json.dump(data, f, indent=2)
    f.write("\n")
    staging = Path(f.name)
staging.replace(path)
PY

echo
echo "Wrote $settings_file"
echo "Configured AI CI: enabled=$enabled engine=$engine"
if [[ "$engine" == "qoder" ]]; then
  echo "Configured Qoder fallback sequence: $(join_models_arrow)"
fi
echo "GitHub Actions will use this config after the file is committed and pushed."
echo "Run \`git diff -- $settings_file\` to review the exact file diff."

if [[ "$apply_github_vars" == true ]]; then
  apply_github_variables
elif [[ "$interactive" == true ]]; then
  prompt_github_activation
fi
