import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

export type ShellExecutable =
  | { ok: true; path: string }
  | { ok: false; error: string };

const GIT_BASH_DEFAULT_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
] as const;

/** Resolve Git Bash `bash.exe` on Windows (does not exit the process). */
export function findGitBashPath(): string | null {
  const fromEnv = process.env.HELIXENT_GIT_BASH_PATH ?? process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    return normalize(fromEnv);
  }

  const git = Bun.which("git");
  if (git) {
    const bashPath = normalize(join(git, "..", "..", "bin", "bash.exe"));
    if (existsSync(bashPath)) {
      return bashPath;
    }
  }

  for (const candidate of GIT_BASH_DEFAULT_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Resolve a shell executable for `bash` tool invocations. */
export function resolveShellExecutable(): ShellExecutable {
  if (process.platform === "win32") {
    const bashPath = findGitBashPath();
    if (!bashPath) {
      return {
        ok: false,
        error:
          "Git Bash not found. Install Git for Windows (https://git-scm.com/download/win) or set HELIXENT_GIT_BASH_PATH to your bash.exe (e.g. C:\\Program Files\\Git\\bin\\bash.exe).",
      };
    }
    return { ok: true, path: bashPath };
  }

  const bash = Bun.which("bash");
  if (bash && existsSync(bash)) {
    return { ok: true, path: bash };
  }

  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    if (existsSync(candidate)) {
      return { ok: true, path: candidate };
    }
  }

  const zsh = Bun.which("zsh");
  if (zsh && existsSync(zsh)) {
    return { ok: true, path: zsh };
  }

  for (const candidate of ["/bin/zsh", "/usr/bin/zsh"]) {
    if (existsSync(candidate)) {
      return { ok: true, path: candidate };
    }
  }

  return {
    ok: false,
    error: "No bash or zsh found on PATH. Install bash to use the bash tool.",
  };
}

export function isShellAvailable(): boolean {
  return resolveShellExecutable().ok;
}

/** argv for `Bun.spawn`: run `command` as a login-capable shell one-liner. */
export function shellSpawnCmd(executable: string, command: string): string[] {
  return [executable, "-lc", command];
}
