#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

COMMENT_MARKER = "<!-- dogsquard-ai-code-review -->"
TMP_DIR = Path(".tmp/ai-review")
REVIEW_FILE = TMP_DIR / "review.md"
PROMPT_FILE = TMP_DIR / "prompt.md"
PR_JSON_FILE = TMP_DIR / "pr.json"
PR_PATCH_FILE = TMP_DIR / "pr.patch"
PR_FILES_FILE = TMP_DIR / "files.txt"
AI_REVIEW_SETTINGS_FILE = Path(".github/ai-review/settings.json")

VALID_ENGINES = {"claude-deepseek", "qoder"}
VALID_CLAUDE_PROVIDERS = {"deepseek"}
VALID_VERDICTS = {"PASS", "NEEDS_ATTENTION", "HIGH_RISK", "SKIP"}
PROVIDER_TIMEOUT_SECONDS = 600
MAX_COMMENT_CHARS = 60000

SECRET_ENV_NAMES = (
    "ANTHROPIC_AUTH_TOKEN",
    "DEEPSEEK_AUTH_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "QODER_PERSONAL_ACCESS_TOKEN",
)

SAFE_SKIP_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".tif",
    ".tiff",
    ".pdf",
    ".mp3",
    ".wav",
    ".mp4",
    ".mov",
    ".webm",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
}

NEVER_SKIP_NAMES = {"README.md", "AGENTS.md", "CLAUDE.md"}
NEVER_SKIP_EXTENSIONS = {
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".sh",
    ".bash",
    ".zsh",
    ".md",
    ".mdx",
    ".lock",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".sql",
    ".svg",
    ".zip",
    ".tar",
    ".tgz",
    ".gz",
    ".7z",
    ".rar",
}

REQUIRED_SECTIONS = (
    "### Verdict",
    "### What changed",
    "### Must fix",
    "### Should consider",
    "### Test gaps",
    "### Acceptance check",
    "### File-skip check",
    "### Dogsquard boundary check",
    "### Engine details",
)

QODER_DEFAULT_MODELS = ("Qwen3.7-Max",)
QODER_RETRYABLE_FAILURE_TEXT = (
    "restricted for this repository by a security policy",
    "model unavailable",
    "model is not available",
    "model not available",
    "model restricted",
    "invalid model",
    "unknown model",
)
DEFAULT_AI_REVIEW_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "engine": "claude-deepseek",
    "claude": {"provider": "deepseek"},
    "qoder": {"models": list(QODER_DEFAULT_MODELS), "implicit_auto_fallback": True},
}


class ReviewFailure(Exception):
    def __init__(self, message: str, engine: str = "unknown") -> None:
        super().__init__(message)
        self.engine = engine


def log(message: str) -> None:
    print(message, file=sys.stderr)


def redact_known_secrets(text: str) -> str:
    redacted = text
    for name in SECRET_ENV_NAMES:
        value = os.getenv(name)
        if value and len(value) >= 4:
            redacted = redacted.replace(value, "***")
    return redacted


def run_capture(
    cmd: list[str],
    *,
    input_text: str | None = None,
    timeout_seconds: int | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            cmd,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            env=env,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as exc:
        stdout = (exc.stdout or "").decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = (exc.stderr or "").decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        detail = f"Command timed out after {timeout_seconds} seconds."
        return 124, stdout, f"{stderr.strip()}\n{detail}".strip()


def require_env(name: str, engine: str = "unknown") -> str:
    value = os.getenv(name)
    if not value:
        raise ReviewFailure(f"Required environment variable is missing: {name}", engine)
    return value


def read_text(path: Path) -> str:
    if not path.is_file():
        raise ReviewFailure(f"Required file is missing: {path}")
    return path.read_text(encoding="utf-8")


def write_review(body: str) -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    if len(body) > MAX_COMMENT_CHARS:
        suffix = "\n\n_Comment truncated because it exceeded the safe GitHub comment size._\n"
        body = body[: MAX_COMMENT_CHARS - len(suffix)] + suffix
    REVIEW_FILE.write_text(redact_known_secrets(body), encoding="utf-8")


def load_ai_review_settings() -> dict[str, Any]:
    if not AI_REVIEW_SETTINGS_FILE.is_file():
        return json.loads(json.dumps(DEFAULT_AI_REVIEW_SETTINGS))
    with AI_REVIEW_SETTINGS_FILE.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} must contain a JSON object")
    return data


