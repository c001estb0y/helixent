import type { AssistantMessage, NonSystemMessage } from "@/foundation";

export interface TokenUsageSummary {
  latestInputTokens: number;
  sessionTotalTokens: number;
}

export function calculateTokenUsage(messages: NonSystemMessage[]): TokenUsageSummary {
  return messages.reduce<TokenUsageSummary>(
    (summary, message) => {
      if (!isAssistantMessage(message) || !message.usage) {
        return summary;
      }

      return {
        latestInputTokens: message.usage.promptTokens,
        sessionTotalTokens: summary.sessionTotalTokens + message.usage.totalTokens,
      };
    },
    { latestInputTokens: 0, sessionTotalTokens: 0 },
  );
}

function isAssistantMessage(message: NonSystemMessage): message is AssistantMessage {
  return message.role === "assistant";
}
