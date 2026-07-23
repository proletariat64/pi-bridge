import { describe, expect, it } from "bun:test";
import { extractLastAssistantText, extractText, redactSecrets, serializeToolInput } from "./serialize.js";

describe("observation serialization", () => {
  it("redacts nested secrets and omits binary values", () => {
    expect(redactSecrets({ apiKey: "a", nested: { authorization: "b", ok: 1 }, bytes: Buffer.from("secret") })).toEqual({
      apiKey: "[redacted]", nested: { authorization: "[redacted]", ok: 1 }, bytes: "[binary omitted]",
    });
  });

  it("caps output at 1000 characters and input at 16 KiB with a marker", () => {
    const output = extractText({ content: [{ type: "text", text: "x".repeat(2_000) }] });
    expect(output).toHaveLength(1_000);
    expect(extractText("界".repeat(1_000))).toHaveLength(1_000);
    const input = serializeToolInput({ value: "x".repeat(20_000) });
    expect(typeof input).toBe("string");
    expect(Buffer.byteLength(input as string)).toBeLessThanOrEqual(16 * 1024);
    expect(input as string).toEndWith("…[truncated]");
  });

  it("extracts the final assistant text", () => {
    expect(extractLastAssistantText([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
      { type: "message", message: { role: "user", content: "next" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "final" }] } },
    ])).toBe("final");
  });
});
