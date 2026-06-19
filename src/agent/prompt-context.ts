import { createHash } from "node:crypto";

/** Typed prompt-visible instruction context outside the transcript. */
export interface PromptContextItem {
  id: string;
  kind: "global_user_instructions" | "project_instructions" | "local_project_instructions";
  sourcePath: string;
  scope: "user" | "project" | "local_project";
  precedence: number;
  content: string;
  contentHash: string;
  contentLength: number;
  cacheStable: true;
  overrideOf?: string;
}

/** Current effective instruction context for the next model run. */
export interface EffectivePromptContext {
  sourceSetHash: string;
  items: PromptContextItem[];
}

export interface PromptContextItemInput {
  id: string;
  kind: PromptContextItem["kind"];
  sourcePath: string;
  scope: PromptContextItem["scope"];
  precedence: number;
  content: string;
  overrideOf?: string;
}

/** Defines an item and fills source-aware hash metadata. */
export function definePromptContextItem(input: PromptContextItemInput): PromptContextItem {
  return {
    ...input,
    cacheStable: true,
    contentHash: hashString(input.content),
    contentLength: input.content.length,
  };
}

/** Defines an effective context and fills the aggregate ordered source-set hash. */
export function defineEffectivePromptContext(items: PromptContextItem[]): EffectivePromptContext {
  const clonedItems = items.map(clonePromptContextItem);
  return {
    sourceSetHash: hashJson(clonedItems.map(sourceSetHashInput)),
    items: clonedItems,
  };
}

export function cloneEffectivePromptContext(promptContext: EffectivePromptContext): EffectivePromptContext {
  return {
    sourceSetHash: promptContext.sourceSetHash,
    items: promptContext.items.map(clonePromptContextItem),
  };
}

function clonePromptContextItem(item: PromptContextItem): PromptContextItem {
  return { ...item };
}

function sourceSetHashInput(item: PromptContextItem) {
  return {
    id: item.id,
    kind: item.kind,
    sourcePath: item.sourcePath,
    scope: item.scope,
    precedence: item.precedence,
    contentHash: item.contentHash,
    contentLength: item.contentLength,
    cacheStable: item.cacheStable,
    overrideOf: item.overrideOf,
  };
}

function hashJson(value: unknown) {
  return hashString(JSON.stringify(value));
}

function hashString(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
