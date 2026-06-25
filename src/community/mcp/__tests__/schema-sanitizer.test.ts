import { describe, expect, test } from "bun:test";

import { sanitizeMcpToolSchema } from "../schema-sanitizer";

describe("sanitizeMcpToolSchema", () => {
  test("preserves a normal object schema and drops the $schema marker", () => {
    const result = sanitizeMcpToolSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { query: { type: "string", description: "the query" } },
      required: ["query"],
    });

    expect(result).toEqual({
      type: "object",
      properties: { query: { type: "string", description: "the query" } },
      required: ["query"],
    });
  });

  test("falls back to an empty object schema for non-object input", () => {
    expect(sanitizeMcpToolSchema(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeMcpToolSchema("nope" as unknown)).toEqual({ type: "object", properties: {} });
  });

  test("forces an object type at the top level when missing", () => {
    const result = sanitizeMcpToolSchema({ properties: { a: { type: "number" } } });
    expect(result).toMatchObject({ type: "object", properties: { a: { type: "number" } } });
  });

  test("isolates pathologically deep schemas without throwing", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 1000; i++) {
      deep = { type: "object", properties: { nested: deep } };
    }
    expect(() => sanitizeMcpToolSchema(deep)).not.toThrow();
  });
});
