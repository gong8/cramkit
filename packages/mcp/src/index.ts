import { createServer } from "node:http";
import { createLogger } from "@cramkit/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { contentTools } from "./tools/content.js";
import { graphTools } from "./tools/graph.js";
import { paperTools } from "./tools/papers.js";
import { sessionTools } from "./tools/sessions.js";

const log = createLogger("mcp");

const server = new McpServer({
	name: "cramkit",
	version: "0.0.1",
});

function registerTools(
	tools: Record<
		string,
		{
			description: string;
			parameters: { shape: Record<string, unknown> };
			execute: (params: never) => Promise<unknown>;
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
					const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
					log.info(`tool completed: ${name}`);
					return { content: [{ type: "text" as const, text }] };
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
registerTools(graphTools);

const MCP_PORT = Number(process.env.CRAMKIT_MCP_PORT) || 3001;
const useStdio = process.argv.includes("--stdio");

async function main() {
	if (useStdio) {
		const transport = new StdioServerTransport();
		await server.connect(transport);
		log.info("CramKit MCP server running on stdio");
		return;
	}

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

		if (url.pathname === "/mcp") {
			log.debug(`HTTP ${req.method} /mcp`);
			try {
				// Stateless mode: close previous transport and create a new one per request
				await server.close();
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
				});
				await server.connect(transport);
				await transport.handleRequest(req, res);
			} catch (err) {
				log.error("MCP request failed", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			}
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
