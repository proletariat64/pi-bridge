import { describe, expect, it } from "bun:test";
import { WorkerClient } from "./client.js";

describe("WorkerClient", () => {
  it("uses the Pi worker contract and optional authorization", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (String(input).includes("context/inject")) return new Response("prior context");
      return Response.json({ ok: true });
    };
    const client = new WorkerClient({ baseUrl: "http://worker/", apiKey: "secret", fetchImpl: fetchImpl as typeof fetch });

    await client.init({ contentSessionId: "pi-1", project: "repo", prompt: "hello", platformSource: "pi" });
    await client.context("repo with space");

    expect(requests[0].url).toBe("http://worker/api/sessions/init");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      contentSessionId: "pi-1", project: "repo", prompt: "hello", platformSource: "pi",
    });
    expect(new Headers(requests[0].init.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(requests[1].init.headers).get("Content-Type")).toBe("application/json");
    expect(requests[1].url).toBe("http://worker/api/context/inject?projects=repo+with+space&platformSource=pi");
  });

  it("returns failures instead of throwing on refusal, timeout, and malformed JSON", async () => {
    const refused = new WorkerClient({ fetchImpl: (() => Promise.reject(new Error("refused"))) as typeof fetch });
    expect((await refused.health()).ok).toBe(false);

    const timedOut = new WorkerClient({
      requestTimeoutMs: 5,
      fetchImpl: ((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch,
    });
    expect(await timedOut.health()).toEqual({ ok: false, error: "Worker GET /api/health timed out after 5ms" });

    const malformed = new WorkerClient({ fetchImpl: (async () => new Response("nope")) as typeof fetch });
    expect((await malformed.health()).ok).toBe(false);
  });

  it("never targets a completion endpoint", async () => {
    const urls: string[] = [];
    const client = new WorkerClient({ fetchImpl: (async (input) => {
      urls.push(String(input));
      return Response.json({ status: "queued" });
    }) as typeof fetch });
    await client.summarize({ contentSessionId: "pi-1", last_assistant_message: "done", platformSource: "pi" });
    expect(urls).toEqual(["http://127.0.0.1:37700/api/sessions/summarize"]);
    expect(urls.some((url) => url.includes("/complete"))).toBe(false);
  });
});
