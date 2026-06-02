import { describe, expect, test } from "bun:test";

import { findGitBashPath, isShellAvailable, resolveShellExecutable, shellSpawnCmd } from "../shell";

describe("shell", () => {
  test("shellSpawnCmd uses login shell -lc", () => {
    expect(shellSpawnCmd("/bin/bash", "echo hi")).toEqual(["/bin/bash", "-lc", "echo hi"]);
  });

  test.skipIf(process.platform !== "win32")("findGitBashPath returns a path when Git for Windows is installed", () => {
    const path = findGitBashPath();
    expect(path).not.toBeNull();
    expect(path!.toLowerCase()).toMatch(/bash\.exe$/);
  });

  test("resolveShellExecutable", () => {
    if (!isShellAvailable()) {
      const resolved = resolveShellExecutable();
      expect(resolved.ok).toBe(false);
      return;
    }
    const resolved = resolveShellExecutable();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.path.length).toBeGreaterThan(0);
    }
  });
});