def resolve_enabled(settings: dict[str, Any]) -> bool:
    enabled = settings.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} field enabled must be boolean")
    return enabled


def validate_engine(engine: str) -> str:
    if engine not in VALID_ENGINES:
        raise ReviewFailure(f"Invalid AI review engine: {engine!r}", engine)
    return engine


def resolve_engine(settings: dict[str, Any]) -> str:
    dispatch_engine = (os.getenv("AI_REVIEW_ENGINE_INPUT") or "").strip()
    if dispatch_engine:
        return validate_engine(dispatch_engine)

    configured_engine = settings.get("engine")
    if isinstance(configured_engine, str) and configured_engine.strip():
        return validate_engine(configured_engine.strip())
    if configured_engine is not None and not isinstance(configured_engine, str):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} field engine must be a string")

    legacy_engine = (os.getenv("AI_REVIEW_ENGINE") or "").strip()
    if legacy_engine:
        return validate_engine(legacy_engine)

    return "claude-deepseek"


def resolve_claude_provider(settings: dict[str, Any]) -> str:
    claude_settings = settings.get("claude", {})
    if claude_settings is None:
        claude_settings = {}
    if not isinstance(claude_settings, dict):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} field claude must be an object", "claude-deepseek")
    provider = str(claude_settings.get("provider") or "deepseek").strip()
    if provider not in VALID_CLAUDE_PROVIDERS:
        raise ReviewFailure(f"Invalid Claude provider: {provider!r}", "claude-deepseek")
    return provider


