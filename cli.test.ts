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

function installProcessTrap(home: string): { path: string; marker: string } {
	const fakeBin = path.join(home, "fake-bin");
	const marker = path.join(home, "managed-process");
	mkdirSync(fakeBin, { recursive: true });
	const trap =
		'#!/bin/sh\nprintf managed > "$CLAUDE_MEM_TEST_PROCESS_MARKER"\nexit 99\n';
	for (const command of ["claude-mem", "pi", "bun", "node", "npm", "npx"])
		writeFileSync(path.join(fakeBin, command), trap, { mode: 0o755 });
	return { path: fakeBin, marker };
}

async function runCli(
	home: string,
	args: string[],
	extraEnv: Record<string, string> = {},
	input?: string,
) {
	const proc = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd: import.meta.dir,
		env: { ...process.env, HOME: home, ...extraEnv },
		stdin: input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (input !== undefined && proc.stdin) {
		proc.stdin.write(input);
		proc.stdin.end();
	}
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

describe("pi-claude-mem terminal doctor", () => {
	it("reports installation, runtime provenance, duplicate endpoints, and read-only API compatibility", async () => {
		const home = tempHome();
		const processTrap = installProcessTrap(home);
		const firstDataDir = path.join(home, "first-worker");
		const secondDataDir = path.join(home, "second-worker");
		mkdirSync(firstDataDir, { recursive: true });
		mkdirSync(secondDataDir, { recursive: true });
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({
				packages: ["git:github.com/proletariat64/pi-bridge"],
			}),
		);
		const requests: Array<{ method: string; path: string }> = [];
		let acceptedWrites = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const url = new URL(request.url);
				requests.push({ method: request.method, path: url.pathname });
				if (url.pathname === "/api/health")
					return Response.json({ status: "ok", version: "13.11.0" });
				if (url.pathname === "/api/context/inject")
					return new Response("", { status: 204 });
				if (request.method === "POST") {
					const body = (await request.json()) as Record<string, unknown>;
					if (Object.keys(body).length === 0)
						return Response.json({ error: "ValidationError" }, { status: 400 });
					acceptedWrites += 1;
					return Response.json({ status: "accepted" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "first",
			workers: {
				first: { dataDir: firstDataDir },
				second: { dataDir: secondDataDir },
			},
		});

		try {
			const result = await runCli(home, ["doctor"], {
				PATH: processTrap.path,
				CLAUDE_MEM_TEST_PROCESS_MARKER: processTrap.marker,
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("Doctor: pass");
			expect(result.stdout).toContain("[PASS] Pi package registration");
			expect(result.stdout).toContain("[PASS] Claude-mem data directory");
			expect(result.stdout).toContain("[WARN] Duplicate endpoint");
			expect(result.stdout).toContain("[PASS] Worker health and version");
				expect(result.stdout).toContain("[PASS] Required worker API");
				expect(requests.map((request) => request.path)).toEqual([
					"/api/health",
					"/api/context/inject",
				]);
				expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
			expect(acceptedWrites).toBe(0);
			expect(existsSync(processTrap.marker)).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it("returns failure for an unreachable selected worker without mutating configuration", async () => {
		const home = tempHome();
		const dataDir = path.join(home, "worker-data");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ packages: ["git:github.com/proletariat64/pi-bridge"] }),
		);
		const original =
			'{"version":1,"activeWorker":"work","workers":{"work":{"dataDir":"' +
			dataDir.replaceAll("\\", "\\\\") +
			'"}}}\n';
		const configPath = path.join(
			home,
			".pi",
			"agent",
			"claude-mem-bridge.json",
		);
		writeFileSync(configPath, original);

		const result = await runCli(home, ["doctor"], {
			CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
			CLAUDE_MEM_WORKER_PORT: "1",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Doctor: fail");
		expect(result.stdout).toContain("[FAIL] Worker health and version");
		expect(result.stdout).toContain("repair Claude-mem outside Pi Bridge");
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});
});

describe("pi-claude-mem terminal smoke test", () => {
	it("requires confirmation, then sends one isolated Pi lifecycle without model readback", async () => {
		const home = tempHome();
		const processTrap = installProcessTrap(home);
		const requests: Array<{
			method: string;
			url: URL;
			body?: Record<string, unknown>;
		}> = [];
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body =
					request.method === "POST"
						? ((await request.json()) as Record<string, unknown>)
						: undefined;
				requests.push({ method: request.method, url: new URL(request.url), body });
				if (request.url.includes("/api/health"))
					return Response.json({ status: "ok", version: "13.11.0" });
				if (request.url.includes("/api/context/inject"))
					return new Response("");
				return Response.json({ status: "accepted" });
			},
		});
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "",
			workers: { default: {} },
		});
		const environment = {
			PATH: processTrap.path,
			CLAUDE_MEM_TEST_PROCESS_MARKER: processTrap.marker,
			CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
			CLAUDE_MEM_WORKER_PORT: String(server.port),
		};

		try {
			const refused = await runCli(
				home,
				["smoke-test"],
				environment,
				"n\n",
			);
			expect(refused.exitCode).toBe(2);
			expect(refused.stdout).toContain(
				"Smoke test cancelled; no worker writes were sent.",
			);
			expect(requests).toHaveLength(0);

			const confirmed = await runCli(home, ["smoke-test", "--yes"], environment);
			expect(confirmed.exitCode).toBe(0);
			expect(confirmed.stderr).toBe("");
			expect(confirmed.stdout).toContain("Smoke test: pass");
			expect(confirmed.stdout).toContain(
				"records remain permanently isolated under __pi_bridge_smoke__",
			);
			expect(requests.map((request) => request.url.pathname)).toEqual([
				"/api/health",
				"/api/sessions/init",
				"/api/context/inject",
				"/api/sessions/observations",
				"/api/sessions/summarize",
			]);
			const sessionId = String(requests[1].body?.contentSessionId);
			expect(sessionId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(requests[1].body).toMatchObject({
				contentSessionId: sessionId,
				project: "__pi_bridge_smoke__",
				platformSource: "pi",
			});
			expect(requests[2].url.searchParams.get("projects")).toBe(
				"__pi_bridge_smoke__",
			);
			expect(requests[2].url.searchParams.get("platformSource")).toBe("pi");
			expect(requests[3].body).toMatchObject({
				contentSessionId: sessionId,
				tool_name: "pi_bridge_smoke_test",
				platformSource: "pi",
			});
			expect(requests[4].body).toMatchObject({
				contentSessionId: sessionId,
				platformSource: "pi",
			});
			expect(existsSync(processTrap.marker)).toBe(false);

			requests.length = 0;
			const repeated = await runCli(home, ["smoke-test", "--yes"], environment);
			expect(repeated.exitCode).toBe(0);
			expect(requests[1].body?.contentSessionId).not.toBe(sessionId);
		} finally {
			server.stop(true);
		}
	});

	it("stops at the first refused lifecycle request and returns failure", async () => {
		const home = tempHome();
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const pathname = new URL(request.url).pathname;
				requests.push(pathname);
				if (pathname === "/api/health")
					return Response.json({ status: "ok", version: "13.11.0" });
				if (pathname === "/api/context/inject") return new Response("");
				if (pathname === "/api/sessions/observations")
					return new Response("refused", { status: 503 });
				return Response.json({ status: "accepted" });
			},
		});
		writeBridgeConfig(home, {
			version: 1,
			activeWorker: "",
			workers: { default: {} },
		});
		try {
			const result = await runCli(home, ["smoke-test", "--yes"], {
				CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
				CLAUDE_MEM_WORKER_PORT: String(server.port),
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("Smoke test: fail");
			expect(result.stdout).toContain("returned 503");
			expect(result.stdout).toContain(
				"records may remain permanently isolated under __pi_bridge_smoke__",
			);
			expect(requests).not.toContain("/api/sessions/summarize");
		} finally {
			server.stop(true);
		}
	});
});
