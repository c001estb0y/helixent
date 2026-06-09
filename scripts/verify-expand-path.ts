/**
 * Quick manual check for expandPath / file tools on Windows.
 * Run: bun run scripts/verify-expand-path.ts
 */
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileInfoTool } from "../src/coding/tools/file-info";
import { readFileTool } from "../src/coding/tools/read-file";
import { expandPath, resolveAbsolutePath } from "../src/coding/tools/tool-utils";

const repoRoot = process.cwd();
const probeFile = join(repoRoot, "package.json");

const pathVariants = [
  { label: "Windows backslash", path: probeFile },
  { label: "Windows forward slash", path: probeFile.replace(/\\/g, "/") },
  ...(process.platform === "win32"
    ? [{ label: "Git-Bash /c/ style", path: `/${probeFile[0]!.toLowerCase()}${probeFile.slice(2).replace(/\\/g, "/")}` }]
    : []),
  { label: "Relative package.json", path: "package.json" },
];

console.log(`cwd: ${repoRoot}\n`);

let failed = 0;

for (const { label, path } of pathVariants) {
  const resolved = resolveAbsolutePath(path);
  const ok = resolved.ok && resolved.path.toLowerCase() === expandPath(probeFile).toLowerCase();
  console.log(`${ok ? "PASS" : "FAIL"} expand  ${label}`);
  console.log(`       in:  ${path}`);
  console.log(`       out: ${resolved.ok ? resolved.path : resolved.error}\n`);
  if (!ok) failed++;
}

console.log("--- tool invoke (read_file) ---\n");
const readResult = await readFileTool.invoke({
  description: "verify expandPath",
  path: probeFile,
});
const readOk = typeof readResult === "string" && readResult.includes('"name"');
console.log(readOk ? "PASS read_file with E:\\ path" : `FAIL read_file: ${String(readResult).slice(0, 120)}...`);
if (!readOk) failed++;

console.log("\n--- tool invoke (file_info) ---\n");
const infoResult = await fileInfoTool.invoke({
  description: "verify expandPath",
  path: process.platform === "win32" ? probeFile.replace(/\\/g, "/") : probeFile,
});
console.log(infoResult.ok ? "PASS file_info" : `FAIL file_info: ${JSON.stringify(infoResult)}`);
if (!infoResult.ok) failed++;

if (process.platform === "win32") {
  const tmp = join(tmpdir(), `helixent-patch-${Date.now()}.txt`);
  await writeFile(tmp, "line1\nline2\n");
  const winPath = tmp.replace(/\//g, "\\");
  const patch = ["--- a/x", `+++ b/${winPath}`, "@@ -1,2 +1,2 @@", "-line1", "+LINE1", " line2", ""].join("\n");
  const { applyPatchTool } = await import("../src/coding/tools/apply-patch");
  const patchResult = await applyPatchTool.invoke({ description: "verify patch path", patch });
  const text = patchResult.ok ? await Bun.file(tmp).text() : "";
  const patchOk = patchResult.ok && text.startsWith("LINE1");
  console.log("\n--- apply_patch with Windows path in header ---\n");
  console.log(patchOk ? "PASS apply_patch" : `FAIL apply_patch: ${JSON.stringify(patchResult)}`);
  await rm(tmp, { force: true });
  if (!patchOk) failed++;
}

console.log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
