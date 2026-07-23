import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerClient } from "./client.js";

export const CONFIG_VERSION = 1;
export const MINIMUM_CLAUDE_MEM_VERSION = "13.11.0";
export const CONFIG_FILE_NAME = "claude-mem-bridge.json";

export interface WorkerConfig {
	dataDir?: string;
}

export interface BridgeConfig {
	version: 1;
	activeWorker: string;
	workers: Record<string, WorkerConfig>;
}

export interface RuntimeEnvironment {
	HOME?: string;
	CLAUDE_MEM_DATA_DIR?: string;
	CLAUDE_MEM_WORKER_HOST?: string;
	CLAUDE_MEM_WORKER_PORT?: string;
	CLAUDE_MEM_API_KEY?: string;
	[key: string]: string | undefined;
}

export interface ResolvedRuntime {
	configPath: string;
	workerName: string;
	dataDir: string;
	dataDirSource: string;
	settingsPath: string;
	host: string;
	port: number;
	hostSource: string;
	portSource: string;
	endpoint: string;
}

export interface RuntimeFailure {
	ok: false;
	configPath: string;
	failure: string;
	selectionRequired?: boolean;
}

export type RuntimeResolution =
	| { ok: true; runtime: ResolvedRuntime }
	| RuntimeFailure;

export interface RuntimeStatus {
	active: boolean;
	configPath: string;
	workerName?: string;
	dataDir?: string;
	dataDirSource?: string;
	endpoint?: string;
	hostSource?: string;
	portSource?: string;
	health: "ok" | "unavailable" | "incompatible" | "not-checked";
	version?: string;
	failure?: string;
	selectionRequired?: boolean;
}

export interface ResolveRuntimeOptions {
	environment?: RuntimeEnvironment;
	home?: string;
	worker?: string;
	mode: "cli" | "headless" | "interactive";
	chooseWorker?: (workerNames: string[]) => Promise<string | undefined>;
}

const SAFE_DEFAULT_CONFIG: BridgeConfig = {
	version: 1,
	activeWorker: "",
	workers: { default: {} },
};

function userHome(
	environment: RuntimeEnvironment,
	explicitHome?: string,
): string {
	return explicitHome ?? environment.HOME ?? homedir();
}

export function bridgeConfigPath(
	environment: RuntimeEnvironment = process.env,
): string {
	return path.join(userHome(environment), ".pi", "agent", CONFIG_FILE_NAME);
}

export function safeDefaultConfigText(): string {
	return `${JSON.stringify(SAFE_DEFAULT_CONFIG, null, 2)}\n`;
}

/**
 * Creates the initial config without exposing a partial file or replacing a
 * concurrently-created config. The temporary file and hard link live in the
 * same directory, so publication is atomic on supported local filesystems.
 */