def resolve_runtime_config(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    resolved_settings = settings if settings is not None else load_ai_review_settings()
    enabled = resolve_enabled(resolved_settings)
    engine = resolve_engine(resolved_settings)
    config: dict[str, Any] = {
        "enabled": enabled,
        "engine": engine,
    }
    if not enabled:
        return config
    if engine == "claude-deepseek":
        config["claude_provider"] = resolve_claude_provider(resolved_settings)
    elif engine == "qoder":
        config["qoder_models"] = resolve_qoder_model_sequence(resolved_settings)
    return config


def print_resolved_config() -> int:
    config = resolve_runtime_config()
    print(json.dumps(config, sort_keys=True))
    return 0


def provider_timeout_seconds() -> int:
    raw = os.getenv("AI_REVIEW_TIMEOUT_SECONDS") or os.getenv("QODER_REVIEW_TIMEOUT_SECONDS")
    if not raw:
        return PROVIDER_TIMEOUT_SECONDS
    try:
        parsed = int(raw)
    except ValueError:
        return PROVIDER_TIMEOUT_SECONDS
    return parsed if parsed > 0 else PROVIDER_TIMEOUT_SECONDS


def gh_json(args: list[str], engine: str) -> Any:
    code, stdout, stderr = run_capture(["gh", *args])
    if code != 0:
        raise ReviewFailure(f"gh command failed: {redact_known_secrets(stderr.strip())}", engine)
    return json.loads(stdout)


def gh_text(args: list[str], engine: str) -> str:
    code, stdout, stderr = run_capture(["gh", *args])
    if code != 0:
        raise ReviewFailure(f"gh command failed: {redact_known_secrets(stderr.strip())}", engine)
    return stdout


def collect_pr_context(engine: str) -> dict[str, Any]:
    require_env("PR_NUMBER", engine)
    if os.getenv("GITHUB_ACTIONS"):
        require_env("GH_TOKEN", engine)

    pr_number = os.environ["PR_NUMBER"]
    fields = "number,title,body,baseRefName,headRefName,author,additions,deletions,changedFiles,url"
    pr_data = gh_json(["pr", "view", pr_number, "--json", fields], engine)
    files_text = gh_text(["pr", "diff", pr_number, "--name-only"], engine)
    files = [line.strip() for line in files_text.splitlines() if line.strip()]

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    PR_JSON_FILE.write_text(json.dumps(pr_data, indent=2, sort_keys=True), encoding="utf-8")
    PR_FILES_FILE.write_text("\n".join(files) + ("\n" if files else ""), encoding="utf-8")

    if not files:
        raise ReviewFailure("PR changed-file list is empty.", engine)

    if should_skip_review(files):
        return {"pr": pr_data, "files": files, "patch": "", "skip": True}

    patch = gh_text(["pr", "diff", pr_number, "--patch"], engine)
    PR_PATCH_FILE.write_text(patch, encoding="utf-8")
    if not patch.strip():
        raise ReviewFailure("PR patch is empty for a non-skipped review.", engine)

    return {"pr": pr_data, "files": files, "patch": patch, "skip": False}


def is_safe_binary_asset(path: str) -> bool:
    p = Path(path)
    suffix = p.suffix.lower()
    if p.name in NEVER_SKIP_NAMES:
        return False
    if suffix in NEVER_SKIP_EXTENSIONS:
        return False
    return suffix in SAFE_SKIP_EXTENSIONS


def should_skip_review(files: list[str]) -> bool:
    return bool(files) and all(is_safe_binary_asset(path) for path in files)


def skip_comment(engine: str, files: list[str]) -> str:
    changed = "\n".join(f"- `{path}`" for path in files)
    return f"""### PASS — Dogsquard AI Code Review

## 🤖 Dogsquard AI Code Review

{COMMENT_MARKER}

### Verdict
SKIP

### What changed
- Review skipped because this PR changes only safe binary/document asset files.

### Must fix
- None.

### Should consider
- None.

### Test gaps
- None.

### Acceptance check
- Not evaluated because provider invocation was skipped by file policy.

### File-skip check
- Skip used: yes.
- Reason: all changed files are safe binary/document assets.
- Changed files:
{changed}

### Dogsquard boundary check
- No source, workflow, config, or documentation file was changed.

### Engine details
- Engine: {engine}
- Model: skipped
"""


def disabled_comment(engine: str) -> str:
    return f"""### PASS — Dogsquard AI Code Review

## 🤖 Dogsquard AI Code Review

{COMMENT_MARKER}

### Verdict
PASS

### AI review state
DISABLED

### What changed
- AI review is disabled by `.github/ai-review/settings.json`.

### Must fix
- None.

### Should consider
- Re-enable AI review through `scripts/configure-ai-ci.sh --enabled true --apply` when advisory review is wanted.

### Test gaps
- Provider review was not run because AI review is disabled by configuration.

### Acceptance check
- Not evaluated because AI review is disabled by configuration.

### File-skip check
- Skip used: no.
- Reason: provider review was disabled by configuration, not skipped by file policy.

### Dogsquard boundary check
- Deterministic `PR Quality Gate` remains the merge authority.

### Engine details
- Engine: {engine}
- Model: disabled
"""


def failure_comment(reason: str, engine: str = "unknown") -> str:
    safe_reason = redact_known_secrets(reason).strip() or "Unknown failure."
    return f"""### FAIL — Dogsquard AI Code Review

## 🤖 Dogsquard AI Code Review

{COMMENT_MARKER}

### Verdict
NEEDS_ATTENTION

### What changed
- AI review could not complete.

### Must fix
- Selected provider or runner failed before a valid review was produced: {safe_reason}

### Should consider
- Check provider secret, selected engine, CLI installation, PR number, and PR diff availability.

### Test gaps
- AI review was not completed for this run.

### Acceptance check
- Not evaluated because AI review failed before completion.

### File-skip check
- Skip used: no.
- Reason: failure happened before a valid advisory review was produced.

### Dogsquard boundary check
- Not evaluated because AI review failed before completion.

### Engine details
- Engine: {engine}
- Model: unknown
"""


def build_prompt(engine: str, context: dict[str, Any]) -> str:
    policy = read_text(Path(".github/workflows/prompts/pr-review-policy.md"))
    contract = read_text(Path(".github/workflows/prompts/pr-review-output-contract.md"))
    pr_data = json.dumps(context["pr"], indent=2, sort_keys=True)
    files = "\n".join(f"- {path}" for path in context["files"])
    prompt = f"""# Dogsquard AI PR Review

Selected engine: {engine}

{policy}

{contract}

## PR metadata

```json
{pr_data}
```

## Changed files

{files}

## PR patch

```diff
{context["patch"]}
```
"""
    PROMPT_FILE.write_text(prompt, encoding="utf-8")
    return prompt


def load_qoder_settings() -> dict[str, Any]:
    path = Path(".github/qoder/settings.json")
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ReviewFailure(".github/qoder/settings.json must contain a JSON object", "qoder")
    return data


def qoder_settings_timeout(settings: dict[str, Any]) -> int:
    raw = settings.get("timeout_seconds")
    if raw is None:
        return provider_timeout_seconds()
    if isinstance(raw, bool):
        return provider_timeout_seconds()
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return provider_timeout_seconds()
    return parsed if parsed > 0 else provider_timeout_seconds()


def qodercli_bin() -> str:
    return os.getenv("QODERCLI_BIN") or "qodercli"


def configured_qoder_models(settings: dict[str, Any]) -> list[str]:
    qoder_settings = settings.get("qoder", {})
    if qoder_settings is None:
        qoder_settings = {}
    if not isinstance(qoder_settings, dict):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} field qoder must be an object", "qoder")
    if qoder_settings.get("implicit_auto_fallback") is not True:
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} qoder.implicit_auto_fallback must be true", "qoder")

    raw = qoder_settings.get("models", list(QODER_DEFAULT_MODELS))
    if not isinstance(raw, list):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} qoder.models must be a string list", "qoder")
    models = [item.strip() for item in raw if isinstance(item, str) and item.strip()]
    if len(models) != len(raw):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} qoder.models must contain only non-empty strings", "qoder")
    if not 1 <= len(models) <= 2:
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} qoder.models must contain one or two models", "qoder")
    if any(model.lower() == "auto" for model in models):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} qoder.models must not include Auto", "qoder")

    deduped: list[str] = []
    for model in models:
        if model not in deduped:
            deduped.append(model)
    if len(deduped) != len(models):
        raise ReviewFailure(f"{AI_REVIEW_SETTINGS_FILE} qoder.models must not contain duplicates", "qoder")
    return deduped


