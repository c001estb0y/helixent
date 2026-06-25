import type { Tool } from "@/foundation";

/**
 * A runtime source of additional model-visible tools assembled per provider request.
 *
 * This keeps the agent layer decoupled from any specific integration (such as MCP):
 * the app runtime passes an implementation (e.g. an MCP manager) into turn execution.
 */
export interface EffectiveToolProvider {
  getEffectiveTools(): Tool[];
}

/**
 * Merges agent-configured tools with runtime-provided tools, preferring agent tools
 * on name conflicts. Returns the base tools unchanged when no provider is given.
 *
 * @param base - The agent-configured tools.
 * @param provider - Optional runtime tool provider.
 * @returns The merged effective tool set, or the base tools when no provider is given.
 */
export function mergeEffectiveTools(
  base: Tool[] | undefined,
  provider?: EffectiveToolProvider,
): Tool[] | undefined {
  if (!provider) {
    return base;
  }
  const tools: Tool[] = [...(base ?? [])];
  const seen = new Set(tools.map((tool) => tool.name));
  for (const tool of provider.getEffectiveTools()) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}
