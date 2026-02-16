import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contentTools } from "./tools/content.js";
import { paperTools } from "./tools/papers.js";
import { sessionTools } from "./tools/sessions.js";

const server = new McpServer({
	name: "cramkit",
	version: "0.0.1",
});

// Register session tools
function registerTools(
	tools: Record<
		string,
		{
			description: string;
			parameters: { shape: Record<string, unknown> };
			execute: (params: never) => Promise<string>;
		}
	>,
) {
	for (const [name, tool] of Object.entries(tools)) {
		server.tool(
			name,
			tool.description,
			tool.parameters.shape,
			async (params: Record<string, unknown>) => {
				try {
					const result = await tool.execute(params as never);
					return { content: [{ type: "text" as const, text: result }] };
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
						isError: true,
					};
				}
			},
		);
	}
}

registerTools(sessionTools);
registerTools(contentTools);
registerTools(paperTools);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("CramKit MCP server running on stdio");
}

main().catch(console.error);
