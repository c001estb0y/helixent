import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import {
  defineEffectivePromptContext,
  definePromptContextItem,
  type EffectivePromptContext,
  type PromptContextItem,
} from "@/agent";

export async function loadCodingPromptContext({
  cwd,
  helixentHome = defaultHelixentHome(),
}: {
  cwd: string;
  helixentHome?: string;
}): Promise<EffectivePromptContext> {
  const dirs = await instructionDirs({ cwd });
  const items: PromptContextItem[] = [];
  const globalAgentsPath = join(helixentHome, "AGENTS.md");
  const globalAgentsFile = Bun.file(globalAgentsPath);

  if (await globalAgentsFile.exists()) {
    items.push(definePromptContextItem({
      id: `agents-global:${globalAgentsPath}`,
      kind: "global_user_instructions",
      sourcePath: globalAgentsPath,
      scope: "user",
      precedence: items.length,
      content: await globalAgentsFile.text(),
    }));
  }

  for (const dir of dirs) {
    const agentsPath = join(dir, "AGENTS.md");
    const overridePath = join(dir, "AGENTS.override.md");
    const overrideFile = Bun.file(overridePath);
    const agentsFile = Bun.file(agentsPath);

    if (await overrideFile.exists()) {
      items.push(definePromptContextItem({
        id: `agents-override:${overridePath}`,
        kind: "local_project_instructions",
        sourcePath: overridePath,
        scope: "local_project",
        precedence: items.length,
        content: await overrideFile.text(),
        overrideOf: agentsPath,
      }));
      continue;
    }

    if (await agentsFile.exists()) {
      items.push(definePromptContextItem({
        id: `agents:${agentsPath}`,
        kind: "project_instructions",
        sourcePath: agentsPath,
        scope: "project",
        precedence: items.length,
        content: await agentsFile.text(),
      }));
    }
  }

  return defineEffectivePromptContext(items);
}

function defaultHelixentHome() {
  return Bun.env.HELIXENT_HOME?.trim() || join(homedir(), ".helixent");
}

async function instructionDirs({ cwd }: { cwd: string }) {
  const root = await findProjectRoot(cwd);
  const absoluteCwd = resolve(cwd);
  const dirs: string[] = [];
  let current = absoluteCwd;

  while (true) {
    dirs.unshift(current);
    if (current === root) {
      return dirs;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

async function findProjectRoot(cwd: string) {
  const filesystemRoot = parse(resolve(cwd)).root;
  let current = resolve(cwd);

  while (true) {
    if (await pathExists(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current || current === filesystemRoot) {
      return resolve(cwd);
    }
    current = parent;
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
