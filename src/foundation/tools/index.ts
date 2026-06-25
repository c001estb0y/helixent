import type { FunctionTool, JsonSchemaTool } from "./function-tool";

export * from "./function-tool";
export * from "./structured-tool-result";
export * from "./tool-parameters";

export type Tool = FunctionTool | JsonSchemaTool;
