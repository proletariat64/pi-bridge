import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import claudeMemPiExtension from "./index.js";
import { safeDefaultConfigText } from "./runtime.js";
import { STATE_ENTRY_TYPE } from "./state.js";

type Handler = (event: any, ctx: any) => any;

function createHarness(
	fetchImpl: typeof fetch,
	options: {
		home?: string;
		config?: unknown | string;
		selection?: string;
		mode?: "tui" | "rpc" | "json" | "print";
		hasUI?: boolean;
		cwd?: string;
		confirmation?: boolean;
	} = {},
) {
	const home =
		options.home ?? mkdtempSync(path.join(tmpdir(), "pi-bridge-pi-"));
	const configPath = path.join(home, ".pi", "agent", "claude-mem-bridge.json");
	if (options.config !== undefined) {
		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			typeof options.config === "string"
				? options.config
				: `${JSON.stringify(options.config, null, 2)}\n`,
		);
	}

	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const branch: any[] = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const selections: string[][] = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	let confirmation = options.confirmation ?? false;
	let sessionFile = "/sessions/current.jsonl";
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			branch.push(entry);
		},
		registerCommand(name: string, commandOptions: unknown) {
			commands.set(name, commandOptions);
		},
	};
	const ui: Record<string, unknown> = {
		setStatus: (_id: string, value: string | undefined) => statuses.push(value),
		notify: (message: string) => notifications.push(message),
		confirm: async (title: string, message: string) => {
			confirmations.push({ title, message });
			return confirmation;
		},
	};
	if (options.selection !== undefined) {
		ui.select = async (_title: string, workerNames: string[]) => {
			selections.push(workerNames);
			return options.selection;
		};
	}
	const ctx = {
		cwd: options.cwd ?? "/work/repo",
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => "pi-session",
			getBranch: () => branch,
		},
		ui,
	};
	const fire = async (name: string, event: any = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? [])
			result = await handler({ type: name, ...event }, ctx);
		return result;
	};
	const originalFetch = globalThis.fetch;
	const originalHome = process.env.HOME;
	process.env.HOME = home;
	globalThis.fetch = fetchImpl;
	claudeMemPiExtension(pi as any);
	return {
		branch,
		commands,
		confirmations,
		configPath,
		ctx,
		entries,
		fire,
		home,
		notifications,
		restore: () => {
			globalThis.fetch = originalFetch;
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			rmSync(home, { recursive: true, force: true });
		},
		selections,
		setConfirmation: (value: boolean) => {
			confirmation = value;
		},
		setSessionFile: (value: string) => {
			sessionFile = value;
		},
		statuses,
	};
}

interface RequestRecord {
	url: string;
	method: string;
	body?: any;
}

