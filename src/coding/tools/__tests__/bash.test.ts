import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createBashTool, isShellAvailable } from "../bash";

describe("bashTool", () => {
  test.skipIf(!isShellAvailable())("returns stdout for a successful command", async () => {
    const result = await createBashTool({ cwd: process.cwd() }).invoke({
      description: "Echo greeting",
      command: "printf 'hi\\n'",
    });

    expect(result).toBe("hi\n");
  });

  test.skipIf(!isShellAvailable())("returns an error string when the command fails", async () => {
    const result = await createBashTool({ cwd: process.cwd() }).invoke({
      description: "Force non-zero exit",
      command: "exit 42",
    });

    expect(result).toMatch(/^Error: Command exit 42 failed with exit code 42:/);
  });

  test.skipIf(!isShellAvailable())("uses the configured cwd as the shell working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helixent-bash-cwd-"));
    try {
      const marker = join(dir, "cwd-marker.txt");
      const result = await createBashTool({ cwd: dir }).invoke({
        description: "Create marker in workspace cwd",
        command: "printf 'ok' > cwd-marker.txt && cat cwd-marker.txt",
      });
      expect(result).toBe("ok");
      expect(await Bun.file(marker).text()).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
