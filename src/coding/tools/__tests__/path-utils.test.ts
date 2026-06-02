import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { expandPath, posixPathToWindowsPath, resolveAbsolutePath } from "../tool-utils";

describe("posixPathToWindowsPath", () => {
  test("converts /c/Users style paths", () => {
    expect(posixPathToWindowsPath("/c/Users/dev")).toBe("C:\\Users\\dev");
  });

  test("converts cygdrive paths", () => {
    expect(posixPathToWindowsPath("/cygdrive/d/Work")).toBe("D:\\Work");
  });
});

describe("expandPath", () => {
  test("expands tilde to home", () => {
    expect(expandPath("~")).toBe(resolve(homedir()));
  });

  test("resolves relative path against baseDir", () => {
    const base = join(tmpdir(), "helixent-path-base");
    expect(expandPath("./nested/file.txt", base)).toBe(resolve(base, "nested/file.txt"));
  });

  test("keeps absolute unix-style paths on posix", () => {
    if (process.platform === "win32") {
      return;
    }
    expect(expandPath("/tmp/example")).toBe("/tmp/example");
  });

  test("accepts Windows drive paths on win32", () => {
    if (process.platform !== "win32") {
      return;
    }
    expect(expandPath("C:\\Users\\dev\\repo")).toBe("C:\\Users\\dev\\repo");
    expect(expandPath("C:/Users/dev/repo")).toBe("C:\\Users\\dev\\repo");
    expect(expandPath("/c/Users/dev/repo")).toBe("C:\\Users\\dev\\repo");
  });
});

describe("resolveAbsolutePath", () => {
  test("rejects empty path", () => {
    const result = resolveAbsolutePath("   ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(resolve(process.cwd()));
    }
  });

  test("rejects null bytes", () => {
    const result = resolveAbsolutePath("bad\0path");
    expect(result.ok).toBe(false);
  });
});
