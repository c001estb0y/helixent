import type { RenderedModelRequest } from "./model-context";
import type { ModelProvider } from "./model-provider";

/**
 * Represents a model that can be used to generate text.
 *
 * @param provider - The provider to use to invoke the model.
 * @param name - The name of the model to use.
 * @param options - The options to pass to the model.
 */
export class Model {
  /**
   * Creates a new model.
   * @param name - The name of the model to use.
   * @param provider - The provider to use to invoke the model.
   * @param options - The options to pass to the model.
   */
  constructor(
    // eslint-disable-next-line no-unused-vars
    readonly name: string,
    // eslint-disable-next-line no-unused-vars
    readonly provider: ModelProvider,
    // eslint-disable-next-line no-unused-vars
    readonly options?: Record<string, unknown>,
  ) {}

  /**
   * Invokes the model with an already rendered provider-neutral request.
   * @param request - The rendered request to send to the provider.
   * @returns The response from the model.
   */
  invokeRendered(request: RenderedModelRequest) {
    return this.provider.invoke(request);
  }

  /**
   * Streams the model response for an already rendered provider-neutral request.
   * @param request - The rendered request to send to the provider.
   * @returns The stream of responses from the model.
   */
  streamRendered(request: RenderedModelRequest) {
    return this.provider.stream(request);
  }
}
