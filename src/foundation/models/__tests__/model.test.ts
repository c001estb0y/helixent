import { describe, expect, test } from "bun:test";

import type { AssistantMessage } from "../../messages";
import { Model } from "../model";
import type { ModelProvider, ModelProviderInvokeParams } from "../model-provider";

describe("Model", () => {
  test("streams an already rendered request without assembling prompt context itself", async () => {
    const provider = new CapturingProvider({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
    });
    const model = new Model("fake-model", provider);
    const request = {
      model: "fake-model",
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "Already rendered." }] },
      ],
    };

    const snapshots = [];
    for await (const snapshot of model.streamRendered(request)) {
      snapshots.push(snapshot);
    }

    expect(snapshots).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ]);
    expect(provider.calls).toEqual([request]);
  });
});

class CapturingProvider implements ModelProvider {
  readonly calls: ModelProviderInvokeParams[] = [];
  private readonly _message: AssistantMessage;

  constructor(message: AssistantMessage) {
    this._message = message;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.calls.push(params);
    return this._message;
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.calls.push(params);
    yield this._message;
  }
}
