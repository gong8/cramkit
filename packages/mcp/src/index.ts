import { createServer } from "node:http";
import { createLogger } from "@cramkit/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { contentTools } from "./tools/content.js";
import { paperTools } from "./tools/papers.js";
import { sessionTools } from "./tools/sessions.js";

const log = createLogger("mcp");

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
				log.info(`tool called: ${name}`, params);
				try {
					const result = await tool.execute(params as never);
					log.info(`tool completed: ${name}`);
					return { content: [{ type: "text" as const, text: result }] };
				} catch (error) {
					log.error(`tool failed: ${name}`, error);
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

const MCP_PORT = Number(process.env.CRAMKIT_MCP_PORT) || 3001;

async function main() {
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // stateless mode
	});
	await server.connect(transport);

	const httpServer = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

		if (url.pathname === "/mcp") {
			log.debug(`HTTP ${req.method} /mcp`);
			transport.handleRequest(req, res);
			return;
		}

		// Health check
		if (url.pathname === "/health") {
			log.debug("HTTP GET /health");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}

		log.warn(`Unknown route: ${req.method} ${url.pathname}`);
		res.writeHead(404);
		res.end("Not found");
	});

	httpServer.listen(MCP_PORT, "127.0.0.1", () => {
		log.info(`CramKit MCP server running on http://127.0.0.1:${MCP_PORT}/mcp`);
	});
}

main().catch((err) => log.error("MCP server crashed", err));
