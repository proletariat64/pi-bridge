import { createHash } from "node:crypto";

export const STATE_ENTRY_TYPE = "claude-mem-bridge-state";

export interface BridgeState {
  contentSessionId: string;
  project: string;
  finalized: boolean;
  enabled: boolean;
}

interface CustomEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface SessionIdentity {
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

function isBridgeState(value: unknown): value is BridgeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BridgeState>;
  return typeof candidate.contentSessionId === "string"
    && candidate.contentSessionId.startsWith("pi-")
    && typeof candidate.project === "string"
    && typeof candidate.finalized === "boolean"
    && (candidate.enabled === undefined || typeof candidate.enabled === "boolean");
}

export function deriveContentSessionId(session: SessionIdentity): string {
  const identity = session.getSessionFile() ?? session.getSessionId();
  return `pi-${createHash("sha256").update(identity).digest("hex")}`;
}

export function restoreBridgeState(entries: readonly unknown[]): BridgeState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as CustomEntryLike | undefined;
    if (entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE && isBridgeState(entry.data)) {
      return { enabled: true, ...entry.data };
    }
  }
  return undefined;
}

export function resolveBridgeState(
  reason: "startup" | "reload" | "new" | "resume" | "fork",
  session: SessionIdentity,
  branch: readonly unknown[],
  project: string,
  enabled: boolean,
): BridgeState {
  if (reason !== "new" && reason !== "fork") {
    const restored = restoreBridgeState(branch);
    if (restored) return restored;
  }

  return {
    contentSessionId: deriveContentSessionId(session),
    project,
    finalized: false,
    enabled,
  };
}
