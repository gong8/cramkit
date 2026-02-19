import { z } from "zod";
import { apiClient } from "../lib/api-client.js";
import { chunkId, resourceId, sessionId } from "./params.js";

interface RelRow {
	sourceType: string;
	sourceId: string;
	sourceLabel?: string | null;
	targetType: string;
	targetId: string;
	targetLabel?: string | null;
	relationship: string;
	confidence: number | null;
}

function extractConceptLinks(type: string, id: string, rows: RelRow[]) {
	return rows
		.filter(
			(r) =>
				(r.sourceType === "concept" && r.targetType === type && r.targetId === id) ||
				(r.targetType === "concept" && r.sourceType === type && r.sourceId === id),
		)
		.map((r) => {
			const isSrc = r.sourceType === "concept";
			return {
				conceptId: isSrc ? r.sourceId : r.targetId,
				conceptName: (isSrc ? r.sourceLabel : r.targetLabel) || (isSrc ? r.sourceId : r.targetId),
				relationship: r.relationship,
				confidence: r.confidence ?? 1,
			};
		});
}

async function fetchWithConcepts(type: string, id: string, fetcher: () => Promise<unknown>) {
	const [entity, rels] = await Promise.all([fetcher(), apiClient.getRelated(type, id)]);
	return {
		...(entity as object),
		relatedConcepts: extractConceptLinks(type, id, rels as RelRow[]),
	};
}

export const contentTools = {
	search_notes: {
		description:
			"Search across all indexed materials in a session. Uses both text search and knowledge graph concept matching for enhanced results. Results are ranked by relevance and include: chunkId, resourceId, resourceName, resourceType, title, content, score, and relatedConcepts (concepts linked to each result via the knowledge graph). Use this as the primary entry point for finding material on a topic.",
		parameters: z.object({
			sessionId,
			query: z.string().describe("Search query"),
			limit: z.number().optional().describe("Max results (default 10)"),
		}),
		execute: async (p: { sessionId: string; query: string; limit?: number }) =>
			apiClient.searchNotes(p.sessionId, p.query, p.limit),
	},

	get_resource_content: {
		description:
			"Get the full processed markdown content of a resource. Returns the complete text from all files in the resource as a single string.",
		parameters: z.object({ resourceId }),
		execute: async (p: { resourceId: string }) => apiClient.getResourceContent(p.resourceId),
	},

	get_resource_info: {
		description:
			"Get resource metadata including its files, chunks, and related concepts from the knowledge graph. Returns resource details, type, constituent files with roles, a list of chunk summaries, and relatedConcepts showing which concepts this resource covers.",
		parameters: z.object({ resourceId }),
		execute: async (p: { resourceId: string }) =>
			fetchWithConcepts("resource", p.resourceId, () => apiClient.getResource(p.resourceId)),
	},

	get_chunk: {
		description:
			"Get a specific chunk by ID. Returns the chunk content, title, nodeType, parent resource info, and relatedConcepts from the knowledge graph showing which concepts this chunk covers.",
		parameters: z.object({ chunkId }),
		execute: async (p: { chunkId: string }) =>
			fetchWithConcepts("chunk", p.chunkId, () => apiClient.getChunk(p.chunkId)),
	},

	get_resource_index: {
		description:
			"Get the hierarchical table of contents / tree structure of a resource. Shows section headings, node types (chapter, section, definition, theorem, proof, example, question), and depth. The tree spans all files in the resource. Use this to understand a resource's structure before diving into specific sections.",
		parameters: z.object({ resourceId }),
		execute: async (p: { resourceId: string }) => apiClient.getResourceTree(p.resourceId),
	},
};
