import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkerClient } from "./client.js";
import { extractLastAssistantText, extractText, serializeToolInput } from "./serialize.js";
import { resolveBridgeState, STATE_ENTRY_TYPE, type BridgeState } from "./state.js";

const STATUS_ID = "claude-mem";
const CONTEXT_MESSAGE_TYPE = "claude-mem-context";
const PLATFORM_SOURCE = "pi" as const;
const FLUSH_TIMEOUT_MS = 5_000;

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

function enabledFromEnvironment(): boolean {
  return process.env.CLAUDE_MEM_PI_ENABLED?.toLowerCase() !== "false";
}

function projectFor(cwd: string): string {
  return process.env.CLAUDE_MEM_PI_PROJECT?.trim() || path.basename(cwd);
}

function logFailure(operation: string, error: string): void {
  console.debug(`[claude-mem] ${operation} failed: ${error}`);
}

function setFailureStatus(ctx: ExtensionContext, message?: string): void {
  ctx.ui.setStatus(STATUS_ID, message ? `claude-mem: ${message}` : undefined);
}

function completesBeforeDeadline(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    }, () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export default function claudeMemPiExtension(pi: ExtensionAPI): void {
  const client = new WorkerClient();
  const toolInputs = new Map<string, unknown>();
  const environmentEnabled = enabledFromEnvironment();
  let state: BridgeState | undefined;
  let enabled = environmentEnabled;
  let observationQueue: Promise<void> = Promise.resolve();
  let finalizing: Promise<void> | undefined;

  const persistState = () => {
    if (state) pi.appendEntry(STATE_ENTRY_TYPE, { ...state });
  };

  const enqueueObservation = (payload: Parameters<WorkerClient["observe"]>[0]) => {
    observationQueue = observationQueue.then(async () => {
      const result = await client.observe(payload);
      if (!result.ok) logFailure("observation", result.error);
    }).catch((error: unknown) => {
      logFailure("observation", error instanceof Error ? error.message : String(error));
    });
  };

  pi.on("session_start", (event, ctx) => {
    toolInputs.clear();
    observationQueue = Promise.resolve();
    finalizing = undefined;
    state = resolveBridgeState(
      event.reason as SessionStartReason,
      ctx.sessionManager,
      ctx.sessionManager.getBranch(),
      projectFor(ctx.cwd),
      environmentEnabled,
    );
    enabled = environmentEnabled && state.enabled;
    persistState();
    setFailureStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || !state) return;

    const health = await client.health();
    if (!health.ok) {
      logFailure("health check", health.error);
      setFailureStatus(ctx, "worker unavailable");
      return;
    }

    const init = await client.init({
      contentSessionId: state.contentSessionId,
      project: state.project,
      prompt: event.prompt,
      platformSource: PLATFORM_SOURCE,
    });
    if (!init.ok) {
      logFailure("session init", init.error);
      setFailureStatus(ctx, "worker unavailable");
      return;
    }

    if (state.finalized) {
      state.finalized = false;
      persistState();
    }

    const context = await client.context(state.project);
    if (!context.ok) {
      logFailure("context injection", context.error);
      setFailureStatus(ctx, "worker unavailable");
      return;
    }

    setFailureStatus(ctx);
    if (!context.value.trim()) return;
    return {
      message: {
        customType: CONTEXT_MESSAGE_TYPE,
        content: context.value,
        display: false,
      },
    };
  });

  pi.on("tool_execution_start", (event) => {
    toolInputs.set(event.toolCallId, event.args);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const args = toolInputs.get(event.toolCallId);
    toolInputs.delete(event.toolCallId);
    if (!enabled || !state || event.toolName.startsWith("claude_mem_")) return;

    enqueueObservation({
      contentSessionId: state.contentSessionId,
      tool_name: event.toolName,
      tool_input: serializeToolInput(args),
      tool_response: extractText(event.result),
      cwd: ctx.cwd,
      platformSource: PLATFORM_SOURCE,
      tool_use_id: event.toolCallId,
    });
  });

  pi.on("session_compact", () => {
    // Pi retains extension custom entries on the active branch; no new worker session is created.
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!enabled || !state || state.finalized) return;
    if (finalizing) return finalizing;

    finalizing = (async () => {
      const deadline = Date.now() + FLUSH_TIMEOUT_MS;
      const flushed = await completesBeforeDeadline(observationQueue, FLUSH_TIMEOUT_MS);
      if (!flushed) {
        logFailure("observation flush", "timed out after 5000ms");
        setFailureStatus(ctx, "finalization failed");
        return;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        setFailureStatus(ctx, "finalization failed");
        return;
      }

      const result = await client.summarize({
        contentSessionId: state!.contentSessionId,
        last_assistant_message: extractLastAssistantText(ctx.sessionManager.getBranch()),
        platformSource: PLATFORM_SOURCE,
      }, remainingMs);
      if (!result.ok) {
        logFailure("session summarization", result.error);
        setFailureStatus(ctx, "finalization failed");
        return;
      }

      state!.finalized = true;
      persistState();
      setFailureStatus(ctx);
    })().finally(() => {
      finalizing = undefined;
    });

    return finalizing;
  });

  pi.registerCommand("claude-mem-status", {
    description: "Show the Claude-mem bridge status",
    handler: async (_args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("Claude-mem bridge is disabled for this session", "info");
        return;
      }
      const health = await client.health();
      if (health.ok) {
        setFailureStatus(ctx);
        ctx.ui.notify(`Claude-mem worker available at ${client.baseUrl}`, "info");
      } else {
        setFailureStatus(ctx, "worker unavailable");
        ctx.ui.notify("Claude-mem worker is unavailable", "warning");
      }
    },
  });

  pi.registerCommand("claude-mem-toggle", {
    description: "Enable or disable the Claude-mem bridge for this session",
    handler: async (_args, ctx) => {
      if (!environmentEnabled) {
        ctx.ui.notify("Claude-mem bridge is disabled by CLAUDE_MEM_PI_ENABLED", "warning");
        return;
      }
      enabled = !enabled;
      if (state) {
        state.enabled = enabled;
        persistState();
      }
      if (!enabled) setFailureStatus(ctx);
      ctx.ui.notify(`Claude-mem bridge ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
