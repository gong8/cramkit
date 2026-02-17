import { createLogger, getDb } from "@cramkit/shared";

const log = createLogger("api");

export interface GraphSearchResult {
	chunkId: string;
	resourceId: string;
	resourceName: string;
	resourceType: string;
	title: string | null;
	content: string;
	nodeType: string;
	keywords: string | null;
	source: "graph";
	relatedConcepts: Array<{ name: string; relationship: string }>;
}

interface ConceptRelEdge {
	entityId: string;
	entityType: string;
	conceptName: string;
	relationship: string;
}

function extractEdges(
	relationships: Array<{
		sourceType: string;
		sourceId: string;
		targetType: string;
		targetId: string;
		relationship: string;
	}>,
	conceptIds: string[],
	conceptNames: Map<string, string>,
): ConceptRelEdge[] {
	const edges: ConceptRelEdge[] = [];
	for (const rel of relationships) {
		const isSourceConcept = rel.sourceType === "concept" && conceptIds.includes(rel.sourceId);
		const isTargetConcept = rel.targetType === "concept" && conceptIds.includes(rel.targetId);
		if (!isSourceConcept && !isTargetConcept) continue;

		const conceptId = isSourceConcept ? rel.sourceId : rel.targetId;
		const entityId = isSourceConcept ? rel.targetId : rel.sourceId;
		const entityType = isSourceConcept ? rel.targetType : rel.sourceType;

		edges.push({
			entityId,
			entityType,
			conceptName: conceptNames.get(conceptId) || "",
			relationship: rel.relationship,
		});
	}
	return edges;
}

function appendConcept(
	map: Map<string, Array<{ name: string; relationship: string }>>,
	chunkId: string,
	edge: { conceptName: string; relationship: string },
) {
	const list = map.get(chunkId) || [];
	list.push({ name: edge.conceptName, relationship: edge.relationship });
	map.set(chunkId, list);
}

export async function searchGraph(
	sessionId: string,
	query: string,
	limit: number,
): Promise<GraphSearchResult[]> {
	const db = getDb();

	// Token-based fuzzy concept matching
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 1);
	const allConcepts = await db.concept.findMany({
		where: { sessionId },
		select: { id: true, name: true, description: true, aliases: true },
	});
	const concepts = allConcepts.filter((c) => {
		const text = `${c.name} ${c.description ?? ""} ${c.aliases ?? ""}`.toLowerCase();
		return terms.length > 0 && terms.every((t) => text.includes(t));
	});

	if (concepts.length === 0) {
		log.info(`searchGraph — no concepts matched "${query}"`);
		return [];
	}

	log.info(`searchGraph — found ${concepts.length} matching concepts for "${query}"`);
	const conceptIds = concepts.map((c) => c.id);
	const conceptNames = new Map(concepts.map((c) => [c.id, c.name]));

	// Find relationships where matching concepts are source or target
	const relationships = await db.relationship.findMany({
		where: {
			sessionId,
			OR: [
				{ sourceType: "concept", sourceId: { in: conceptIds } },
				{ targetType: "concept", targetId: { in: conceptIds } },
			],
		},
	});

	const edges = extractEdges(relationships, conceptIds, conceptNames);

	const chunkIds = new Set<string>();
	const resourceIds = new Set<string>();
	const chunkConceptMap = new Map<string, Array<{ name: string; relationship: string }>>();

	for (const edge of edges) {
		if (edge.entityType === "chunk") {
			chunkIds.add(edge.entityId);
			appendConcept(chunkConceptMap, edge.entityId, edge);
		} else if (edge.entityType === "resource") {
			resourceIds.add(edge.entityId);
		}
	}

	// For resource-level relationships, get their chunks
	if (resourceIds.size > 0) {
		const resourceChunks = await db.chunk.findMany({
			where: { resourceId: { in: Array.from(resourceIds) } },
			select: { id: true, resourceId: true },
		});
		for (const rc of resourceChunks) {
			chunkIds.add(rc.id);
			for (const edge of edges) {
				if (edge.entityType === "resource" && edge.entityId === rc.resourceId) {
					appendConcept(chunkConceptMap, rc.id, edge);
				}
			}
		}
	}

	if (chunkIds.size === 0) {
		log.info("searchGraph — concepts matched but no connected chunks");
		return [];
	}

	// Fetch chunks with resource metadata
	const chunks = await db.chunk.findMany({
		where: { id: { in: Array.from(chunkIds) } },
		include: {
			resource: { select: { id: true, name: true, type: true } },
		},
		take: limit,
	});

	log.info(`searchGraph — returning ${chunks.length} results from graph`);

	return chunks.map((chunk) => ({
		chunkId: chunk.id,
		resourceId: chunk.resource.id,
		resourceName: chunk.resource.name,
		resourceType: chunk.resource.type,
		title: chunk.title,
		content: chunk.content,
		nodeType: chunk.nodeType,
		keywords: chunk.keywords,
		source: "graph" as const,
		relatedConcepts: chunkConceptMap.get(chunk.id) || [],
	}));
}
