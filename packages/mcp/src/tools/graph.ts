import { z } from "zod";
import { apiClient } from "../lib/api-client.js";
import { conceptId, sessionId } from "./params.js";

export const graphTools = {
	create_link: {
		description:
			"Create a relationship link between two entities in the knowledge graph. Entities can be resources, chunks, or concepts.",
		parameters: z.object({
			sessionId,
			sourceType: z
				.string()
				.describe("Type of the source entity: 'resource', 'chunk', or 'concept'"),
			sourceId: z.string().describe("ID of the source entity"),
			sourceLabel: z.string().optional().describe("Human-readable label for the source"),
			targetType: z
				.string()
				.describe("Type of the target entity: 'resource', 'chunk', or 'concept'"),
			targetId: z.string().describe("ID of the target entity"),
			targetLabel: z.string().optional().describe("Human-readable label for the target"),
			relationship: z
				.string()
				.describe("Type of relationship: 'prerequisite', 'related_to', 'extends', 'covers', etc."),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("Confidence score 0-1 (default 1.0)"),
		}),
		execute: async ({ sessionId, ...rest }: { sessionId: string; [k: string]: unknown }) =>
			apiClient.createRelationship(sessionId, { ...rest, createdBy: "claude" }),
	},

	get_related: {
		description:
			"Get all knowledge graph relationships for an entity. Returns relationships where the entity appears as source or target. Each relationship includes: sourceType, sourceId, sourceLabel, targetType, targetId, targetLabel, relationship (e.g. 'covers', 'prerequisite', 'related_to'), and confidence (0-1). Use this to explore connections between resources, chunks, and concepts.",
		parameters: z.object({
			type: z.string().describe("Entity type: 'resource', 'chunk', or 'concept'"),
			id: z.string().describe("Entity ID"),
			relationshipType: z.string().optional().describe("Filter by relationship type"),
		}),
		execute: async ({
			type,
			id,
			relationshipType,
		}: { type: string; id: string; relationshipType?: string }) =>
			apiClient.getRelated(type, id, relationshipType),
	},

	list_concepts: {
		description:
			"List all concepts extracted from study materials in a session. Returns an array of concepts, each with: id, name, description, aliases (comma-separated alternate names), sessionId, and timestamps. Use this to discover what topics and ideas the knowledge graph has identified across all resources.",
		parameters: z.object({ sessionId }),
		execute: async ({ sessionId }: { sessionId: string }) => apiClient.listConcepts(sessionId),
	},

	get_concept: {
		description:
			"Get a concept's full details and all its knowledge graph relationships. Returns the concept (id, name, description, aliases) plus all relationships where this concept is source or target — linking it to other concepts, chunks, and resources. Use this for concept-centric graph exploration: start from a concept and discover what material covers it, what prerequisites it has, and what other concepts it relates to.",
		parameters: z.object({ conceptId }),
		execute: async ({ conceptId }: { conceptId: string }) => apiClient.getConcept(conceptId),
	},

	get_graph_log: {
		description:
			"View the indexing and enrichment history for a session. Shows a log of all graph mutations from every source: indexer (extraction), enricher (chat-based), cross-linker, and amortiser. Each entry includes concepts/relationships created, duration, and source details.",
		parameters: z.object({
			sessionId,
			source: z
				.string()
				.optional()
				.describe("Filter by source: 'indexer', 'enricher', 'cross-linker', or 'amortiser'"),
			limit: z.number().optional().describe("Max entries to return (default 50)"),
		}),
		execute: async ({
			sessionId,
			source,
			limit,
		}: { sessionId: string; source?: string; limit?: number }) =>
			apiClient.getGraphLog(sessionId, source, limit),
	},
};
