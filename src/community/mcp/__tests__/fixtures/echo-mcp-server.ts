import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// A minimal stdio MCP server used as a stand-in for an agent-memory style server
// in the stdio integration acceptance test.
const server = new McpServer({ name: "agent-memory-fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo back the provided message",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
