import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

export const contentTools = {
	search_notes: {
		description:
			"Search across all indexed materials in a session. Searches chunk titles, keywords, and content.",
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
			const results = await apiClient.searchNotes(sessionId, query, limit);
			return JSON.stringify(results, null, 2);
		},
	},

	get_file_content: {
		description: "Get the full processed content of a specific file. Use for smaller files.",
		parameters: z.object({
			fileId: z.string().describe("The file ID"),
		}),
		execute: async ({ fileId }: { fileId: string }) => {
			const file = await apiClient.getFileContent(fileId);
			return JSON.stringify(file, null, 2);
		},
	},

	get_chunk: {
		description: "Get a specific chunk by ID.",
		parameters: z.object({
			chunkId: z.string().describe("The chunk ID"),
		}),
		execute: async ({ chunkId }: { chunkId: string }) => {
			const chunk = await apiClient.getChunk(chunkId);
			return JSON.stringify(chunk, null, 2);
		},
	},

	get_file_index: {
		description:
			"Get the table of contents / index of a file. Use to understand structure before diving into specific sections.",
		parameters: z.object({
			fileId: z.string().describe("The file ID"),
		}),
		execute: async ({ fileId }: { fileId: string }) => {
			const chunks = await apiClient.getFileChunks(fileId);
			return JSON.stringify(chunks, null, 2);
		},
	},
};
