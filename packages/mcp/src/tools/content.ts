import { createLogger } from "@cramkit/shared";
import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

const log = createLogger("mcp");

interface RelationshipRow {
	sourceType: string;
	sourceId: string;
	sourceLabel?: string | null;
	targetType: string;
	targetId: string;
	targetLabel?: string | null;
	relationship: string;
	confidence: number | null;
}

function extractConceptLinks(
	entityType: string,
	entityId: string,
	relationships: RelationshipRow[],
): Array<{ conceptId: string; conceptName: string; relationship: string; confidence: number }> {
	const concepts: Array<{
		conceptId: string;
		conceptName: string;
		relationship: string;
		confidence: number;
	}> = [];

	for (const rel of relationships) {
		if (
			rel.sourceType === "concept" &&
			rel.targetType === entityType &&
			rel.targetId === entityId
		) {
			concepts.push({
				conceptId: rel.sourceId,
				conceptName: rel.sourceLabel || rel.sourceId,
				relationship: rel.relationship,
				confidence: rel.confidence ?? 1,
			});
		} else if (
			rel.targetType === "concept" &&
			rel.sourceType === entityType &&
			rel.sourceId === entityId
		) {
			concepts.push({
				conceptId: rel.targetId,
				conceptName: rel.targetLabel || rel.targetId,
				relationship: rel.relationship,
				confidence: rel.confidence ?? 1,
			});
		}
	}

	return concepts;
}

export const contentTools = {
	search_notes: {
		description:
			"Search across all indexed materials in a session. Uses both text search and knowledge graph concept matching for enhanced results. Results are ranked by relevance and include: chunkId, resourceId, resourceName, resourceType, title, content, score, and relatedConcepts (concepts linked to each result via the knowledge graph). Use this as the primary entry point for finding material on a topic.",
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
			"Get resource metadata including its files, chunks, and related concepts from the knowledge graph. Returns resource details, type, constituent files with roles, a list of chunk summaries, and relatedConcepts showing which concepts this resource covers.",
		parameters: z.object({
			resourceId: z.string().describe("The resource ID"),
		}),
		execute: async ({ resourceId }: { resourceId: string }) => {
			log.info(`get_resource_info — ${resourceId}`);
			const [resource, relationships] = await Promise.all([
				apiClient.getResource(resourceId),
				apiClient.getRelated("resource", resourceId),
			]);
			const relatedConcepts = extractConceptLinks(
				"resource",
				resourceId,
				relationships as RelationshipRow[],
			);
			log.info(`get_resource_info — ${resourceId}, ${relatedConcepts.length} related concepts`);
			return JSON.stringify({ ...(resource as object), relatedConcepts }, null, 2);
		},
	},

	get_chunk: {
		description:
			"Get a specific chunk by ID. Returns the chunk content, title, nodeType, parent resource info, and relatedConcepts from the knowledge graph showing which concepts this chunk covers.",
		parameters: z.object({
			chunkId: z.string().describe("The chunk ID"),
		}),
		execute: async ({ chunkId }: { chunkId: string }) => {
			log.info(`get_chunk — ${chunkId}`);
			const [chunk, relationships] = await Promise.all([
				apiClient.getChunk(chunkId),
				apiClient.getRelated("chunk", chunkId),
			]);
			const relatedConcepts = extractConceptLinks(
				"chunk",
				chunkId,
				relationships as RelationshipRow[],
			);
			log.info(`get_chunk — ${chunkId}, ${relatedConcepts.length} related concepts`);
			return JSON.stringify({ ...(chunk as object), relatedConcepts }, null, 2);
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
