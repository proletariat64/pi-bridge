const SECRET_KEYS = new Set(["apikey", "token", "password", "authorization", "cookie"]);
const TOOL_RESPONSE_LIMIT = 1_000;
const TOOL_INPUT_LIMIT_BYTES = 16 * 1024;
const TRUNCATION_MARKER = "…[truncated]";
const BINARY_MARKER = "[binary omitted]";

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function isBinary(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    || (typeof Blob !== "undefined" && value instanceof Blob);
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isBinary(value)) return BINARY_MARKER;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? "[redacted]" : redactSecrets(child, seen);
  }
  return output;
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(redactSecrets(value));
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[unserializable]";
  }
}

function truncateUtf8(value: string, maxBytes: number, marker = TRUNCATION_MARKER): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.subarray(0, Math.max(0, maxBytes - markerBytes)).toString("utf8").replace(/\uFFFD$/u, "")}${marker}`;
}

function truncateCharacters(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : value.slice(0, maxCharacters);
}

export function serializeToolInput(value: unknown): unknown {
  const redacted = redactSecrets(value);
  const serialized = safeStringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") <= TOOL_INPUT_LIMIT_BYTES) return redacted;
  return truncateUtf8(serialized, TOOL_INPUT_LIMIT_BYTES);
}

export function extractText(result: unknown): string {
  if (typeof result === "string") return truncateCharacters(result, TOOL_RESPONSE_LIMIT);
  if (result === null || typeof result !== "object") {
    return truncateCharacters(String(result ?? ""), TOOL_RESPONSE_LIMIT);
  }

  const record = result as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      } else {
        parts.push(safeStringify(block));
      }
    }
  }
  if (parts.length === 0 && "details" in record && record.details !== undefined) {
    parts.push(safeStringify(record.details));
  }
  return truncateCharacters(parts.join("\n"), TOOL_RESPONSE_LIMIT);
}

export function extractLastAssistantText(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block): block is { type: "text"; text: string } => Boolean(
        block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string",
      ))
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}
