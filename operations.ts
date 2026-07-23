import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { WorkerClient } from "./client.js";
import {
	bridgeConfigPath,
	inspectResolvedRuntime,
	readBridgeConfig,
	resolveRuntime,
	type ResolveRuntimeOptions,
	type ResolvedRuntime,
	type RuntimeEnvironment,
} from "./runtime.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: DoctorCheckStatus;
	detail: string;
}

export interface DoctorReport {
	ok: boolean;
	checks: DoctorCheck[];
}

export interface SmokeTestReport {
	ok: boolean;
	detail: string;
	sessionId?: string;
}

const PACKAGE_SOURCE = "git:github.com/proletariat64/pi-bridge";
const DOCTOR_PROJECT = "__pi_bridge_doctor__";
export const SMOKE_PROJECT = "__pi_bridge_smoke__";

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (
		typeof entry === "object" &&
		entry !== null &&
		"source" in entry &&
		typeof entry.source === "string"
	) {
		return entry.source;
	}
	return undefined;
}

function checkPiRegistration(home: string): DoctorCheck {
	const settingsPath = path.join(home, ".pi", "agent", "settings.json");
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			packages?: unknown;
		};
		const registered =
			Array.isArray(settings.packages) &&
			settings.packages.some(
				(entry) => packageSource(entry) === PACKAGE_SOURCE,
			);
		return registered
			? {
					name: "Pi package registration",
					status: "pass",
					detail: `${PACKAGE_SOURCE} is registered in ${settingsPath}`,
				}
			: {
					name: "Pi package registration",
					status: "fail",
					detail: `install with pi install ${PACKAGE_SOURCE}`,
				};
	} catch {
		return {
			name: "Pi package registration",
			status: "fail",
			detail: `cannot read valid Pi settings at ${settingsPath}; install with pi install ${PACKAGE_SOURCE}`,
		};
	}
}

function resolvedEndpointChecks(
	configPath: string,
	options: ResolveRuntimeOptions,
): Promise<DoctorCheck[]> {
	const loaded = readBridgeConfig(configPath);
	if (!loaded.ok) return Promise.resolve([]);

	return Promise.all(
		Object.keys(loaded.config.workers).map((worker) =>
			resolveRuntime({ ...options, mode: "cli", worker }),
		),
	).then((resolutions) => {
		const endpoints = new Map<string, string[]>();
		for (const resolution of resolutions) {
			if (!resolution.ok) continue;
			const workers = endpoints.get(resolution.runtime.endpoint) ?? [];
			workers.push(resolution.runtime.workerName);
			endpoints.set(resolution.runtime.endpoint, workers);
		}
		const duplicates = [...endpoints].filter(([, workers]) => workers.length > 1);
		return duplicates.length === 0
			? [
					{
						name: "Duplicate endpoint",
						status: "pass" as const,
						detail: "configured workers resolve to distinct endpoints",
					},
				]
			: duplicates.map(([endpoint, workers]) => ({
					name: "Duplicate endpoint",
					status: "warn" as const,
					detail: `${workers.join(", ")} all resolve to ${endpoint}; verify these aliases are intentional`,
				}));
	});
}

async function probeRequiredApi(
	runtime: ResolvedRuntime,
	environment: RuntimeEnvironment,
	fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
	const requests = [
		{
			path: `/api/context/inject?projects=${encodeURIComponent(DOCTOR_PROJECT)}&platformSource=pi`,
			method: "GET" as const,
		},
	];
	const failures: string[] = [];
	for (const request of requests) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2_000);
		try {
			const headers = new Headers();
			if (environment.CLAUDE_MEM_API_KEY)
				headers.set("Authorization", `Bearer ${environment.CLAUDE_MEM_API_KEY}`);
			const response = await fetchImpl(`${runtime.endpoint}${request.path}`, {
				method: request.method,
				headers,
				signal: controller.signal,
			});
			if (!response.ok) failures.push(`${request.method} ${request.path}`);
		} catch {
			failures.push(`${request.method} ${request.path}`);
		} finally {
			clearTimeout(timeout);
		}
	}

	return failures.length === 0
		? {
				name: "Required worker API",
				status: "pass",
				detail: "read-only context route responds; lifecycle routes are covered by the compatible Claude-mem version contract",
			}
		: {
				name: "Required worker API",
				status: "fail",
				detail: `incompatible routes: ${failures.join(", ")}; upgrade or repair Claude-mem outside Pi Bridge`,
			};
}

