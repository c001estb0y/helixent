import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { writeFileTool } from "../write-file";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "helixent-write-file-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("writeFileTool", () => {
  test("writes content to an absolute path", async () => {
    const filePath = join(tempDir, "out.txt");

    const result = await writeFileTool.invoke({
      description: "Create demo file",
      path: filePath,
      content: "hello\nworld\n",
    });

    expect(result).toMatchObject({ ok: true, data: { path: filePath, bytes: 12 } });
    await expect(readFile(filePath, "utf8")).resolves.toBe("hello\nworld\n");
  });

  test("overwrites an existing file", async () => {
    const filePath = join(tempDir, "mutable.txt");
    await writeFile(filePath, "before\n");

    const result = await writeFileTool.invoke({
      description: "Overwrite file",
      path: filePath,
      content: "after\n",
    });

    expect(result).toMatchObject({ ok: true });
    await expect(readFile(filePath, "utf8")).resolves.toBe("after\n");
  });

  test("writes into an existing subdirectory", async () => {
    const subDir = join(tempDir, "nested");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "deep.txt");

    const result = await writeFileTool.invoke({
      description: "Write nested file",
      path: filePath,
      content: "nested\n",
    });

    expect(result).toMatchObject({ ok: true });
    await expect(readFile(filePath, "utf8")).resolves.toBe("nested\n");
  });

  test("creates parent directories when they do not exist", async () => {
    const filePath = join(tempDir, "a", "b", "c", "deep.txt");

    const result = await writeFileTool.invoke({
      description: "Write deeply nested file",
      path: filePath,
      content: "deep content\n",
    });

    expect(result).toMatchObject({ ok: true, data: { path: filePath } });
    await expect(readFile(filePath, "utf8")).resolves.toBe("deep content\n");
  });

  test("resolves relative path against cwd", async () => {
    const name = `helixent-write-rel-${Date.now()}.txt`;
    const expected = join(process.cwd(), name);
    try {
      const result = await writeFileTool.invoke({
        description: "Relative path test",
        path: name,
        content: "resolved",
      });

      expect(result).toMatchObject({ ok: true, data: { path: expected } });
      await expect(readFile(expected, "utf8")).resolves.toBe("resolved");
    } finally {
      await rm(expected, { force: true });
    }
  });
});
