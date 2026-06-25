import type { z } from "zod";

/** A JSON Schema object describing a tool's accepted input shape. */
export type JsonSchemaObject = Record<string, unknown>;

/** A tool parameter schema sourced from a raw JSON Schema rather than Zod. */
export interface JsonSchemaToolParameters {
  readonly kind: "json-schema";
  readonly jsonSchema: JsonSchemaObject;
}

/**
 * Provider-neutral tool parameter schema. Built-in tools use Zod, while
 * MCP-discovered tools use JSON Schema. Provider adapters render both as JSON Schema.
 */
export type ToolParameters = z.ZodSchema<Record<string, unknown>> | JsonSchemaToolParameters;

/** Type guard for JSON-Schema-backed tool parameters. */
export function isJsonSchemaToolParameters(parameters: ToolParameters): parameters is JsonSchemaToolParameters {
  return (
    typeof parameters === "object" &&
    parameters !== null &&
    "kind" in parameters &&
    (parameters as JsonSchemaToolParameters).kind === "json-schema"
  );
}

/**
 * Renders any tool parameter schema as a JSON Schema object for provider requests.
 * @param parameters - The provider-neutral tool parameter schema.
 * @returns The JSON Schema object.
 */
export function toolParametersToJsonSchema(parameters: ToolParameters): JsonSchemaObject {
  if (isJsonSchemaToolParameters(parameters)) {
    return parameters.jsonSchema;
  }
  return parameters.toJSONSchema() as JsonSchemaObject;
}