export function ensureBridgeConfig(
	environment: RuntimeEnvironment = process.env,
	explicitHome?: string,
): { path: string; created: boolean } {
	const configPath = path.join(
		userHome(environment, explicitHome),
		".pi",
		"agent",
		CONFIG_FILE_NAME,
	);
	if (existsSync(configPath)) return { path: configPath, created: false };

	const directory = path.dirname(configPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = path.join(
		directory,
		`.${CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
	);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, safeDefaultConfigText(), "utf8");
		closeSync(descriptor);
		descriptor = undefined;
		try {
			linkSync(temporaryPath, configPath);
			return { path: configPath, created: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return { path: configPath, created: false };
			}
			throw error;
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(temporaryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(value: unknown): BridgeConfig | string {
	if (!isPlainObject(value)) return "configuration root must be an object";
	if (value.version !== CONFIG_VERSION)
		return `unsupported configuration version ${String(value.version)}`;
	if (typeof value.activeWorker !== "string")
		return "activeWorker must be a string";
	if (
		!isPlainObject(value.workers) ||
		Object.keys(value.workers).length === 0
	) {
		return "workers must be a non-empty object";
	}

	const workers = Object.create(null) as Record<string, WorkerConfig>;
	for (const [name, entry] of Object.entries(value.workers)) {
		if (!name.trim()) return "worker names must not be empty";
		if (!isPlainObject(entry)) return `worker ${name} must be an object`;
		if (
			entry.dataDir !== undefined &&
			(typeof entry.dataDir !== "string" || !entry.dataDir.trim())
		) {
			return `worker ${name} dataDir must be a non-empty string`;
		}
		workers[name] =
			entry.dataDir === undefined ? {} : { dataDir: entry.dataDir };
	}

	return { version: 1, activeWorker: value.activeWorker, workers };
}

export function readBridgeConfig(
	configPath: string,
): { ok: true; config: BridgeConfig } | { ok: false; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		const reason =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? "configuration file does not exist"
				: "configuration is malformed JSON";
		return { ok: false, error: reason };
	}
	const validated = validateConfig(parsed);
	return typeof validated === "string"
		? { ok: false, error: validated }
		: { ok: true, config: validated };
}

function expandUserPath(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return path.resolve(home, value);
}

function defaultWorkerPort(): number {
	return 37_700 + ((process.getuid?.() ?? 77) % 100);
}

function endpointHost(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) return host;
	return host.includes(":") ? `[${host}]` : host;
}

function readSettings(
	settingsPath: string,
):
	| { ok: true; settings: Record<string, unknown> }
	| { ok: false; error: string } {
	if (!existsSync(settingsPath)) return { ok: true, settings: {} };
	try {
		const value = JSON.parse(
			readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""),
		);
		if (!isPlainObject(value))
			return {
				ok: false,
				error: `Claude-mem settings are malformed: ${settingsPath}`,
			};
		const settings = isPlainObject(value.env) ? value.env : value;
		return { ok: true, settings };
	} catch {
		return {
			ok: false,
			error: `Claude-mem settings are malformed: ${settingsPath}`,
		};
	}
}

function resolveEndpoint(
	configPath: string,
	workerName: string,
	worker: WorkerConfig,
	environment: RuntimeEnvironment,
	home: string,
): RuntimeResolution {
	let dataDir: string;
	let dataDirSource: string;
	if (!worker.dataDir && workerName !== "default") {
		return {
			ok: false,
			configPath,
			failure: `worker ${workerName} must configure dataDir; run pi-claude-mem doctor`,
		};
	}
	if (worker.dataDir) {
		dataDir = expandUserPath(worker.dataDir, home);
		dataDirSource = `configuration:workers.${workerName}.dataDir`;
	} else if (environment.CLAUDE_MEM_DATA_DIR !== undefined) {
		if (!environment.CLAUDE_MEM_DATA_DIR.trim()) {
			return {
				ok: false,
				configPath,
				failure:
					"CLAUDE_MEM_DATA_DIR must not be empty; run pi-claude-mem doctor",
			};
		}
		dataDir = expandUserPath(environment.CLAUDE_MEM_DATA_DIR, home);
		dataDirSource = "environment:CLAUDE_MEM_DATA_DIR";
	} else {
		dataDir = path.join(home, ".claude-mem");
		dataDirSource = "default";
	}

	const settingsPath = path.join(dataDir, "settings.json");
	const loaded = readSettings(settingsPath);
	if (!loaded.ok)
		return {
			ok: false,
			configPath,
			failure: `${loaded.error}; run pi-claude-mem doctor`,
		};

	const settingsHost = loaded.settings.CLAUDE_MEM_WORKER_HOST;
	const settingsPort = loaded.settings.CLAUDE_MEM_WORKER_PORT;
	const hostValue =
		environment.CLAUDE_MEM_WORKER_HOST ?? settingsHost ?? "127.0.0.1";
	const portValue =
		environment.CLAUDE_MEM_WORKER_PORT ??
		settingsPort ??
		String(defaultWorkerPort());
	const hostSource =
		environment.CLAUDE_MEM_WORKER_HOST !== undefined
			? "environment:CLAUDE_MEM_WORKER_HOST"
			: settingsHost !== undefined
				? `settings:${settingsPath}`
				: "default";
	const portSource =
		environment.CLAUDE_MEM_WORKER_PORT !== undefined
			? "environment:CLAUDE_MEM_WORKER_PORT"
			: settingsPort !== undefined
				? `settings:${settingsPath}`
				: "default";

	if (typeof hostValue !== "string" || !hostValue.trim()) {
		return {
			ok: false,
			configPath,
			failure: `invalid Claude-mem worker host from ${hostSource}; run pi-claude-mem doctor`,
		};
	}
	const portText =
		typeof portValue === "number" ? String(portValue) : portValue;
	if (typeof portText !== "string" || !/^\d+$/.test(portText)) {
		return {
			ok: false,
			configPath,
			failure: `invalid Claude-mem worker port from ${portSource}; run pi-claude-mem doctor`,
		};
	}
	const port = Number(portText);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		return {
			ok: false,
			configPath,
			failure: `invalid Claude-mem worker port from ${portSource}; run pi-claude-mem doctor`,
		};
	}

	const host = hostValue.trim();
	return {
		ok: true,
		runtime: {
			configPath,
			workerName,
			dataDir,
			dataDirSource,
			settingsPath,
			host,
			port,
			hostSource,
			portSource,
			endpoint: `http://${endpointHost(host)}:${port}`,
		},
	};
}

