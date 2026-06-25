import { z } from "zod";

export const modelEntrySchema = z.object({
  name: z.string().min(1),
  baseURL: z.string().min(1),
  APIKey: z.string().min(1),
  /** Provider type: "openai" (default) or "anthropic". */
  provider: z.enum(["openai", "anthropic"]).optional().default("openai"),
});

const mcpServerPolicy = {
  /** Whether the server is connected at startup. Defaults to true. */
  enabled: z.boolean().optional(),
  /** Whether a connection failure prevents agent execution from starting. Defaults to false. */
  required: z.boolean().optional(),
  /** Auto-approval: `true` for all tools, or a list of original MCP tool names. Defaults to require approval. */
  autoApprove: z.union([z.boolean(), z.array(z.string())]).optional(),
  /** Whether tool calls against this server may run in parallel. Defaults to false (serial). */
  allowParallel: z.boolean().optional(),
};

export const stdioMcpServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  /** When true, inherit the full host environment instead of the minimal safe set. */
  inheritEnv: z.boolean().optional(),
  ...mcpServerPolicy,
});

export const httpMcpServerSchema = z.object({
  type: z.enum(["streamable_http", "sse"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  /** Map of header name to environment variable name, resolved at connect time. */
  envHeaders: z.record(z.string(), z.string()).optional(),
  ...mcpServerPolicy,
});

export const mcpServerSchema = z.union([httpMcpServerSchema, stdioMcpServerSchema]);

export const mcpServersSchema = z.record(z.string(), mcpServerSchema);

export const helixentConfigSchema = z.object({
  models: z.array(modelEntrySchema).min(1),
  defaultModel: z.string().min(1).optional(),
  mcpServers: mcpServersSchema.optional(),
}).superRefine((val, ctx) => {
  if (val.defaultModel && !val.models.some((m) => m.name === val.defaultModel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `defaultModel "${val.defaultModel}" does not match any configured model name`,
      path: ["defaultModel"],
    });
  }
});

export type HelixentConfig = z.infer<typeof helixentConfigSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type McpServerEntry = z.infer<typeof mcpServerSchema>;
export type McpServersEntry = z.infer<typeof mcpServersSchema>;
