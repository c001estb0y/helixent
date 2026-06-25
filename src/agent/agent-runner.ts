import type { Agent } from "./agent";
import type { EffectiveToolProvider } from "./effective-tools";
import type { Session, TurnId } from "./session";
import { TurnRun } from "./turn-run";

export interface StartTurnParams {
  session: Session;
  agent: Agent;
  turnId: TurnId;
  /** Optional runtime tool provider (e.g. an MCP manager) merged into each request. */
  toolProvider?: EffectiveToolProvider;
}

/** Stateless orchestrator for running an agent against a session turn. */
export class AgentRunner {
  startTurn({ session, agent, turnId, toolProvider }: StartTurnParams): TurnRun {
    const turn = session.getTurn(turnId);
    if (!turn) {
      throw new Error(`Turn ${turnId} not found`);
    }
    if (turn.agentId !== agent.id) {
      throw new Error(`Turn ${turnId} belongs to agent ${turn.agentId}, not ${agent.id}`);
    }
    if (turn.status !== "created" && turn.status !== "interrupted") {
      throw new Error(`Cannot start turn ${turnId} from status ${turn.status}`);
    }
    return new TurnRun({ session, agent, turnId, toolProvider });
  }
}