export async function resolveRuntime(
	options: ResolveRuntimeOptions,
): Promise<RuntimeResolution> {
	const environment = options.environment ?? process.env;
	const home = userHome(environment, options.home);
	const configPath = path.join(home, ".pi", "agent", CONFIG_FILE_NAME);
	const loaded = readBridgeConfig(configPath);
	if (!loaded.ok) {
		return {
			ok: false,
			configPath,
			failure: `${loaded.error}; run pi-claude-mem doctor`,
		};
	}

	const names = Object.keys(loaded.config.workers);
	let selected = options.worker?.trim() || undefined;
	if (selected && !Object.hasOwn(loaded.config.workers, selected)) {
		return {
			ok: false,
			configPath,
			failure: `unknown worker ${selected}; run pi-claude-mem doctor`,
		};
	}
	if (!selected && loaded.config.activeWorker) {
		selected = loaded.config.activeWorker;
		if (!Object.hasOwn(loaded.config.workers, selected)) {
			return {
				ok: false,
				configPath,
				failure: `active worker ${selected} is not configured; run pi-claude-mem doctor`,
			};
		}
	}
	if (!selected && names.length === 1) selected = names[0];
	if (!selected && options.mode === "interactive" && options.chooseWorker) {
		try {
			selected = await options.chooseWorker(names);
		} catch (error) {
			return {
				ok: false,
				configPath,
				failure: `worker selection failed: ${error instanceof Error ? error.message : String(error)}; bridge disabled`,
				selectionRequired: true,
			};
		}
		if (selected && !Object.hasOwn(loaded.config.workers, selected)) {
			return {
				ok: false,
				configPath,
				failure: `unknown worker ${selected}; run pi-claude-mem doctor`,
			};
		}
		if (!selected) {
			return {
				ok: false,
				configPath,
				failure: "worker selection was cancelled; bridge disabled",
				selectionRequired: true,
			};
		}
	}
	if (!selected) {
		const failure =
			options.mode === "cli"
				? "multiple workers configured; pass --worker <name>"
				: "multiple workers configured and no interactive selection is available; bridge disabled";
		return { ok: false, configPath, failure, selectionRequired: true };
	}

	return resolveEndpoint(
		configPath,
		selected,
		loaded.config.workers[selected],
		environment,
		home,
	);
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function parseVersion(value: unknown): ParsedVersion | undefined {
	if (typeof value !== "string") return undefined;
	const match =
		/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			value,
		);
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4],
	};
}

function isAtLeastMinimum(value: ParsedVersion): boolean {
	const minimum = [13, 11, 0];
	const actual = [value.major, value.minor, value.patch];
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] > minimum[index]) return true;
		if (actual[index] < minimum[index]) return false;
	}
	return value.prerelease === undefined;
}

export async function inspectResolvedRuntime(
	runtime: ResolvedRuntime,
	environment: RuntimeEnvironment = process.env,
	fetchImpl?: typeof fetch,
): Promise<RuntimeStatus> {
	const client = new WorkerClient({
		baseUrl: runtime.endpoint,
		apiKey: environment.CLAUDE_MEM_API_KEY,
		fetchImpl,
	});
	const health = await client.health();
	const base = {
		configPath: runtime.configPath,
		workerName: runtime.workerName,
		dataDir: runtime.dataDir,
		dataDirSource: runtime.dataDirSource,
		endpoint: runtime.endpoint,
		hostSource: runtime.hostSource,
		portSource: runtime.portSource,
	};
	if (!health.ok) {
		return {
			...base,
			active: false,
			health: "unavailable" as const,
			failure: health.error,
		};
	}

	const status = health.value.status;
	const versionValue = health.value.version;
	const parsed = parseVersion(versionValue);
	if (status !== "ok") {
		return {
			...base,
			active: false,
			health: "incompatible",
			version: typeof versionValue === "string" ? versionValue : undefined,
			failure: "worker health identity is not ok",
		};
	}
	if (!parsed) {
		return {
			...base,
			active: false,
			health: "incompatible",
			version: typeof versionValue === "string" ? versionValue : undefined,
			failure: "unparseable worker version",
		};
	}
	if (!isAtLeastMinimum(parsed)) {
		return {
			...base,
			active: false,
			health: "incompatible",
			version: String(versionValue),
			failure: `requires Claude-mem >= ${MINIMUM_CLAUDE_MEM_VERSION}`,
		};
	}
	return { ...base, active: true, health: "ok", version: String(versionValue) };
}

export async function inspectRuntime(
	options: ResolveRuntimeOptions,
	fetchImpl?: typeof fetch,
): Promise<RuntimeStatus> {
	const resolution = await resolveRuntime(options);
	if (!resolution.ok) {
		return {
			active: false,
			configPath: resolution.configPath,
			health: "not-checked",
			failure: resolution.failure,
			selectionRequired: resolution.selectionRequired,
		};
	}

	return inspectResolvedRuntime(
		resolution.runtime,
		options.environment ?? process.env,
		fetchImpl,
	);
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
	return [
		`Bridge: ${status.active ? "active" : "inactive"}`,
		`Config: ${status.configPath}`,
		`Worker: ${status.workerName ?? "none"}`,
		`Data directory: ${status.dataDir ?? "unknown"}`,
		`Data directory source: ${status.dataDirSource ?? "unknown"}`,
		`Endpoint: ${status.endpoint ?? "unknown"}`,
		`Host source: ${status.hostSource ?? "unknown"}`,
		`Port source: ${status.portSource ?? "unknown"}`,
		`Health: ${status.health}`,
		`Version: ${status.version ?? "unknown"}`,
		`Failure: ${status.failure ?? "none"}`,
	].join("\n");
}
