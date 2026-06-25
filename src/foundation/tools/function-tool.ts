import type { z } from "zod";

import type { JsonSchemaObject, JsonSchemaToolParameters } from "./tool-parameters";

/**
 * A function tool that can be used to invoke a function.
 * @param P - The parameters of the tool.
 * @param R - The result of the tool.
 */
export interface FunctionTool<
  P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
  R = unknown,
> {
  /** The name of the tool. */
  name: string;
  /** The description of the tool. */
  description: string;
  /** The parameters of the tool. */
  parameters: P;
  /** The function to invoke when the tool is called. */
  // eslint-disable-next-line no-unused-vars
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}

/**
 * Defines a function tool.
 * @param name - The name of the tool.
 * @param description - The description of the tool.
 * @param parameters - The parameters of the tool.
 * @param invoke - The function to invoke when the tool is called.
 * @returns The function tool.
 */
export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>({
  name,
  description,
  parameters,
  invoke,
}: {
  name: string;
  description: string;
  parameters: P;
  // eslint-disable-next-line no-unused-vars
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}): FunctionTool<P, R> {
  return { name, description, parameters, invoke } as FunctionTool<P, R>;
}

/**
 * A tool whose parameters are described by a raw JSON Schema rather than Zod.
 * Used for MCP-discovered tools whose schemas are owned by the external server.
 * @param R - The result of the tool.
 */
export interface JsonSchemaTool<R = unknown> {
  /** The name of the tool. */
  name: string;
  /** The description of the tool. */
  description: string;
  /** The JSON-Schema-backed parameters of the tool. */
  parameters: JsonSchemaToolParameters;
  /** The function to invoke when the tool is called. */
  // eslint-disable-next-line no-unused-vars
  invoke: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<R>;
}

/**
 * Defines a JSON-Schema-backed function tool.
 * @param name - The name of the tool.
 * @param description - The description of the tool.
 * @param jsonSchema - The JSON Schema describing the tool's input.
 * @param invoke - The function to invoke when the tool is called.
 * @returns The JSON-Schema-backed tool.
 */
export function defineJsonSchemaTool<R = unknown>({
  name,
  description,
  jsonSchema,
  invoke,
}: {
  name: string;
  description: string;
  jsonSchema: JsonSchemaObject;
  // eslint-disable-next-line no-unused-vars
  invoke: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<R>;
}): JsonSchemaTool<R> {
  return { name, description, parameters: { kind: "json-schema", jsonSchema }, invoke };
}
