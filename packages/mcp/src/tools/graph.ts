import { createLogger } from "@cramkit/shared";
import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

const log = createLogger("mcp");

export const graphTools = {
	create_link: {
		description:
			"Create a relationship link between two entities in the knowledge graph. Entities can be resources, chunks, or concepts.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
			sourceType: z.string().describe("Type of the source entity: 'resource', 'chunk', or 'concept'"),
			sourceId: z.string().describe("ID of the source entity"),
			sourceLabel: z.string().optional().describe("Human-readable label for the source"),
			targetType: z.string().describe("Type of the target entity: 'resource', 'chunk', or 'concept'"),
			targetId: z.string().describe("ID of the target entity"),
			targetLabel: z.string().optional().describe("Human-readable label for the target"),
			relationship: z.string().describe("Type of relationship: 'prerequisite', 'related_to', 'extends', 'covers', etc."),
			confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1 (default 1.0)"),
		}),
		execute: async (params: {
			sessionId: string;
			sourceType: string;
			sourceId: string;
			sourceLabel?: string;
			targetType: string;
			targetId: string;
			targetLabel?: string;
			relationship: string;
			confidence?: number;
		}) => {
			log.info(`create_link — ${params.sourceType}:${params.sourceId} -> ${params.targetType}:${params.targetId}`);
			const result = await apiClient.createRelationship(params.sessionId, {
				sourceType: params.sourceType,
				sourceId: params.sourceId,
				sourceLabel: params.sourceLabel,
				targetType: params.targetType,
				targetId: params.targetId,
				targetLabel: params.targetLabel,
				relationship: params.relationship,
				confidence: params.confidence,
				createdBy: "claude",
			});
			return JSON.stringify(result, null, 2);
		},
	},

	get_related: {
		description:
			"Get related items for an entity in the knowledge graph. Returns all relationships where the entity is source or target.",
		parameters: z.object({
			type: z.string().describe("Entity type: 'resource', 'chunk', or 'concept'"),
			id: z.string().describe("Entity ID"),
			relationshipType: z.string().optional().describe("Filter by relationship type"),
		}),
		execute: async (params: { type: string; id: string; relationshipType?: string }) => {
			log.info(`get_related — type=${params.type}, id=${params.id}`);
			const results = await apiClient.getRelated(params.type, params.id, params.relationshipType);
			log.info(`get_related — found ${(results as unknown[]).length} relationships`);
			return JSON.stringify(results, null, 2);
		},
	},

	list_concepts: {
		description: "List all concepts extracted from the knowledge graph for a session.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			log.info(`list_concepts — session=${sessionId}`);
			const concepts = await apiClient.listConcepts(sessionId);
			log.info(`list_concepts — found ${(concepts as unknown[]).length} concepts`);
			return JSON.stringify(concepts, null, 2);
		},
	},
};
