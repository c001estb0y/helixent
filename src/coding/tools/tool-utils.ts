import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

const NULL_BYTE = "\0";

let workspaceBaseDir = process.cwd();

/** Set the agent workspace root used for relative path resolution in file tools. */
export function setWorkspaceBaseDir(cwd: string): void {
  workspaceBaseDir = cwd;
}

/** Default base for resolving relative paths (agent workspace). */
export function getPathBaseDir(): string {
  return workspaceBaseDir;
}

/** Convert Git-Bash/MSYS style `/c/foo` to `C:\foo` on Windows. */
export function posixPathToWindowsPath(posixPath: string): string {
  if (posixPath.startsWith("//")) {
    return posixPath.replace(/\//g, "\\");
  }

  const cygdrive = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
  if (cygdrive) {
    const drive = cygdrive[1]!.toUpperCase();
    const rest = posixPath.slice(`/cygdrive/${cygdrive[1]}`.length);
    return `${drive}:${(rest || "\\").replace(/\//g, "\\")}`;
  }

  const drive = posixPath.match(/^\/([A-Za-z])(\/|$)/);
  if (drive) {
    const letter = drive[1]!.toUpperCase();
    const rest = posixPath.slice(2);
    return `${letter}:${(rest || "\\").replace(/\//g, "\\")}`;
  }

  return posixPath.replace(/\//g, "\\");
}

/**
 * Expand a path to an absolute path in the native OS format.
 *
 * Supports `~`, relative paths (against `baseDir`), Windows `E:\` / `E:/`,
 * and POSIX-on-Windows `/e/...` (Git Bash style).
 */
export function expandPath(path: string, baseDir: string = getPathBaseDir()): string {
  if (typeof path !== "string") {
    throw new TypeError(`Path must be a string, received ${typeof path}`);
  }
  if (path.includes(NULL_BYTE) || baseDir.includes(NULL_BYTE)) {
    throw new Error("Path contains null bytes");
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return normalize(baseDir);
  }

  if (trimmed === "~") {
    return normalize(homedir());
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return normalize(resolve(homedir(), trimmed.slice(2)));
  }

  let processed = trimmed;
  if (process.platform === "win32" && /^\/[a-zA-Z](\/|$)/.test(trimmed)) {
    processed = posixPathToWindowsPath(trimmed);
  }

  if (isAbsolute(processed)) {
    return normalize(processed);
  }

  return normalize(resolve(baseDir, processed));
}

export function resolveAbsolutePath(path: string, baseDir?: string) {
  try {
    const expanded = expandPath(path, baseDir);
    if (!isAbsolute(expanded)) {
      return {
        ok: false as const,
        error: `Path must be absolute after resolution: ${path}`,
      };
    }
    return { ok: true as const, path: expanded };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false as const, error: message };
  }
}

/** @deprecated Prefer resolveAbsolutePath; kept for existing tool imports. */
export function ensureAbsolutePath(path: string, baseDir?: string) {
  return resolveAbsolutePath(path, baseDir);
}

export async function ensureDirectoryPath(path: string, baseDir?: string) {
  const absolute = resolveAbsolutePath(path, baseDir);
  if (!absolute.ok) {
    return absolute;
  }

  try {
    const dirStat = await stat(absolute.path);
    if (!dirStat.isDirectory()) {
      return { ok: false as const, error: `Path exists but is not a directory: ${absolute.path}` };
    }
    return { ok: true as const, path: absolute.path };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: false as const, error: `Directory does not exist: ${absolute.path}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false as const, error: `Directory is inaccessible: ${absolute.path} (${message})` };
  }
}

export function isWithinDirectory(root: string, target: string) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`));
}

export function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}
