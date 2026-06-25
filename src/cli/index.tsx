import { join } from "node:path";

import { Command } from "commander";
import { render } from "ink";

import { validateIntegrity } from "@/cli/bootstrap";
import { registerCommands } from "@/cli/commands";
import { loadConfig } from "@/cli/config";
import { createMcpManagerFromConfig } from "@/cli/mcp/manager-factory";
import { SettingsLoader, SettingsWriter } from "@/cli/settings";
import { createCodingAgent, createCodingSession, globalApprovalManager, globalAskUserQuestionManager } from "@/coding";
import { AnthropicModelProvider } from "@/community/anthropic";
import { OpenAIModelProvider } from "@/community/openai";
import type { ModelProvider } from "@/foundation";
import { Model } from "@/foundation";


import { App } from "./tui";
import { loadAvailableCommands, type SlashCommand } from "./tui/command-registry";
import { AgentLoopProvider } from "./tui/hooks/use-agent-loop";
import { HELIXENT_NAME, HELIXENT_VERSION } from "./version";

const program = new Command();
program
  .name(HELIXENT_NAME)
  .description("Helixent — a blue rabbit that writes code")
  .version(HELIXENT_VERSION, "-v, --version");

registerCommands(program);

const args = process.argv.slice(2);

if (args.length > 0) {
  await program.parseAsync(process.argv);
} else {
  console.info();
  await validateIntegrity();

  const config = loadConfig();
  const defaultModelName = config.defaultModel ?? config.models[0]?.name;
  const entry = defaultModelName ? config.models.find((m) => m.name === defaultModelName) : undefined;
  if (!entry) {
    throw new Error("No models configured. Run `helixent config model add` to add one.");
  }

  let provider: ModelProvider;
  if (entry.provider === "anthropic") {
    provider = new AnthropicModelProvider({
      baseURL: entry.baseURL,
      apiKey: entry.APIKey,
    });
  } else {
    provider = new OpenAIModelProvider({
      baseURL: entry.baseURL,
      apiKey: entry.APIKey,
    });
  }

  const model = new Model(entry.name, provider, {
    max_tokens: 16 * 1024,
    thinking: {
      type: "enabled",
    },
  });

  const skillsDirs = [
    join(process.cwd(), "skills"),
    join(process.cwd(), ".agents/skills"),
    join(Bun.env.HELIXENT_HOME!, "skills"),
    "~/.agents/skills",
    "~/.helixent/skills",
  ];

  const mcpManager = createMcpManagerFromConfig(config.mcpServers);
  if (mcpManager) {
    try {
      await mcpManager.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[helixent] MCP startup failed: ${message}`);
      process.exit(1);
    }
    // Best-effort close on process exit. Ink owns Ctrl+C/SIGINT for the TUI, and
    // stdio child processes are terminated with the parent, so we do not install a
    // SIGINT handler that would short-circuit Ink's own shutdown.
    process.on("exit", () => {
      void mcpManager.close();
    });
  }

  const settingsLoader = new SettingsLoader();
  const settingsWriter = new SettingsWriter(settingsLoader);
  const agent = await createCodingAgent({
    model,
    skillsDirs,
    askUser: globalApprovalManager.askUser,
    askUserQuestion: globalAskUserQuestionManager.askUserQuestion,
    approvalPersistence: {
      loadAllowList: (cwd) => settingsLoader.loadAllowList(cwd),
      persistAllowedTool: (cwd, toolName) => settingsWriter.appendAllowedTool(cwd, toolName),
    },
    requiresApprovalFor: mcpManager ? (toolName) => mcpManager.requiresApproval(toolName) : undefined,
  });
  const session = await createCodingSession({ cwd: process.cwd() });
  const commands: SlashCommand[] = await loadAvailableCommands(skillsDirs);

  render(
    <AgentLoopProvider agent={agent} session={session} commands={commands} toolProvider={mcpManager}>
      <App commands={commands} supportProjectWideAllow />
    </AgentLoopProvider>,
    { patchConsole: false },
  );
}
