import { createLogger } from "@cramkit/shared";
import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

const log = createLogger("mcp");

export const contentTools = {
	search_notes: {
		description:
			"Search across all indexed materials in a session. Searches chunk titles, keywords, and content. Results are ranked by relevance and include resourceId, resourceName, resourceType.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
			query: z.string().describe("Search query"),
			limit: z.number().optional().describe("Max results (default 10)"),
		}),
		execute: async ({
			sessionId,
			query,
			limit,
		}: {
			sessionId: string;
			query: string;
			limit?: number;
		}) => {
			log.info(`search_notes — session=${sessionId}, query="${query}", limit=${limit ?? 10}`);
			const results = await apiClient.searchNotes(sessionId, query, limit);
			log.info(`search_notes — found ${(results as unknown[]).length} results`);
			return JSON.stringify(results, null, 2);
		},
	},

	get_resource_content: {
		description:
			"Get the full processed markdown content of a resource. Returns the complete text from all files in the resource as a single string.",
		parameters: z.object({
			resourceId: z.string().describe("The resource ID"),
		}),
		execute: async ({ resourceId }: { resourceId: string }) => {
			log.info(`get_resource_content — ${resourceId}`);
			const resource = await apiClient.getResourceContent(resourceId);
			return JSON.stringify(resource, null, 2);
		},
	},

	get_resource_info: {
		description:
			"Get resource metadata including its files and chunks (without full content). Returns resource details, type, constituent files with roles, and a list of chunk summaries.",
		parameters: z.object({
			resourceId: z.string().describe("The resource ID"),
		}),
		execute: async ({ resourceId }: { resourceId: string }) => {
			log.info(`get_resource_info — ${resourceId}`);
			const resource = await apiClient.getResource(resourceId);
			return JSON.stringify(resource, null, 2);
		},
	},

	get_chunk: {
		description: "Get a specific chunk by ID. Returns the chunk content, title, nodeType, and parent resource info.",
		parameters: z.object({
			chunkId: z.string().describe("The chunk ID"),
		}),
		execute: async ({ chunkId }: { chunkId: string }) => {
			log.info(`get_chunk — ${chunkId}`);
			const chunk = await apiClient.getChunk(chunkId);
			return JSON.stringify(chunk, null, 2);
		},
	},

	get_resource_index: {
		description:
			"Get the hierarchical table of contents / tree structure of a resource. Shows section headings, node types (chapter, section, definition, theorem, proof, example, question), and depth. The tree spans all files in the resource. Use this to understand a resource's structure before diving into specific sections.",
		parameters: z.object({
			resourceId: z.string().describe("The resource ID"),
		}),
		execute: async ({ resourceId }: { resourceId: string }) => {
			log.info(`get_resource_index — ${resourceId}`);
			const tree = await apiClient.getResourceTree(resourceId);
			log.info(`get_resource_index — returned tree for ${resourceId}`);
			return JSON.stringify(tree, null, 2);
		},
	},
};
