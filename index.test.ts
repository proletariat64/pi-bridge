import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import claudeMemPiExtension from "./index.js";
import { STATE_ENTRY_TYPE } from "./state.js";

type Handler = (event: any, ctx: any) => any;

function createHarness(fetchImpl: typeof fetch) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const branch: any[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  let sessionFile = "/sessions/current.jsonl";
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    registerCommand(name: string, options: unknown) { commands.set(name, options); },
  };
  const ctx = {
    cwd: "/work/repo",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "pi-session",
      getBranch: () => branch,
    },
    ui: {
      setStatus: (_id: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
    },
  };
  const fire = async (name: string, event: any = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  claudeMemPiExtension(pi as any);
  return {
    branch,
    commands,
    ctx,
    entries,
    fire,
    notifications,
    restore: () => { globalThis.fetch = originalFetch; },
    setSessionFile: (value: string) => { sessionFile = value; },
    statuses,
  };
}

interface RequestRecord { url: string; method: string; body?: any }

function mockWorker(options: { context?: string; observeGate?: Promise<void>; fail?: boolean } = {}) {
  const requests: RequestRecord[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (options.fail) throw new Error("refused");
    if (url.includes("/observations")) await options.observeGate;
    if (url.includes("/context/inject")) return new Response(options.context ?? "memory");
    return Response.json({ status: "ok" });
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
  });
  afterEach(() => restore?.());

  it("starts state-only, then initializes each real prompt before injecting context", async () => {
    const worker = mockWorker({ context: "remember this" });
    const harness = createHarness(worker.fetchImpl); restore = harness.restore;
    await harness.fire("session_start", { reason: "startup" });
    expect(worker.requests).toHaveLength(0);

    const first = await harness.fire("before_agent_start", { prompt: "first" });
    const second = await harness.fire("before_agent_start", { prompt: "second" });
    const init = worker.requests.filter((request) => request.url.endsWith("/api/sessions/init"));
    expect(init.map((request) => request.body.prompt)).toEqual(["first", "second"]);
    expect(init[0].body.contentSessionId).toBe(init[1].body.contentSessionId);
    expect(init.every((request) => request.body.platformSource === "pi")).toBe(true);
    expect(worker.requests.findIndex((request) => request.url.includes("/sessions/init")))
      .toBeLessThan(worker.requests.findIndex((request) => request.url.includes("/context/inject")));
    expect(first).toEqual({ message: { customType: "claude-mem-context", content: "remember this", display: false } });
    expect(second).toEqual(first);
  });

  it("records successful and failed tools once, skips bridge tools, and flushes before one summarize", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worker = mockWorker({ observeGate: gate });
    const harness = createHarness(worker.fetchImpl); restore = harness.restore;
    await harness.fire("session_start", { reason: "startup" });
    await harness.fire("tool_execution_start", { toolCallId: "one", toolName: "bash", args: { command: "pwd", token: "secret" } });
    await harness.fire("tool_execution_end", { toolCallId: "one", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    await harness.fire("tool_execution_start", { toolCallId: "two", toolName: "bash", args: { command: "false" } });
    await harness.fire("tool_execution_end", { toolCallId: "two", toolName: "bash", result: { content: [{ type: "text", text: "failed" }] }, isError: true });
    await harness.fire("tool_execution_end", { toolCallId: "skip", toolName: "claude_mem_query", result: "ignored", isError: false });
    harness.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } });

    const shutdown = harness.fire("session_shutdown", { reason: "quit" });
    await Bun.sleep(5);
    expect(worker.requests.some((request) => request.url.includes("/summarize"))).toBe(false);
    release();
    await shutdown;
    await harness.fire("session_shutdown", { reason: "quit" });

    const observations = worker.requests.filter((request) => request.url.includes("/observations"));
    expect(observations.map((request) => request.body.tool_use_id)).toEqual(["one", "two"]);
    expect(observations[0].body.tool_input.token).toBe("[redacted]");
    expect(observations.every((request) => request.body.platformSource === "pi")).toBe(true);
    const summaries = worker.requests.filter((request) => request.url.includes("/summarize"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].body.last_assistant_message).toBe("finished");
    expect(worker.requests.some((request) => request.url.includes("/complete"))).toBe(false);
  });

  it("keeps compaction identity and restores it after reload while forks get a new ID", async () => {
    const worker = mockWorker();
    const first = createHarness(worker.fetchImpl); restore = first.restore;
    await first.fire("session_start", { reason: "startup" });
    const initial = first.entries.find((entry) => entry.customType === STATE_ENTRY_TYPE).data.contentSessionId;
    await first.fire("session_compact", { reason: "manual", willRetry: false });
    expect(first.entries.at(-1).data.contentSessionId).toBe(initial);

    await first.fire("session_start", { reason: "reload" });
    expect(first.entries.at(-1).data.contentSessionId).toBe(initial);
    first.setSessionFile("/sessions/fork.jsonl");
    await first.fire("session_start", { reason: "fork" });
    expect(first.entries.at(-1).data.contentSessionId).not.toBe(initial);
  });

  it("persists session disablement across reload and never overrides the environment kill switch", async () => {
    const worker = mockWorker();
    const harness = createHarness(worker.fetchImpl); restore = harness.restore;
    await harness.fire("session_start", { reason: "startup" });
    await harness.commands.get("claude-mem-toggle").handler("", harness.ctx);
    await harness.fire("session_start", { reason: "reload" });
    await harness.fire("before_agent_start", { prompt: "private" });
    expect(worker.requests).toHaveLength(0);

    harness.restore();
    process.env.CLAUDE_MEM_PI_ENABLED = "false";
    const killed = createHarness(worker.fetchImpl); restore = killed.restore;
    await killed.fire("session_start", { reason: "startup" });
    await killed.commands.get("claude-mem-toggle").handler("", killed.ctx);
    await killed.fire("before_agent_start", { prompt: "still private" });
    expect(worker.requests).toHaveLength(0);
  });

  it("does not summarize ahead of observations that miss the shutdown deadline", async () => {
    const requests: RequestRecord[] = [];
    const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/observations")) await Bun.sleep(1_800);
      return Response.json({ status: "ok" });
    }) as typeof fetch;
    const harness = createHarness(slowFetch); restore = harness.restore;
    await harness.fire("session_start", { reason: "startup" });
    for (const id of ["slow-1", "slow-2", "slow-3"]) {
      await harness.fire("tool_execution_start", { toolCallId: id, toolName: "bash", args: {} });
      await harness.fire("tool_execution_end", { toolCallId: id, toolName: "bash", result: "done", isError: false });
    }
    await harness.fire("session_shutdown", { reason: "quit" });
    expect(requests.some((request) => request.url.includes("/summarize"))).toBe(false);
    expect(harness.statuses).toContain("claude-mem: finalization failed");
  }, 7_000);

  it("keeps turns and shutdown non-throwing when the worker refuses connections", async () => {
    const worker = mockWorker({ fail: true });
    const harness = createHarness(worker.fetchImpl); restore = harness.restore;
    await harness.fire("session_start", { reason: "startup" });
    expect(await harness.fire("before_agent_start", { prompt: "continue" })).toBeUndefined();
    await harness.fire("session_shutdown", { reason: "quit" });
    expect(harness.statuses).toContain("claude-mem: worker unavailable");
    expect(harness.statuses).toContain("claude-mem: finalization failed");
  });
});
