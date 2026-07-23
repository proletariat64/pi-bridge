import { describe, expect, it } from "bun:test";
import { deriveContentSessionId, resolveBridgeState, restoreBridgeState, STATE_ENTRY_TYPE } from "./state.js";

const session = (file: string | undefined, id = "session-id") => ({
  getSessionFile: () => file,
  getSessionId: () => id,
});

describe("bridge state", () => {
  it("derives stable opaque IDs from the session file or ID", () => {
    expect(deriveContentSessionId(session("/tmp/a.jsonl"))).toBe(deriveContentSessionId(session("/tmp/a.jsonl", "different")));
    expect(deriveContentSessionId(session(undefined, "one"))).not.toBe(deriveContentSessionId(session(undefined, "two")));
    expect(deriveContentSessionId(session("/tmp/a.jsonl"))).toMatch(/^pi-[a-f0-9]{64}$/);
  });

  it("restores the latest valid state on the active branch", () => {
    const oldState = { contentSessionId: `pi-${"1".repeat(64)}`, project: "old", finalized: false, enabled: true };
    const latest = { contentSessionId: `pi-${"2".repeat(64)}`, project: "repo", finalized: true, enabled: false };
    expect(restoreBridgeState([
      { type: "custom", customType: STATE_ENTRY_TYPE, data: oldState },
      { type: "message", message: {} },
      { type: "custom", customType: STATE_ENTRY_TYPE, data: latest },
    ])).toEqual(latest);
  });

  it("restores reload/resume but assigns fresh fork/new state", () => {
    const restored = { contentSessionId: `pi-${"1".repeat(64)}`, project: "repo", finalized: false, enabled: false };
    const branch = [{ type: "custom", customType: STATE_ENTRY_TYPE, data: restored }];
    expect(resolveBridgeState("reload", session("/tmp/current"), branch, "ignored", true)).toEqual(restored);
    expect(resolveBridgeState("resume", session("/tmp/current"), branch, "ignored", true)).toEqual(restored);
    expect(resolveBridgeState("fork", session("/tmp/fork"), branch, "forked", true).contentSessionId).not.toBe(restored.contentSessionId);
    expect(resolveBridgeState("new", session("/tmp/new"), branch, "new", true).project).toBe("new");
  });
});
