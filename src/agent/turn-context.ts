import type { TurnContext } from "@/foundation";

export type { TurnContext };

export interface CaptureTurnContextParams {
  cwd: string;
  model: string;
}

/** Captures volatile execution context immediately before model work starts. */
export function captureTurnContext({ cwd, model }: CaptureTurnContextParams): TurnContext {
  return {
    currentDate: currentDate(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd,
    model,
  };
}

function currentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