def resolve_qoder_model_sequence(settings: dict[str, Any]) -> list[str]:
    deduped = configured_qoder_models(settings)
    deduped.append("Auto")
    log(f"Qoder model sequence resolved: {', '.join(deduped)}")
    return deduped


def qoder_failure_is_retryable(code: int, stdout: str, stderr: str) -> bool:
    if code == 124:
        return True
    combined = f"{stdout}\n{stderr}".lower()
    return any(needle in combined for needle in QODER_RETRYABLE_FAILURE_TEXT)


def run_claude_deepseek(prompt: str, provider: str) -> tuple[str, str]:
    engine = "claude-deepseek"
    if provider != "deepseek":
        raise ReviewFailure(f"Unsupported Claude provider: {provider}", engine)
    require_env("ANTHROPIC_AUTH_TOKEN", engine)
    settings_path = Path(".github/claude/deepseek-settings.json")
    if not settings_path.is_file():
        raise ReviewFailure(f"Claude settings file missing: {settings_path}", engine)

    cmd = [
        "npx",
        "-y",
        "@anthropic-ai/claude-code",
        "-p",
        "--settings",
        str(settings_path),
    ]
    code, stdout, stderr = run_capture(cmd, input_text=prompt, timeout_seconds=provider_timeout_seconds())
    if code != 0:
        detail = stderr.strip() or stdout.strip() or f"Claude Code exited with {code}"
        raise ReviewFailure(f"claude-deepseek provider failed: {redact_known_secrets(detail)}", engine)
    return stdout, "configured by .github/claude/deepseek-settings.json"


def run_qoder(prompt: str, settings: dict[str, Any]) -> tuple[str, str]:
    engine = "qoder"
    require_env("QODER_PERSONAL_ACCESS_TOKEN", engine)
    qoder_settings = load_qoder_settings()
    timeout_seconds = qoder_settings_timeout(qoder_settings)
    models = resolve_qoder_model_sequence(settings)
    failures: list[str] = []
    for index, model in enumerate(models):
        cmd = [
            qodercli_bin(),
            "--model",
            model,
            "--output-format",
            "text",
            "-p",
        ]
        log(f"Qoder invocation: starting qodercli with model {model}")
        code, stdout, stderr = run_capture(cmd, input_text=prompt, timeout_seconds=timeout_seconds)
        if code == 0:
            try:
                return validate_review_output(stdout, engine), model
            except ReviewFailure as exc:
                detail = str(exc)
                failures.append(f"{model}: invalid Dogsquard output: {redact_known_secrets(detail)}")
                if index == len(models) - 1:
                    raise ReviewFailure(f"qoder provider failed: {'; '.join(failures)}", engine)
                log(f"Qoder model {model} returned invalid Dogsquard output; trying next configured model.")
                continue

        detail = stderr.strip() or stdout.strip() or f"qodercli exited with {code}"
        failures.append(f"{model}: {redact_known_secrets(detail)}")
        if index == len(models) - 1 or not qoder_failure_is_retryable(code, stdout, stderr):
            raise ReviewFailure(f"qoder provider failed: {'; '.join(failures)}", engine)
        log(f"Qoder model {model} failed with retryable error; trying next configured model.")

    raise ReviewFailure("qoder provider failed before invocation", engine)


