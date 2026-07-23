export type WorkerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface WorkerClientOptions {
  baseUrl?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface InitPayload {
  contentSessionId: string;
  project: string;
  prompt: string;
  platformSource: "pi";
}

export interface ObservationPayload {
  contentSessionId: string;
  tool_name: string;
  tool_input: unknown;
  tool_response: string;
  cwd: string;
  platformSource: "pi";
  tool_use_id: string;
}

export interface SummarizePayload {
  contentSessionId: string;
  last_assistant_message: string;
  platformSource: "pi";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export class WorkerClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WorkerClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.CLAUDE_MEM_WORKER_URL ?? "http://127.0.0.1:37700",
    );
    this.apiKey = options.apiKey ?? process.env.CLAUDE_MEM_API_KEY;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  health(): Promise<WorkerResult<Record<string, unknown>>> {
    return this.requestJson<Record<string, unknown>>("/api/health", { method: "GET" });
  }

  init(payload: InitPayload): Promise<WorkerResult<Record<string, unknown>>> {
    return this.postJson("/api/sessions/init", payload);
  }

  async context(projects: readonly string[]): Promise<WorkerResult<string>> {
    const query = new URLSearchParams({
      projects: projects.join(","),
      platformSource: "pi",
    });
    return this.requestText(`/api/context/inject?${query.toString()}`, {
      method: "GET",
    });
  }

  observe(payload: ObservationPayload): Promise<WorkerResult<Record<string, unknown>>> {
    return this.postJson("/api/sessions/observations", payload);
  }

  summarize(
    payload: SummarizePayload,
    timeoutMs = this.shutdownTimeoutMs,
  ): Promise<WorkerResult<Record<string, unknown>>> {
    return this.postJson("/api/sessions/summarize", payload, timeoutMs);
  }

  private postJson(
    path: string,
    payload: object,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<WorkerResult<Record<string, unknown>>> {
    return this.requestJson(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, timeoutMs);
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<WorkerResult<T>> {
    const response = await this.request(path, init, timeoutMs);
    if (!response.ok) return response;

    try {
      return { ok: true, value: (await response.value.json()) as T };
    } catch {
      return { ok: false, error: `Worker returned malformed JSON for ${path}` };
    }
  }

  private async requestText(
    path: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<WorkerResult<string>> {
    const response = await this.request(path, init, timeoutMs);
    if (!response.ok) return response;

    try {
      return { ok: true, value: await response.value.text() };
    } catch {
      return { ok: false, error: `Worker returned unreadable text for ${path}` };
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<WorkerResult<Response>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, error: `Worker ${init.method ?? "GET"} ${path} returned ${response.status}` };
      }
      return { ok: true, value: response };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : "is unavailable";
      return { ok: false, error: `Worker ${init.method ?? "GET"} ${path} ${reason}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
