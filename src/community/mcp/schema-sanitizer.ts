import type { JsonSchemaObject } from "@/foundation";

const MAX_DEPTH = 32;
const SAFE_FALLBACK: JsonSchemaObject = { type: "object", properties: {} };
const DROPPED_KEYS = new Set(["$schema", "$id"]);

/**
 * Minimal defensive cleanup for an external MCP tool input schema before it is
 * exposed to a model provider. This is not a full JSON Schema validator: it only
 * guarantees a provider-safe object schema and isolates malformed/pathological input.
 *
 * @param input - The raw `inputSchema` reported by an MCP server.
 * @returns A provider-safe JSON Schema object.
 */
export function sanitizeMcpToolSchema(input: unknown): JsonSchemaObject {
  try {
    if (!isPlainObject(input)) {
      return { ...SAFE_FALLBACK };
    }
    const sanitized = sanitizeNode(input, 0);
    if (!isPlainObject(sanitized)) {
      return { ...SAFE_FALLBACK };
    }
    if (sanitized.type !== "object") {
      sanitized.type = "object";
    }
    if (!("properties" in sanitized)) {
      sanitized.properties = {};
    }
    return sanitized;
  } catch {
    return { ...SAFE_FALLBACK };
  }
}

function sanitizeNode(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return {};
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNode(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key)) continue;
      out[key] = sanitizeNode(child, depth + 1);
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
