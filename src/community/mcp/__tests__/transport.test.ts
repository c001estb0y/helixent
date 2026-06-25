import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "bun:test";

import { buildStdioServerParameters, createMcpTransport, resolveRemoteHeaders, resolveStdioEnvironment } from "../transport";

describe("resolveStdioEnvironment", () => {
  test("layers configured env on top of the minimal safe environment", () => {
    const env = resolveStdioEnvironment({ command: "x", env: { FOO: "bar" } }, { SECRET: "leak", PATH: "/usr/bin" });
    expect(env.FOO).toBe("bar");
    expect(env.SECRET).toBeUndefined();
  });

  test("inherits the host environment when inheritEnv is true", () => {
    const env = resolveStdioEnvironment(
      { command: "x", inheritEnv: true, env: { FOO: "bar" } },
      { SECRET: "kept", PATH: "/usr/bin" },
    );
    expect(env.SECRET).toBe("kept");
    expect(env.FOO).toBe("bar");
  });
});

describe("resolveRemoteHeaders", () => {
  test("merges static headers and environment-derived headers", () => {
    const headers = resolveRemoteHeaders(
      {
        type: "streamable_http",
        url: "https://example.com",
        headers: { "X-Static": "1" },
        envHeaders: { Authorization: "TOKEN_ENV" },
      },
      { TOKEN_ENV: "Bearer abc" },
    );
    expect(headers).toEqual({ "X-Static": "1", Authorization: "Bearer abc" });
  });
});

describe("buildStdioServerParameters", () => {
  test("ignores the child process stderr so MCP logs do not corrupt the TUI", () => {
    const params = buildStdioServerParameters({ command: "echo", args: ["hi"] });
    expect(params.stderr).toBe("ignore");
    expect(params.command).toBe("echo");
    expect(params.args).toEqual(["hi"]);
  });
});

describe("createMcpTransport", () => {
  test("creates a stdio transport by default", () => {
    expect(createMcpTransport({ command: "echo" })).toBeInstanceOf(StdioClientTransport);
  });

  test("creates a streamable_http transport", () => {
    const transport = createMcpTransport({ type: "streamable_http", url: "https://example.com/mcp" });
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  test("creates an sse transport", () => {
    const transport = createMcpTransport({ type: "sse", url: "https://example.com/sse" });
    expect(transport).toBeInstanceOf(SSEClientTransport);
  });
});
