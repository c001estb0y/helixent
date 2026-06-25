import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineJsonSchemaTool, defineTool, toolParametersToJsonSchema } from "../index";

describe("toolParametersToJsonSchema", () => {
  test("renders a Zod-backed tool's parameters as JSON Schema", () => {
    const tool = defineTool({
      name: "echo",
      description: "Echo a message",
      parameters: z.object({ message: z.string() }),
      invoke: async ({ message }) => message,
    });

    const jsonSchema = toolParametersToJsonSchema(tool.parameters);

    expect(jsonSchema).toMatchObject({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    });
  });

  test("returns the embedded JSON Schema for a JSON-schema-backed tool", () => {
    const tool = defineJsonSchemaTool({
      name: "remote",
      description: "A remote tool",
      jsonSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      invoke: async (input) => input,
    });

    expect(toolParametersToJsonSchema(tool.parameters)).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });
});

describe("defineTool / defineJsonSchemaTool invocation", () => {
  test("a Zod-backed tool still invokes with parsed input", async () => {
    const tool = defineTool({
      name: "sum",
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      invoke: async ({ a, b }) => a + b,
    });

    await expect(tool.invoke({ a: 2, b: 3 })).resolves.toBe(5);
  });

  test("a JSON-schema-backed tool invokes with the raw record input", async () => {
    const tool = defineJsonSchemaTool({
      name: "passthrough",
      description: "Return input",
      jsonSchema: { type: "object" },
      invoke: async (input) => input,
    });

    await expect(tool.invoke({ x: 1 })).resolves.toEqual({ x: 1 });
  });
});
