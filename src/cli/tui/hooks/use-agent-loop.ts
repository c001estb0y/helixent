import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AgentRunner, Session, type Agent, type EffectiveToolProvider, type TurnRun } from "@/agent";
import type { AssistantMessage, NonSystemMessage, UserMessage } from "@/foundation";

import type { PromptSubmission, SlashCommand } from "../command-registry";
import { formatHelp, resolveBuiltinCommand } from "../command-registry";
import { calculateTokenUsage, type TokenUsageSummary } from "../token-usage";

type AgentLoopState = {
  agent: Agent;
  streaming: boolean;
  messages: NonSystemMessage[];
  // eslint-disable-next-line no-unused-vars
  onSubmit: (submission: PromptSubmission) => Promise<void>;
  abort: () => void;
  tokenUsage: TokenUsageSummary;
};

const AgentLoopContext = createContext<AgentLoopState | null>(null);

export function AgentLoopProvider({
  agent,
  session,
  commands = [],
  toolProvider,
  children,
}: {
  agent: Agent;
  session: Session;
  commands?: SlashCommand[];
  toolProvider?: EffectiveToolProvider;
  children: ReactNode;
}) {
  const [streaming, setStreaming] = useState(false);
  const [messages, setMessages] = useState<NonSystemMessage[]>(session.messages);
  const sessionRef = useRef(session);
  const streamingRef = useRef(streaming);
  const currentRunRef = useRef<TurnRun | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const queuedSubmissionRef = useRef<PromptSubmission | null>(null);
  const onSubmitRef = useRef<AgentLoopState["onSubmit"] | null>(null);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const abort = useCallback(() => {
    currentRunRef.current?.interrupt();
  }, []);

  const tokenUsage = useMemo(() => {
    return calculateTokenUsage(messages);
  }, [messages]);

  const runTurn = useCallback(
    async (turnId: string) => {
      const runSession = sessionRef.current;
      const run = new AgentRunner().startTurn({ session: runSession, agent, turnId, toolProvider });
      currentRunRef.current = run;

      let runError: unknown;
      const done = run.done.catch((error: unknown) => {
        runError = error;
      });

      for await (const event of run.events) {
        if (event.type === "message" || event.type === "turn_interrupted" || event.type === "turn_completed") {
          setMessages(runSession.messages);
        }
      }

      await done;
      currentRunRef.current = null;
      if (runError) {
        throw runError;
      }
    },
    [agent, toolProvider],
  );

  const onSubmit = useCallback(
    async (submission: PromptSubmission) => {
      const { text, requestedSkillName } = submission;
      const invocation = resolveBuiltinCommand(text);

      if (invocation?.name === "exit" || invocation?.name === "quit") {
        process.exit(0);
        return;
      }

      if (streamingRef.current) {
        queuedSubmissionRef.current = submission;
        return;
      }

      if (invocation?.name === "clear") {
        const nextSession = new Session({ promptContext: sessionRef.current.promptContext });
        sessionRef.current = nextSession;
        activeTurnIdRef.current = null;
        queuedSubmissionRef.current = null;
        setMessages([]);
        clearTerminal();
        return;
      }

      if (invocation?.name === "help") {
        const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
        const helpMessage: AssistantMessage = {
          role: "assistant",
          content: [
            {
              type: "text",
              text: formatHelp(commands, invocation.args || undefined),
            },
          ],
        };
        setMessages((prev) => [...prev, userMessage, helpMessage]);
        return;
      }

      const runSession = sessionRef.current;
      const activeTurnId = activeTurnIdRef.current;
      const activeTurn = activeTurnId ? runSession.getTurn(activeTurnId) : undefined;
      const turn =
        activeTurn?.status === "interrupted"
          ? runSession.continueTurn(activeTurn.id, text)
          : runSession.createTurn({
              agentId: agent.id,
              input: text,
              options: { requestedSkillName },
            });

      activeTurnIdRef.current = turn.id;
      setMessages(runSession.messages);
      streamingRef.current = true;
      setStreaming(true);

      try {
        await runTurn(turn.id);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setMessages([
          ...runSession.messages,
          {
            role: "assistant",
            content: [{ type: "text", text: `Error: ${errorMessage}\n\nYou can try again.` }],
          },
        ]);
      } finally {
        const finalTurn = runSession.getTurn(turn.id);
        setMessages(runSession.messages);
        streamingRef.current = false;
        setStreaming(false);
        if (finalTurn?.status !== "interrupted") {
          activeTurnIdRef.current = null;
          const queuedSubmission = queuedSubmissionRef.current;
          queuedSubmissionRef.current = null;
          if (queuedSubmission) {
            queueMicrotask(() => {
              void onSubmitRef.current?.(queuedSubmission);
            });
          }
        }
      }
    },
    [agent.id, commands, runTurn],
  );

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  const value = useMemo(
    () => ({
      agent,
      streaming,
      messages,
      onSubmit,
      abort,
      tokenUsage,
    }),
    [abort, agent, messages, onSubmit, streaming, tokenUsage],
  );

  return createElement(AgentLoopContext.Provider, { value }, children);
}

function useAgentLoopState(): AgentLoopState {
  const state = useContext(AgentLoopContext);
  if (!state) {
    throw new Error("useAgentLoop() must be used within <AgentLoopProvider agent={...} session={...}>");
  }
  return state;
}

export function useAgentLoop() {
  return useAgentLoopState();
}

function clearTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
}
