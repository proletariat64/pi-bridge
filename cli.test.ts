import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cliPath = path.join(import.meta.dir, "bin", "pi-claude-mem.ts");
const tempHomes: string[] = [];

function tempHome(): string {
	const home = mkdtempSync(path.join(tmpdir(), "pi-bridge-cli-"));
	tempHomes.push(home);
	return home;
}

function writeBridgeConfig(home: string, config: unknown): string {
	const dir = path.join(home, ".pi", "agent");
	mkdirSync(dir, { recursive: true });
	const configPath = path.join(dir, "claude-mem-bridge.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return configPath;
}

async function runCli(
	home: string,
	args: string[],
	extraEnv: Record<string, string> = {},
) {
	const proc = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd: import.meta.dir,
		env: { ...process.env, HOME: home, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

afterEach(() => {
	for (const key of [
		"CLAUDE_MEM_WORKER_HOST",
		"CLAUDE_MEM_WORKER_PORT",
		"CLAUDE_MEM_DATA_DIR",
	]) {
		delete process.env[key];
	}
	for (const home of tempHomes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

describe("pi-claude-mem terminal status", () => {
	it("resolves a named Claude-mem data directory and reports settings value sources", async () => {
		const home = tempHome();
		const dataDir = path.join(home, "worker-data");
		mkdirSync(dataDir, { recursive: true });
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ status: "ok", version: "13.11.0" }),
		});
		writeFileSync(
			path.join(dataDir, "settings.json"),
			JSON.stringify({
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			}),
		);
		const configPath = writeBridgeConfig(home, {
			version: 1,
			activeWorker: "work",
			workers: { work: { dataDir } },
		});

		try {
			const result = await runCli(home, ["status"]);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("Bridge: active");
			expect(result.stdout).toContain(`Config: ${configPath}`);
			expect(result.stdout).toContain("Worker: work");
			expect(result.stdout).toContain(`Data directory: ${dataDir}`);
			expect(result.stdout).toContain(
				`Endpoint: http://127.0.0.1:${server.port}`,
			);
			expect(result.stdout).toContain(
				`Host source: settings:${path.join(dataDir, "settings.json")}`,
			);
			expect(result.stdout).toContain(
				`Port source: settings:${path.join(dataDir, "settings.json")}`,
			);
			expect(result.stdout).toContain("Health: ok");
			expect(result.stdout).toContain("Version: 13.11.0");
			expect(result.stdout).toContain("Failure: none");
			expect(readFileSync(configPath, "utf8")).toContain(
				'"activeWorker": "work"',
			);
		} finally {
			server.stop(true);
		}
	});

	it("accepts the supported v prefix and valid SemVer build metadata", async () => {
		for (const version of ["v13.11.0", "13.11.0+build.01"]) {
			const home = tempHome();
			const server = Bun.serve({
				port: 0,
				fetch: () => Response.json({ status: "ok", version }),
			});
			writeBridgeConfig(home, {
				version: 1,
				activeWorker: "",
				workers: { default: {} },
			});
			try {
				const result = await runCli(home, ["status"], {
					CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
					CLAUDE_MEM_WORKER_PORT: String(server.port),
				});
				expect(result.stdout).toContain("Bridge: active");
				expect(result.stdout).toContain(`Version: ${version}`);
				expect(result.stdout).toContain("Failure: none");
			} finally {
				server.stop(true);
			}
		}
	});

	it("applies environment host and port ahead of settings for every selected worker", async () => {
		const home = tempHome();
		const dataDir = path.join(home, "named");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			path.join(dataDir, "settings.json"),
			JSON.stringify({
				CLAUDE_MEM_WORKER_HOST: "settings-host",
				CLAUDE_MEM_WORKER_PORT: "41000",
			}),
		);
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ status: "ok", version: "14.0.0" }),
		});
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "named",
			workers: { named: { dataDir } },
		});

		try {
			const result = await runCli(home, ["status"], {
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			});
			expect(result.stdout).toContain(
				"Host source: environment:CLAUDE_MEM_WORKER_HOST",
			);
			expect(result.stdout).toContain(
				"Port source: environment:CLAUDE_MEM_WORKER_PORT",
			);
			expect(result.stdout).toContain("Version: 14.0.0");
		} finally {
			server.stop(true);
		}
	});

	it("requires --worker for ambiguous CLI selection and never probes a candidate", async () => {
		const home = tempHome();
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "",
			workers: { first: {}, second: {} },
		});
		const marker = path.join(home, "spawned");

		const result = await runCli(home, ["status"], {
			CLAUDE_MEM_TEST_PROCESS_MARKER: marker,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("Bridge: inactive");
		expect(result.stdout).toContain(
			"Failure: multiple workers configured; pass --worker <name>",
		);
		expect(result.stdout).not.toContain("Worker: first");
		expect(existsSync(marker)).toBe(false);
	});

	it("uses an explicit CLI worker for ambiguity and rejects unknown names without probing", async () => {
		const home = tempHome();
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ status: "ok", version: "13.11.0" }),
		});
		const configPath = writeBridgeConfig(home, {
			version: 1,
			activeWorker: "",
			workers: {
				first: { dataDir: "~/.first" },
				second: { dataDir: "~/.second" },
			},
		});
		const original = readFileSync(configPath, "utf8");
		try {
			const selected = await runCli(home, ["status", "--worker", "second"], {
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			});
			expect(selected.exitCode).toBe(0);
			expect(selected.stdout).toContain("Worker: second");
			expect(readFileSync(configPath, "utf8")).toBe(original);

			const unknown = await runCli(home, ["status", "--worker", "missing"]);
			expect(unknown.stdout).toContain("Failure: unknown worker missing");
			expect(unknown.stdout).toContain("Health: not-checked");
		} finally {
			server.stop(true);
		}
	});

	it("expands tilde data directories and honors CLAUDE_MEM_DATA_DIR for the default worker", async () => {
		const home = tempHome();
		const tildeDir = path.join(home, "named-worker");
		mkdirSync(tildeDir, { recursive: true });
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ status: "ok", version: "13.11.0" }),
		});
		writeFileSync(
			path.join(tildeDir, "settings.json"),
			JSON.stringify({
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			}),
		);
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "named",
			workers: { named: { dataDir: "~/named-worker" } },
		});
		try {
			const tilde = await runCli(home, ["status"]);
			expect(tilde.stdout).toContain(`Data directory: ${tildeDir}`);
			expect(tilde.stdout).toContain(
				"Data directory source: configuration:workers.named.dataDir",
			);

			const defaultDir = path.join(home, "environment-worker");
			mkdirSync(defaultDir, { recursive: true });
			writeFileSync(
				path.join(defaultDir, "settings.json"),
				JSON.stringify({
					CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
					CLAUDE_MEM_WORKER_PORT: String(server.port),
				}),
			);
			writeBridgeConfig(home, {
				version: 1,
				activeWorker: "",
				workers: { default: {} },
			});
			const environmentDefault = await runCli(home, ["status"], {
				CLAUDE_MEM_DATA_DIR: defaultDir,
			});
			expect(environmentDefault.stdout).toContain(
				`Data directory: ${defaultDir}`,
			);
			expect(environmentDefault.stdout).toContain(
				"Data directory source: environment:CLAUDE_MEM_DATA_DIR",
			);
		} finally {
			server.stop(true);
		}
	});

	it("preserves malformed, unsupported, and unknown-active-worker configurations", async () => {
		const cases: Array<{ text: string; failure: string }> = [
			{ text: '{"version":', failure: "configuration is malformed JSON" },
			{
				text: '{"version":2,"activeWorker":"","workers":{"default":{}}}\n',
				failure: "unsupported configuration version 2",
			},
			{
				text: '{"version":1,"activeWorker":"missing","workers":{"default":{}}}\n',
				failure: "active worker missing is not configured",
			},
		];
		for (const testCase of cases) {
			const home = tempHome();
			const configPath = path.join(
				home,
				".pi",
				"agent",
				"claude-mem-bridge.json",
			);
			mkdirSync(path.dirname(configPath), { recursive: true });
			writeFileSync(configPath, testCase.text);
			const result = await runCli(home, ["status"]);
			expect(result.stdout).toContain("Bridge: inactive");
			expect(result.stdout).toContain(testCase.failure);
			expect(readFileSync(configPath, "utf8")).toBe(testCase.text);
		}
	});

	it("keeps terminal status non-mutating when configuration is absent", async () => {
		const home = tempHome();
		const configPath = path.join(
			home,
			".pi",
			"agent",
			"claude-mem-bridge.json",
		);
		const result = await runCli(home, ["status"]);
		expect(result.stdout).toContain("configuration file does not exist");
		expect(existsSync(configPath)).toBe(false);
	});

	it("never invokes Claude-mem lifecycle or process-management commands during status", async () => {
		const home = tempHome();
		const fakeBin = path.join(home, "fake-bin");
		const marker = path.join(home, "managed-process");
		mkdirSync(fakeBin, { recursive: true });
		const trap =
			'#!/bin/sh\nprintf managed > "$CLAUDE_MEM_TEST_PROCESS_MARKER"\nexit 99\n';
		for (const command of ["claude-mem", "pi", "bun", "node", "npm", "npx"]) {
			writeFileSync(path.join(fakeBin, command), trap, { mode: 0o755 });
		}
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ status: "ok", version: "13.11.0" }),
		});
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "",
			workers: { default: {} },
		});
		try {
			const result = await runCli(home, ["status"], {
				PATH: fakeBin,
				CLAUDE_MEM_TEST_PROCESS_MARKER: marker,
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Bridge: active");
			expect(existsSync(marker)).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it("rejects unknown, malformed, and older worker versions without rewriting configuration", async () => {
		for (const version of [
			undefined,
			"not-semver",
			"013.11.0",
			"13.011.0",
			"13.11.00",
			"13.11.0-01",
			"13.11.0-rc.01",
			"13.11.0-alpha..1",
			"13.11.0+build..1",
			"13.10.9",
		]) {
			const home = tempHome();
			const server = Bun.serve({
				port: 0,
				fetch: () =>
					Response.json({ status: "ok", ...(version ? { version } : {}) }),
			});
			const original =
				'{"version":1,"activeWorker":"","workers":{"default":{}}}\n';
			const configPath = writeBridgeConfig(home, JSON.parse(original));
			writeFileSync(configPath, original);
			try {
				const result = await runCli(home, ["status"], {
					CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
					CLAUDE_MEM_WORKER_PORT: String(server.port),
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Bridge: inactive");
				expect(result.stdout).toContain(
					version === "13.10.9"
						? "requires Claude-mem >= 13.11.0"
						: "unparseable worker version",
				);
				expect(readFileSync(configPath, "utf8")).toBe(original);
			} finally {
				server.stop(true);
			}
		}
	});
});