def extract_comment(text: str) -> str:
    cleaned = redact_known_secrets(text).strip()
    header = "## 🤖 Dogsquard AI Code Review"
    index = cleaned.find(header)
    if index >= 0:
        return cleaned[index:].strip() + "\n"
    return cleaned + "\n"


def verdict_from_comment(comment: str, engine: str) -> str:
    match = re.search(r"(?ms)^### Verdict\s*\n([A-Z_]+)\s*$", comment)
    if not match:
        raise ReviewFailure("Provider output missing valid verdict value.", engine)
    verdict = match.group(1).strip()
    if verdict not in VALID_VERDICTS:
        raise ReviewFailure(f"Provider output has invalid verdict: {verdict}", engine)
    return verdict


def pass_fail_for_verdict(verdict: str) -> str:
    return "PASS" if verdict in {"PASS", "SKIP"} else "FAIL"


def ensure_status_line(comment: str, verdict: str) -> str:
    desired = f"### {pass_fail_for_verdict(verdict)} — Dogsquard AI Code Review"
    lines = comment.strip().splitlines()
    first = lines[0].strip() if lines else ""
    recognized = (
        "PASS — Dogsquard AI Code Review",
        "FAIL — Dogsquard AI Code Review",
        "### PASS — Dogsquard AI Code Review",
        "### FAIL — Dogsquard AI Code Review",
    )
    if first.startswith(recognized):
        lines[0] = desired
        return "\n".join(lines).strip() + "\n"
    cleaned = "\n".join(
        line for line in lines
        if not line.strip().startswith(recognized)
    )
    return f"{desired}\n\n{cleaned.strip()}\n"


def set_engine_details(comment: str, engine: str, model: str) -> str:
    normalized = re.sub(r"(?m)^- Engine: .*$", f"- Engine: {engine}", comment)
    normalized = re.sub(r"(?m)^- Model: .*$", f"- Model: {model}", normalized)
    return normalized


def validate_review_output(text: str, engine: str) -> str:
    comment = extract_comment(text)
    missing = [section for section in REQUIRED_SECTIONS if section not in comment]
    if missing:
        raise ReviewFailure(f"Provider output missing required section(s): {', '.join(missing)}", engine)
    if COMMENT_MARKER not in comment:
        raise ReviewFailure("Provider output missing Dogsquard comment marker.", engine)

    verdict = verdict_from_comment(comment, engine)

    if "### Engine details" in comment and f"Engine: {engine}" not in comment:
        log(f"Provider output engine details did not explicitly match {engine}; normalizing is not attempted.")
    return ensure_status_line(comment, verdict)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args == ["--resolve-config"]:
        try:
            return print_resolved_config()
        except ReviewFailure as exc:
            log(redact_known_secrets(str(exc)))
            return 1
    if args:
        log(f"Unknown argument(s): {' '.join(args)}")
        return 2

    engine = "unknown"
    try:
        settings = load_ai_review_settings()
        engine = resolve_engine(settings)
        log(f"Selected AI review engine: {engine}")

        if not resolve_enabled(settings):
            write_review(disabled_comment(engine))
            log("AI review disabled by .github/ai-review/settings.json")
            return 0

        context = collect_pr_context(engine)

        if context["skip"]:
            write_review(skip_comment(engine, context["files"]))
            return 0

        prompt = build_prompt(engine, context)
        if engine == "claude-deepseek":
            provider = resolve_claude_provider(settings)
            provider_output, model = run_claude_deepseek(prompt, provider)
            comment = validate_review_output(provider_output, engine)
        elif engine == "qoder":
            comment, model = run_qoder(prompt, settings)
        else:
            raise ReviewFailure(f"Unhandled engine: {engine}", engine)

        comment = set_engine_details(comment, engine, model)
        write_review(comment)
        return 0
    except ReviewFailure as exc:
        engine = exc.engine or engine
        write_review(failure_comment(str(exc), engine))
        log(redact_known_secrets(str(exc)))
        return 1
    except Exception as exc:
        write_review(failure_comment(str(exc), engine))
        log(redact_known_secrets(str(exc)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