export async function runDoctor(
	options: ResolveRuntimeOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<DoctorReport> {
	const environment = options.environment ?? process.env;
	const home = options.home ?? environment.HOME ?? homedir();
	const configPath = bridgeConfigPath({ ...environment, HOME: home });
	const checks: DoctorCheck[] = [];
	const loaded = readBridgeConfig(configPath);
	checks.push(
		loaded.ok
			? {
					name: "Bridge configuration",
					status: "pass",
					detail: `${configPath} uses schema version ${loaded.config.version}`,
				}
			: {
					name: "Bridge configuration",
					status: "fail",
					detail: `${loaded.error}; fix ${configPath} without asking doctor to rewrite it`,
				},
	);
	checks.push(checkPiRegistration(home));
	checks.push(...(await resolvedEndpointChecks(configPath, options)));

	const resolution = await resolveRuntime(options);
	if (!resolution.ok) {
		checks.push({
			name: "Worker selection",
			status: "fail",
			detail: resolution.failure,
		});
		return { ok: false, checks };
	}

	const runtime = resolution.runtime;
	checks.push({
		name: "Worker selection",
		status: "pass",
		detail: `${runtime.workerName} at ${runtime.endpoint}; host from ${runtime.hostSource}; port from ${runtime.portSource}`,
	});
	checks.push(
		existsSync(runtime.dataDir)
			? {
					name: "Claude-mem data directory",
					status: "pass",
					detail: `${runtime.dataDir} from ${runtime.dataDirSource}`,
				}
			: {
					name: "Claude-mem data directory",
					status: "fail",
					detail: `${runtime.dataDir} does not exist; create or repair it with Claude-mem, not Pi Bridge`,
				},
	);
	checks.push({
		name: "Claude-mem settings",
		status: existsSync(runtime.settingsPath) ? "pass" : "warn",
		detail: existsSync(runtime.settingsPath)
			? `using ${runtime.settingsPath}`
			: `${runtime.settingsPath} is absent; Claude-mem defaults apply`,
	});

	const status = await inspectResolvedRuntime(runtime, environment, fetchImpl);
	checks.push(
		status.active
			? {
					name: "Worker health and version",
					status: "pass",
					detail: `healthy Claude-mem ${status.version}`,
				}
			: {
					name: "Worker health and version",
					status: "fail",
					detail: `${status.failure ?? "worker is incompatible"}; start, upgrade, or repair Claude-mem outside Pi Bridge`,
				},
	);
	if (status.active)
		checks.push(await probeRequiredApi(runtime, environment, fetchImpl));

	return { ok: checks.every((check) => check.status !== "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
	return [
		`Doctor: ${report.ok ? "pass" : "fail"}`,
		...report.checks.map(
			(check) => `[${check.status.toUpperCase()}] ${check.name} — ${check.detail}`,
		),
	].join("\n");
}

export async function runSmokeTest(
	options: ResolveRuntimeOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<SmokeTestReport> {
	const resolution = await resolveRuntime(options);
	if (!resolution.ok) return { ok: false, detail: resolution.failure };

	const environment = options.environment ?? process.env;
	const runtime = resolution.runtime;
	const status = await inspectResolvedRuntime(runtime, environment, fetchImpl);
	if (!status.active) {
		return {
			ok: false,
			detail: status.failure ?? "selected worker is unavailable or incompatible",
		};
	}

	const sessionId = randomUUID();
	const client = new WorkerClient({
		baseUrl: runtime.endpoint,
		apiKey: environment.CLAUDE_MEM_API_KEY,
		fetchImpl,
	});
	const steps = [
		{
			writes: true,
			run: () =>
				client.init({
					contentSessionId: sessionId,
					project: SMOKE_PROJECT,
					prompt: "Pi Bridge smoke test: verify Claude-mem lifecycle acceptance.",
					platformSource: "pi",
				}),
		},
		{ writes: false, run: () => client.context([SMOKE_PROJECT]) },
		{
			writes: true,
			run: () =>
				client.observe({
					contentSessionId: sessionId,
					tool_name: "pi_bridge_smoke_test",
					tool_input: { marker: "harmless permanent smoke record" },
					tool_response: "Pi Bridge smoke test observation accepted.",
					cwd: SMOKE_PROJECT,
					platformSource: "pi",
					tool_use_id: `${sessionId}-observation`,
				}),
		},
		{
			writes: true,
			run: () =>
				client.summarize({
					contentSessionId: sessionId,
					last_assistant_message: "Pi Bridge smoke test lifecycle completed.",
					platformSource: "pi",
				}),
		},
	] as const;

	let mayHaveWritten = false;
	for (const step of steps) {
		mayHaveWritten ||= step.writes;
		const result = await step.run();
		if (!result.ok) {
			return {
				ok: false,
				detail: `${result.error}${
					mayHaveWritten
						? `; records may remain permanently isolated under ${SMOKE_PROJECT}`
						: ""
				}`,
				sessionId,
			};
		}
	}

	return {
		ok: true,
		sessionId,
		detail: `all lifecycle requests were accepted; records remain permanently isolated under ${SMOKE_PROJECT}; asynchronous compression and search readback were not checked`,
	};
}

export function formatSmokeTestReport(report: SmokeTestReport): string {
	return [
		`Smoke test: ${report.ok ? "pass" : "fail"}`,
		`Session: ${report.sessionId ?? "none"}`,
		report.detail,
	].join("\n");
}
