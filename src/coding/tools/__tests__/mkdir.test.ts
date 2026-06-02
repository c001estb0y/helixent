import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdirTool } from "../mkdir";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-mkdir-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("mkdirTool", () => {
  test("creates a directory recursively", async () => {
    const dirPath = join(tempDir, "nested", "child");

    const result = await mkdirTool.invoke({
      description: "Create nested directory",
      path: dirPath,
      recursive: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: dirPath,
        recursive: true,
      },
    });

    await expect(stat(dirPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  test("resolves relative path against cwd", async () => {
    const relDir = join(`helixent-mkdir-rel-${Date.now()}`, "nested");
    const expected = join(process.cwd(), relDir);
    try {
      const result = await mkdirTool.invoke({
        description: "Create relative directory",
        path: relDir,
        recursive: true,
      });

      expect(result).toMatchObject({ ok: true, data: { path: expected } });
    } finally {
      await rm(expected, { recursive: true, force: true });
    }
  });
});
