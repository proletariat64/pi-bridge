import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { WorkerClient } from "./client.js";
import {
	bridgeConfigPath,
	ensureBridgeConfig,
	formatRuntimeStatus,
	inspectResolvedRuntime,
	resolveRuntime,
	type ResolvedRuntime,
	type RuntimeStatus,
} from "./runtime.js";
import {
	extractLastAssistantText,
	extractText,
	serializeToolInput,
} from "./serialize.js";
import {
	resolveBridgeState,
	STATE_ENTRY_TYPE,
	type BridgeState,
} from "./state.js";

const STATUS_ID = "claude-mem";
const CONTEXT_MESSAGE_TYPE = "claude-mem-context";
const PLATFORM_SOURCE = "pi" as const;
const FLUSH_TIMEOUT_MS = 5_000;

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

function projectFor(cwd: string): string {
	return process.env.CLAUDE_MEM_PI_PROJECT?.trim() || path.basename(cwd);
}

function logFailure(operation: string, error: string): void {
	console.debug(`[claude-mem] ${operation} failed: ${error}`);
}

function setFailureStatus(ctx: ExtensionContext, message?: string): void {
	ctx.ui.setStatus(STATUS_ID, message ? `claude-mem: ${message}` : undefined);
}

function completesBeforeDeadline(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(false), timeoutMs);
		promise.then(
			() => {
				clearTimeout(timeout);
				resolve(true);
			},
			() => {
				clearTimeout(timeout);
				resolve(true);
			},
		);
	});
}

export default function claudeMemPiExtension(pi: ExtensionAPI): void {
	const toolInputs = new Map<string, unknown>();
	let bootstrapFailure: string | undefined;
	try {
		ensureBridgeConfig();
	} catch (error) {
		bootstrapFailure = `configuration creation failed: ${error instanceof Error ? error.message : String(error)}`;
	}

	let state: BridgeState | undefined;
	let enabled = false;
	let disabledReason: string | undefined;
	let selectedWorker: string | undefined;
	let runtime: ResolvedRuntime | undefined;
	let client: WorkerClient | undefined;
	let observationQueue: Promise<void> = Promise.resolve();
	let finalizing: Promise<void> | undefined;

	const persistState = () => {
		if (state) pi.appendEntry(STATE_ENTRY_TYPE, { ...state });
	};

	const chooseWorker = async (
		ctx: ExtensionContext,
		workerNames: string[],
	): Promise<string | undefined> => {
		const select = (
			ctx.ui as unknown as {
				select?: (
					title: string,
					options: string[],
				) => Promise<string | undefined>;
			}
		).select;
		return select
			? select("Select a Claude-mem worker", workerNames)
			: undefined;
	};

	const resolutionMode = (ctx: ExtensionContext): "interactive" | "headless" =>
		ctx.mode === "tui" && ctx.hasUI ? "interactive" : "headless";

	const resolveForPi = async (ctx: ExtensionContext) =>
		resolveRuntime({
			mode: resolutionMode(ctx),
			worker: selectedWorker,
			chooseWorker: (names) => chooseWorker(ctx, names),
		});

	const enqueueObservation = (
		payload: Parameters<WorkerClient["observe"]>[0],
	) => {
		observationQueue = observationQueue
			.then(async () => {
				if (!client) return;
				const result = await client.observe(payload);
				if (!result.ok) logFailure("observation", result.error);
			})
			.catch((error: unknown) => {
				logFailure(
					"observation",
					error instanceof Error ? error.message : String(error),
				);
			});
	};

	pi.on("session_start", async (event, ctx) => {
		toolInputs.clear();
		observationQueue = Promise.resolve();
		finalizing = undefined;
		state = resolveBridgeState(
			event.reason as SessionStartReason,
			ctx.sessionManager,
			ctx.sessionManager.getBranch(),
			projectFor(ctx.cwd),
		);
		disabledReason = undefined;

		if (bootstrapFailure) {
			enabled = false;
			disabledReason = bootstrapFailure;
			persistState();
			setFailureStatus(ctx, "configuration invalid; run pi-claude-mem doctor");
			return;
		}

		if (runtime && client) {
			enabled = true;
			persistState();
			setFailureStatus(ctx);
			return;
		}

		const resolution = await resolveForPi(ctx);
		if (!resolution.ok) {
			enabled = false;
			disabledReason = resolution.failure;
			runtime = undefined;
			client = undefined;
			persistState();
			setFailureStatus(ctx, `${resolution.failure}`);
			return;
		}

		runtime = resolution.runtime;
		selectedWorker = runtime.workerName;
		client = new WorkerClient({ baseUrl: runtime.endpoint });
		enabled = true;
		disabledReason = undefined;
		persistState();
		setFailureStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || !state || !runtime || !client) return;

		const status = await inspectResolvedRuntime(runtime);
		if (!status.active) {
			enabled = false;
			disabledReason = status.failure ?? "worker is incompatible";
			logFailure("health check", disabledReason);
			setFailureStatus(
				ctx,
				status.health === "unavailable"
					? "worker unavailable"
					: "worker incompatible",
			);
			return;
		}

		const init = await client.init({
			contentSessionId: state.contentSessionId,
			project: state.project,
			prompt: event.prompt,
			platformSource: PLATFORM_SOURCE,
		});
		if (!init.ok) {
			enabled = false;
			disabledReason = init.error;
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
			enabled = false;
			disabledReason = context.error;
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
		if (!enabled || !state || !client || state.finalized) return;
		if (finalizing) return finalizing;
		const activeClient = client;

		finalizing = (async () => {
			const deadline = Date.now() + FLUSH_TIMEOUT_MS;
			const flushed = await completesBeforeDeadline(
				observationQueue,
				FLUSH_TIMEOUT_MS,
			);
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

			const result = await activeClient.summarize(
				{
					contentSessionId: state!.contentSessionId,
					last_assistant_message: extractLastAssistantText(
						ctx.sessionManager.getBranch(),
					),
					platformSource: PLATFORM_SOURCE,
				},
				remainingMs,
			);
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
			let inspected: RuntimeStatus;
			if (runtime) {
				inspected = await inspectResolvedRuntime(runtime);
			} else {
				inspected = {
					active: false,
					configPath: bridgeConfigPath(),
					health: "not-checked",
					failure:
						bootstrapFailure ??
						disabledReason ??
						"bridge has not selected a runtime for the current Pi run",
				};
			}
			const status: RuntimeStatus = {
				...inspected,
				active: enabled && inspected.active,
				failure:
					disabledReason ??
					(!enabled && inspected.active
						? "bridge is inactive for the current Pi run"
						: inspected.failure),
			};
			ctx.ui.notify(
				[
					formatRuntimeStatus(status),
					`Content session: ${state?.contentSessionId ?? "none"}`,
				].join("\n"),
				status.active ? "info" : "warning",
			);
		},
	});
}