function mockWorker(
	options: {
		context?: string;
		failSummarize?: boolean;
		observeGate?: Promise<void>;
		fail?: boolean;
		version?: string;
	} = {},
) {
	const requests: RequestRecord[] = [];
	const fetchImpl = async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push({
			url,
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		if (options.fail) throw new Error("refused");
		if (options.failSummarize && url.includes("/summarize"))
			throw new Error("refused");
		if (url.includes("/observations")) await options.observeGate;
		if (url.includes("/context/inject"))
			return new Response(options.context ?? "memory");
		return Response.json({
			status: "ok",
			version: options.version ?? "13.11.0",
		});
	};
	return { fetchImpl: fetchImpl as typeof fetch, requests };
}

describe("Pi bridge lifecycle", () => {
	let restore: (() => void) | undefined;
	beforeEach(() => {
		delete process.env.CLAUDE_MEM_PI_ENABLED;
		delete process.env.CLAUDE_MEM_PI_PROJECT;
		delete process.env.CLAUDE_MEM_API_KEY;
		delete process.env.CLAUDE_MEM_WORKER_URL;
		delete process.env.CLAUDE_MEM_DATA_DIR;
		delete process.env.CLAUDE_MEM_WORKER_HOST;
		delete process.env.CLAUDE_MEM_WORKER_PORT;
	});
	afterEach(() => restore?.());

	it("atomically creates the safe first-start configuration and never overwrites an existing file", async () => {
		const worker = mockWorker();
		const created = createHarness(worker.fetchImpl);
		restore = created.restore;
		expect(readFileSync(created.configPath, "utf8")).toBe(
			safeDefaultConfigText(),
		);
		expect(existsSync(created.configPath)).toBe(true);

		created.restore();
		const malformed = '{"version":1,"activeWorker":';
		const preserved = createHarness(worker.fetchImpl, { config: malformed });
		restore = preserved.restore;
		expect(readFileSync(preserved.configPath, "utf8")).toBe(malformed);
		await preserved.fire("session_start", { reason: "startup" });
		expect(
			await preserved.fire("before_agent_start", {
				prompt: "ordinary work continues",
			}),
		).toBeUndefined();
		expect(worker.requests).toHaveLength(0);
		await preserved.commands
			.get("claude-mem-status")
			.handler("", preserved.ctx);
		expect(preserved.notifications.at(-1)).toContain(
			"configuration is malformed JSON",
		);
	});

	it("publishes exactly one complete configuration across concurrent package loads", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "pi-bridge-race-"));
		const scriptPath = path.join(home, "load-extension.ts");
		writeFileSync(
			scriptPath,
			`
      import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
      extension({ on() {}, appendEntry() {}, registerCommand() {} } as any);
    `,
		);

		try {
			const processes = Array.from({ length: 8 }, () =>
				Bun.spawn([process.execPath, scriptPath], {
					env: { ...process.env, HOME: home },
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const exitCodes = await Promise.all(
				processes.map((process) => process.exited),
			);
			expect(exitCodes).toEqual(Array(8).fill(0));

			const configDirectory = path.join(home, ".pi", "agent");
			expect(
				readFileSync(
					path.join(configDirectory, "claude-mem-bridge.json"),
					"utf8",
				),
			).toBe(safeDefaultConfigText());
			expect(readdirSync(configDirectory)).toEqual(["claude-mem-bridge.json"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("selects multiple workers only through the interactive Pi UI and keeps the choice process-local", async () => {
		process.env.CLAUDE_MEM_WORKER_HOST = "127.0.0.1";
		process.env.CLAUDE_MEM_WORKER_PORT = "41234";
		const worker = mockWorker();
		const config = {
			version: 1,
			activeWorker: "",
			workers: {
				first: { dataDir: "~/.first" },
				second: { dataDir: "~/.second" },
			},
		};
		const harness = createHarness(worker.fetchImpl, {
			config,
			selection: "second",
		});
		restore = harness.restore;

		await harness.fire("session_start", { reason: "startup" });
		expect(harness.selections).toEqual([["first", "second"]]);
		await harness.fire("before_agent_start", { prompt: "use selected worker" });
		await harness.commands.get("claude-mem-status").handler("", harness.ctx);
		expect(harness.selections).toHaveLength(1);
		expect(harness.notifications.at(-1)).toContain("Worker: second");
		expect(readFileSync(harness.configPath, "utf8")).toContain(
			'"activeWorker": ""',
		);
		expect(
			worker.requests.every((request) =>
				request.url.startsWith("http://127.0.0.1:41234/"),
			),
		).toBe(true);
	});

	it("never prompts for worker selection in rpc, json, or print modes even when UI selection exists", async () => {
		const config = {
			version: 1,
			activeWorker: "",
			workers: {
				first: { dataDir: "~/.first" },
				second: { dataDir: "~/.second" },
			},
		};

		for (const mode of ["rpc", "json", "print"] as const) {
			const worker = mockWorker();
			const harness = createHarness(worker.fetchImpl, {
				config,
				selection: "second",
				mode,
				hasUI: true,
			});
			await harness.fire("session_start", { reason: "startup" });
			expect(harness.selections).toHaveLength(0);
			expect(worker.requests).toHaveLength(0);
			expect(harness.statuses.at(-1)).toContain(
				"multiple workers configured and no interactive selection is available",
			);
			harness.restore();
		}
		restore = undefined;
	});

	it("pins the resolved runtime endpoint and sources for health, lifecycle, and status", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "pi-bridge-pinned-"));
		const dataDir = path.join(home, "worker-data");
		const settingsPath = path.join(dataDir, "settings.json");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			settingsPath,
			JSON.stringify({
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: "41001",
			}),
		);
		const worker = mockWorker({ context: "pinned memory" });
		const harness = createHarness(worker.fetchImpl, {
			home,
			config: {
				version: 1,
				activeWorker: "work",
				workers: { work: { dataDir } },
			},
		});
		restore = harness.restore;

		await harness.fire("session_start", { reason: "startup" });
		writeFileSync(
			settingsPath,
			JSON.stringify({
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: "41002",
			}),
		);
		await harness.fire("session_start", { reason: "reload" });
		await harness.fire("before_agent_start", { prompt: "stay pinned" });
		await harness.commands.get("claude-mem-status").handler("", harness.ctx);

		expect(worker.requests.length).toBeGreaterThanOrEqual(4);
		expect(
			worker.requests.every((request) =>
				request.url.startsWith("http://127.0.0.1:41001/"),
			),
		).toBe(true);
		expect(harness.notifications.at(-1)).toContain(
			"Endpoint: http://127.0.0.1:41001",
		);
		expect(harness.notifications.at(-1)).toContain(
			`Port source: settings:${settingsPath}`,
		);
		expect(harness.notifications.at(-1)).not.toContain("41002");
	});

	it("formats standard status fields when first-start configuration creation fails", async () => {
		const homeFile = path.join(
			tmpdir(),
			`pi-bridge-invalid-home-${process.pid}-${Date.now()}`,
		);
		writeFileSync(homeFile, "not a directory");
		const harness = createHarness(mockWorker().fetchImpl, { home: homeFile });
		restore = harness.restore;

		await harness.fire("session_start", { reason: "startup" });
		await harness.commands.get("claude-mem-status").handler("", harness.ctx);
		const status = harness.notifications.at(-1) ?? "";
		expect(status).toContain("Bridge: inactive");
		expect(status).toContain(
			`Config: ${path.join(homeFile, ".pi", "agent", "claude-mem-bridge.json")}`,
		);
		expect(status).toContain("Worker: none");
		expect(status).toContain("Health: not-checked");
		expect(status).toContain("Version: unknown");
		expect(status).toContain("Failure: configuration creation failed:");
		expect(status).toContain("Content session: pi-");
	});

	it("fails closed instead of guessing when multiple workers are configured headlessly", async () => {
		const marker = path.join(tmpdir(), `pi-bridge-spawn-${Date.now()}`);
		process.env.CLAUDE_MEM_TEST_PROCESS_MARKER = marker;
		const worker = mockWorker();
		const harness = createHarness(worker.fetchImpl, {
			config: {
				version: 1,
				activeWorker: "",
				workers: { first: {}, second: {} },
			},
			mode: "print",
			hasUI: false,
		});
		restore = harness.restore;

		await harness.fire("session_start", { reason: "startup" });
		expect(
			await harness.fire("before_agent_start", { prompt: "keep working" }),
		).toBeUndefined();
		expect(worker.requests).toHaveLength(0);
		expect(harness.statuses.at(-1)).toContain("multiple workers configured");
		expect(existsSync(marker)).toBe(false);
		delete process.env.CLAUDE_MEM_TEST_PROCESS_MARKER;
	});

	it("treats activeWorker as authoritative and never falls back to another worker", async () => {
		const requests: string[] = [];
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (url.startsWith("http://127.0.0.1:41001/")) throw new Error("refused");
			return Response.json({ status: "ok", version: "13.11.0" });
		}) as typeof fetch;
		const home = mkdtempSync(path.join(tmpdir(), "pi-bridge-authoritative-"));
		for (const [name, port] of [
			["broken", "41001"],
			["healthy", "41002"],
		] as const) {
			const dataDir = path.join(home, name);
			mkdirSync(dataDir, { recursive: true });
			writeFileSync(
				path.join(dataDir, "settings.json"),
				JSON.stringify({
					CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
					CLAUDE_MEM_WORKER_PORT: port,
				}),
			);
		}
		const harness = createHarness(fetchImpl, {
			home,
			config: {
				version: 1,
				activeWorker: "broken",
				workers: {
					broken: { dataDir: path.join(home, "broken") },
					healthy: { dataDir: path.join(home, "healthy") },
				},
			},
		});
		restore = harness.restore;

		await harness.fire("session_start", { reason: "startup" });
		await harness.fire("before_agent_start", { prompt: "do not redirect" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toStartWith("http://127.0.0.1:41001/");
		expect(requests.some((url) => url.includes(":41002/"))).toBe(false);
	});

	it("degrades gracefully without memory requests when the selected worker is incompatible", async () => {
		const worker = mockWorker({ version: "13.10.9" });
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		expect(
			await harness.fire("before_agent_start", { prompt: "ordinary Pi work" }),
		).toBeUndefined();
		expect(worker.requests).toHaveLength(1);
		expect(worker.requests[0].url).toEndWith("/api/health");
		expect(harness.statuses.at(-1)).toBe("claude-mem: worker incompatible");
	});

	it("starts state-only, then initializes each real prompt before injecting context", async () => {
		const worker = mockWorker({ context: "remember this" });
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		expect(worker.requests).toHaveLength(0);

		const first = await harness.fire("before_agent_start", { prompt: "first" });
		const second = await harness.fire("before_agent_start", {
			prompt: "second",
		});
		const init = worker.requests.filter((request) =>
			request.url.endsWith("/api/sessions/init"),
		);
		expect(init.map((request) => request.body.prompt)).toEqual([
			"first",
			"second",
		]);
		expect(init[0].body.contentSessionId).toBe(init[1].body.contentSessionId);
		expect(init.every((request) => request.body.platformSource === "pi")).toBe(
			true,
		);
		expect(
			worker.requests.findIndex((request) =>
				request.url.includes("/sessions/init"),
			),
		).toBeLessThan(
			worker.requests.findIndex((request) =>
				request.url.includes("/context/inject"),
			),
		);
		expect(first).toEqual({
			message: {
				customType: "claude-mem-context",
				content: "remember this",
				display: false,
			},
		});
		expect(second).toEqual(first);
	});

	it("matches Claude-mem repository and worktree project identity and Pi-only recall chains", async () => {
		const fixture = mkdtempSync(path.join(tmpdir(), "pi-bridge-project-"));
		const repository = path.join(fixture, "parent-repo");
		const nested = path.join(repository, "packages", "app");
		const worktree = path.join(fixture, "feature-worktree");
		mkdirSync(nested, { recursive: true });
		for (const args of [
			["init"],
			["config", "user.email", "pi-bridge@example.test"],
			["config", "user.name", "Pi Bridge"],
			["commit", "--allow-empty", "-m", "initial"],
			["worktree", "add", "-b", "feature", worktree],
		]) {
			const result = spawnSync("git", args, {
				cwd: repository,
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
		}

		const normalWorker = mockWorker();
		const normal = createHarness(normalWorker.fetchImpl, { cwd: nested });
		await normal.fire("session_start", { reason: "startup" });
		await normal.fire("before_agent_start", { prompt: "normal" });
		const normalInit = normalWorker.requests.find((request) =>
			request.url.endsWith("/api/sessions/init"),
		);
		expect(normalInit?.body.project).toBe("parent-repo");
		const normalContext = normalWorker.requests.find((request) =>
			request.url.includes("/api/context/inject"),
		);
		expect(normalContext?.url).toContain("projects=parent-repo");
		expect(normalContext?.url).toContain("platformSource=pi");
		normal.restore();

		const worktreeWorker = mockWorker();
		const worktreeHarness = createHarness(worktreeWorker.fetchImpl, {
			cwd: worktree,
		});
		restore = worktreeHarness.restore;
		await worktreeHarness.fire("session_start", { reason: "startup" });
		await worktreeHarness.fire("before_agent_start", { prompt: "worktree" });
		const worktreeInit = worktreeWorker.requests.find((request) =>
			request.url.endsWith("/api/sessions/init"),
		);
		expect(worktreeInit?.body.project).toBe("parent-repo/feature-worktree");
		const worktreeContext = worktreeWorker.requests.find((request) =>
			request.url.includes("/api/context/inject"),
		);
		expect(worktreeContext?.url).toContain(
			"projects=parent-repo%2Cparent-repo%2Ffeature-worktree",
		);
		expect(worktreeContext?.url).toContain("platformSource=pi");
		expect(worktreeContext?.url).not.toMatch(/claude|codex/i);
		rmSync(fixture, { recursive: true, force: true });
	});

	it("records successful and failed tools once, skips bridge tools, and flushes before one summarize", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const worker = mockWorker({ observeGate: gate });
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		await harness.fire("tool_execution_start", {
			toolCallId: "one",
			toolName: "bash",
			args: { command: "pwd", token: "secret" },
		});
		await harness.fire("tool_execution_end", {
			toolCallId: "one",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		await harness.fire("tool_execution_end", {
			toolCallId: "one",
			toolName: "bash",
			result: { content: [{ type: "text", text: "duplicate" }] },
			isError: false,
		});
		await harness.fire("tool_execution_start", {
			toolCallId: "two",
			toolName: "bash",
			args: { command: "false" },
		});
		await harness.fire("tool_execution_end", {
			toolCallId: "two",
			toolName: "bash",
			result: { content: [{ type: "text", text: "failed" }] },
			isError: true,
		});
		await harness.fire("tool_execution_end", {
			toolCallId: "skip",
			toolName: "claude_mem_query",
			result: "ignored",
			isError: false,
		});
		harness.branch.push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "finished" }],
			},
		});

		const shutdown = harness.fire("session_shutdown", { reason: "quit" });
		await Bun.sleep(5);
		expect(
			worker.requests.some((request) => request.url.includes("/summarize")),
		).toBe(false);
		release();
		await shutdown;
		await harness.fire("session_shutdown", { reason: "quit" });

		const observations = worker.requests.filter((request) =>
			request.url.includes("/observations"),
		);
		expect(observations.map((request) => request.body.tool_use_id)).toEqual([
			"one",
			"two",
		]);
		expect(observations[0].body.tool_input.token).toBe("[redacted]");
		expect(
			observations.every((request) => request.body.platformSource === "pi"),
		).toBe(true);
		const summaries = worker.requests.filter((request) =>
			request.url.includes("/summarize"),
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0].body.last_assistant_message).toBe("finished");
		expect(summaries[0].body.platformSource).toBe("pi");
		expect(
			worker.requests.some((request) => request.url.includes("/complete")),
		).toBe(false);
	});

	it("flushes observations before compaction summaries without changing stable identity", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const worker = mockWorker({ observeGate: gate });
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		const initial = harness.entries.find(
			(entry) => entry.customType === STATE_ENTRY_TYPE,
		).data.contentSessionId;
		await harness.fire("tool_execution_start", {
			toolCallId: "compact-tool",
			toolName: "bash",
			args: { command: "pwd" },
		});
		await harness.fire("tool_execution_end", {
			toolCallId: "compact-tool",
			toolName: "bash",
			result: "done",
			isError: false,
		});
		const branchEntries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "before compact" }],
				},
			},
		];
		const compact = harness.fire("session_before_compact", {
			reason: "manual",
			willRetry: false,
			branchEntries,
			preparation: {},
			signal: new AbortController().signal,
		});
		await Bun.sleep(5);
		expect(
			worker.requests.some((request) => request.url.includes("/summarize")),
		).toBe(false);
		release();
		await compact;

		const observationIndex = worker.requests.findIndex((request) =>
			request.url.includes("/observations"),
		);
		const summaryIndex = worker.requests.findIndex((request) =>
			request.url.includes("/summarize"),
		);
		expect(observationIndex).toBeGreaterThan(-1);
		expect(summaryIndex).toBeGreaterThan(observationIndex);
		expect(worker.requests[summaryIndex].body).toEqual({
			contentSessionId: initial,
			last_assistant_message: "before compact",
			platformSource: "pi",
		});
		expect(harness.entries.at(-1).data.contentSessionId).toBe(initial);
		expect(harness.entries.at(-1).data.finalized).toBe(false);

		await harness.fire("session_start", { reason: "reload" });
		expect(harness.entries.at(-1).data.contentSessionId).toBe(initial);
		harness.setSessionFile("/sessions/fork.jsonl");
		await harness.fire("session_start", { reason: "fork" });
		expect(harness.entries.at(-1).data.contentSessionId).not.toBe(initial);
	});

	it("uses Pi package loading as the only enable control and ignores legacy disabled state", async () => {
		process.env.CLAUDE_MEM_PI_ENABLED = "false";
		const worker = mockWorker();
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		harness.branch.push({
			type: "custom",
			customType: STATE_ENTRY_TYPE,
			data: {
				contentSessionId: `pi-${"1".repeat(64)}`,
				project: "repo",
				finalized: false,
				enabled: false,
			},
		});

		expect(harness.commands.has("claude-mem-toggle")).toBe(false);
		await harness.fire("session_start", { reason: "reload" });
		await harness.fire("before_agent_start", { prompt: "package is loaded" });
		expect(
			worker.requests.some((request) => request.url.includes("/sessions/init")),
		).toBe(true);
		expect(harness.entries.at(-1).data.enabled).toBeUndefined();
	});

	it("reports current run state and session identity without prompting or mutating Pi status", async () => {
		process.env.CLAUDE_MEM_WORKER_HOST = "127.0.0.1";
		process.env.CLAUDE_MEM_WORKER_PORT = "41234";
		let healthChecks = 0;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("/api/health")) {
				healthChecks += 1;
				return Response.json({
					status: "ok",
					version: healthChecks === 1 ? "13.10.9" : "13.11.0",
				});
			}
			return Response.json({ status: "ok", version: "13.11.0" });
		}) as typeof fetch;
		const harness = createHarness(fetchImpl, {
			config: {
				version: 1,
				activeWorker: "",
				workers: {
					first: { dataDir: "~/.first" },
					second: { dataDir: "~/.second" },
				},
			},
			selection: "second",
		});
		restore = harness.restore;

		await harness.fire("session_start", { reason: "startup" });
		await harness.fire("before_agent_start", { prompt: "ordinary work" });
		const statusCount = harness.statuses.length;
		const selectionCount = harness.selections.length;
		const sessionId = harness.entries.at(-1).data.contentSessionId;

		await harness.commands.get("claude-mem-status").handler("", harness.ctx);

		expect(harness.selections).toHaveLength(selectionCount);
		expect(harness.statuses).toHaveLength(statusCount);
		expect(harness.notifications.at(-1)).toContain("Bridge: inactive");
		expect(harness.notifications.at(-1)).toContain("Worker: second");
		expect(harness.notifications.at(-1)).toContain(
			`Content session: ${sessionId}`,
		);
		expect(harness.notifications.at(-1)).toContain("Health: ok");
		expect(harness.notifications.at(-1)).toContain(
			"requires Claude-mem >= 13.11.0",
		);
		expect(healthChecks).toBe(2);
	});

	it("shares read-only doctor and confirmed smoke operations with Pi commands", async () => {
		const worker = mockWorker({ context: "" });
		const harness = createHarness(worker.fetchImpl, {
			config: {
				version: 1,
				activeWorker: "",
				workers: { default: {} },
			},
		});
		restore = harness.restore;
		mkdirSync(path.join(harness.home, ".claude-mem"), { recursive: true });
		writeFileSync(
			path.join(harness.home, ".pi", "agent", "settings.json"),
			JSON.stringify({
				packages: ["git:github.com/proletariat64/pi-bridge"],
			}),
		);

		expect(harness.commands.has("claude-mem-doctor")).toBe(true);
		expect(harness.commands.has("claude-mem-smoke-test")).toBe(true);
		await harness.commands.get("claude-mem-doctor").handler("", harness.ctx);
		expect(harness.notifications.at(-1)).toContain("Doctor: pass");
		const afterDoctor = worker.requests.length;

		await harness.commands
			.get("claude-mem-smoke-test")
			.handler("", harness.ctx);
		expect(harness.confirmations).toHaveLength(1);
		expect(harness.notifications.at(-1)).toContain("Smoke test cancelled");
		expect(worker.requests).toHaveLength(afterDoctor);

		harness.setConfirmation(true);
		await harness.commands
			.get("claude-mem-smoke-test")
			.handler("", harness.ctx);
		expect(harness.confirmations).toHaveLength(2);
		expect(harness.notifications.at(-1)).toContain("Smoke test: pass");
		expect(
			worker.requests.slice(afterDoctor).map((request) =>
				new URL(request.url).pathname,
			),
		).toEqual([
			"/api/health",
			"/api/sessions/init",
			"/api/context/inject",
			"/api/sessions/observations",
			"/api/sessions/summarize",
		]);
	});

	it("does not summarize ahead of observations that miss the shutdown deadline", async () => {
		const requests: RequestRecord[] = [];
		const slowFetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			requests.push({ url, method: init?.method ?? "GET" });
			if (url.includes("/observations")) await Bun.sleep(1_800);
			return Response.json({ status: "ok" });
		}) as typeof fetch;
		const harness = createHarness(slowFetch);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		for (const id of ["slow-1", "slow-2", "slow-3"]) {
			await harness.fire("tool_execution_start", {
				toolCallId: id,
				toolName: "bash",
				args: {},
			});
			await harness.fire("tool_execution_end", {
				toolCallId: id,
				toolName: "bash",
				result: "done",
				isError: false,
			});
		}
		await harness.fire("session_shutdown", { reason: "quit" });
		expect(requests.some((request) => request.url.includes("/summarize"))).toBe(
			false,
		);
		expect(harness.statuses).toContain("claude-mem: finalization failed");
	}, 7_000);

	it("attempts shutdown finalization at most once when the summary fails", async () => {
		const worker = mockWorker({ failSummarize: true });
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		await harness.fire("before_agent_start", { prompt: "ordinary work" });

		await harness.fire("session_shutdown", { reason: "quit" });
		await harness.fire("session_shutdown", { reason: "quit" });

		expect(
			worker.requests.filter((request) => request.url.includes("/summarize")),
		).toHaveLength(1);
		expect(harness.statuses).toContain("claude-mem: finalization failed");
	});

	it("never invokes Claude-mem process management from lifecycle paths", async () => {
		const fixture = mkdtempSync(path.join(tmpdir(), "pi-bridge-no-manage-"));
		const marker = path.join(fixture, "claude-mem-invoked");
		const executable = path.join(fixture, "claude-mem");
		writeFileSync(
			executable,
			`#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`,
		);
		chmodSync(executable, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${fixture}:${originalPath ?? ""}`;
		const worker = mockWorker();
		const harness = createHarness(worker.fetchImpl);
		restore = () => {
			harness.restore();
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			rmSync(fixture, { recursive: true, force: true });
		};

		await harness.fire("session_start", { reason: "startup" });
		await harness.fire("before_agent_start", { prompt: "ordinary work" });
		await harness.fire("session_before_compact", {
			reason: "manual",
			willRetry: false,
			branchEntries: [],
			preparation: {},
			signal: new AbortController().signal,
		});
		await harness.fire("session_shutdown", { reason: "quit" });

		expect(existsSync(marker)).toBe(false);
		expect(
			worker.requests.every(
				(request) =>
					!request.url.match(
						/\/(?:admin|worker)\/(?:start|stop|restart|repair)/,
					),
			),
		).toBe(true);
	});

	it("keeps turns and shutdown non-throwing when the worker refuses connections", async () => {
		const worker = mockWorker({ fail: true });
		const harness = createHarness(worker.fetchImpl);
		restore = harness.restore;
		await harness.fire("session_start", { reason: "startup" });
		expect(
			await harness.fire("before_agent_start", { prompt: "continue" }),
		).toBeUndefined();
		await harness.fire("session_shutdown", { reason: "quit" });
		expect(harness.statuses).toContain("claude-mem: worker unavailable");
		expect(worker.requests).toHaveLength(1);
	});
});
