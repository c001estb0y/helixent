import { normalize } from "node:path";
import z from "zod";

import { defineTool } from "@/foundation";

import { isShellAvailable, resolveShellExecutable, shellSpawnCmd } from "./shell";

const bashParameters = z.object({
  description: z
    .string()
    .describe("Explain why you want to execute the command. Always place `description` as the first parameter."),
  command: z.string().describe("The bash command to execute."),
});

export function createBashTool({ cwd }: { cwd: string }) {
  const workspaceCwd = normalize(cwd);

  return defineTool({
    name: "bash",
    description:
      process.platform === "win32"
        ? "Execute a bash command via Git Bash in the agent working directory. Prefer relative paths from the working directory."
        : "Execute a bash command in the agent working directory.",
    parameters: bashParameters,
    invoke: async ({ command }, signal) => {
      const shell = resolveShellExecutable();
      if (!shell.ok) {
        return `Error: ${shell.error}`;
      }

      const proc = Bun.spawn({
        cmd: shellSpawnCmd(shell.path, command),
        cwd: workspaceCwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      if (signal) {
        const onAbort = () => proc.kill();
        signal.addEventListener("abort", onAbort, { once: true });
        void proc.exited.then(() => signal.removeEventListener("abort", onAbort));
      }

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return `Error: Command ${command} failed with exit code ${exitCode}: ${stderr}`;
      }
      return output;
    },
  });
}

/** Default instance (cwd = process.cwd()); prefer createBashTool from createCodingAgent. */
export const bashTool = createBashTool({ cwd: process.cwd() });

export { isShellAvailable };
