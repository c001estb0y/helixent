import { Box, Static } from "ink";
import { useLayoutEffect, useMemo, useState } from "react";

import type { SlashCommand } from "./command-registry";
import { ApprovalPrompt } from "./components/approval-prompt";
import { AskUserQuestionPrompt } from "./components/ask-user-question-prompt";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { InputBox } from "./components/input-box";
import { MessageHistory, MessageHistoryItem } from "./components/message-history";
import { StreamingIndicator } from "./components/streaming-indicator";
import { TodoPanel } from "./components/todo-panel";
import { useAgentLoop } from "./hooks/use-agent-loop";
import { useApprovalManager } from "./hooks/use-approval-manager";
import { useAskUserQuestionManager } from "./hooks/use-ask-user-question-manager";
import { nextStaticMessageCount } from "./message-display";
import { buildTodoViewState, getNextTodo } from "./todo-view";

function allDone(todos?: { status: string }[]) {
  return !!todos?.length && todos.every((t) => t.status === "completed" || t.status === "cancelled");
}

export function App({
  commands,
  supportProjectWideAllow = false,
}: {
  commands: SlashCommand[];
  supportProjectWideAllow?: boolean;
}) {
  const { streaming, messages, onSubmit, abort } = useAgentLoop();
  const { approvalRequest, respondToApproval } = useApprovalManager();
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();
  const { latestTodos, todoSnapshots } = useMemo(() => buildTodoViewState(messages), [messages]);
  const nextTodo = getNextTodo(latestTodos)?.content;
  const hideTodos = !streaming && allDone(latestTodos);
  const [staticMessageCount, setStaticMessageCount] = useState(0);

  useLayoutEffect(() => {
    const nextCount = nextStaticMessageCount({
      messagesLength: messages.length,
      previousStaticMessageCount: staticMessageCount,
      streaming,
    });
    if (nextCount !== staticMessageCount) {
      setStaticMessageCount(nextCount);
    }
  }, [messages.length, staticMessageCount, streaming]);

  const boundedStaticMessageCount = Math.min(staticMessageCount, messages.length);
  const staticMessages = messages.slice(0, boundedStaticMessageCount);
  const liveMessages = messages.slice(boundedStaticMessageCount);

  return (
    <Box flexDirection="column" width="100%">
      {messages.length === 0 && <Header />}
      <Static items={staticMessages}>
        {(message, index) => (
          <MessageHistoryItem
            key={`static:${index}`}
            message={message}
            messageIndex={index}
            todoSnapshots={todoSnapshots}
          />
        )}
      </Static>
      <Box flexDirection="column" marginTop={1} rowGap={1}>
        {liveMessages.length > 0 && (
          <MessageHistory
            messages={liveMessages}
            startIndex={boundedStaticMessageCount}
            todoSnapshots={todoSnapshots}
          />
        )}
        {approvalRequest || askUserQuestionRequest ? null : (
          <StreamingIndicator streaming={streaming} nextTodo={nextTodo} />
        )}
        {!hideTodos && <TodoPanel todos={latestTodos} />}
        {approvalRequest ? (
          <ApprovalPrompt
            toolUse={approvalRequest.toolUse}
            supportProjectWideAllow={supportProjectWideAllow}
            onDecision={respondToApproval}
          />
        ) : askUserQuestionRequest ? (
          <AskUserQuestionPrompt
            questions={askUserQuestionRequest.params.questions}
            onSubmit={respondWithAnswers}
          />
        ) : (
          <InputBox commands={commands} onSubmit={onSubmit} onAbort={abort} />
        )}
      </Box>
      <Footer />
    </Box>
  );
}
