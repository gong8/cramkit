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

	// Collect chunk IDs and resource IDs from relationships
	const chunkIds = new Set<string>();
	const resourceIds = new Set<string>();
	const chunkConceptMap = new Map<string, Array<{ name: string; relationship: string }>>();

	for (const rel of relationships) {
		let entityId: string | null = null;
		let entityType: string | null = null;
		let conceptId: string | null = null;

		if (rel.sourceType === "concept" && conceptIds.includes(rel.sourceId)) {
			entityId = rel.targetId;
			entityType = rel.targetType;
			conceptId = rel.sourceId;
		} else if (rel.targetType === "concept" && conceptIds.includes(rel.targetId)) {
			entityId = rel.sourceId;
			entityType = rel.sourceType;
			conceptId = rel.targetId;
		}

		if (!entityId || !entityType || !conceptId) continue;

		if (entityType === "chunk") {
			chunkIds.add(entityId);
			const existing = chunkConceptMap.get(entityId) || [];
			existing.push({
				name: conceptNames.get(conceptId) || "",
				relationship: rel.relationship,
			});
			chunkConceptMap.set(entityId, existing);
		} else if (entityType === "resource") {
			resourceIds.add(entityId);
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
			const resourceRels = relationships.filter(
				(r) =>
					(r.sourceType === "resource" && r.sourceId === rc.resourceId) ||
					(r.targetType === "resource" && r.targetId === rc.resourceId),
			);
			for (const rel of resourceRels) {
				const conceptId = rel.sourceType === "concept" ? rel.sourceId : rel.targetId;
				const existing = chunkConceptMap.get(rc.id) || [];
				existing.push({
					name: conceptNames.get(conceptId) || "",
					relationship: rel.relationship,
				});
				chunkConceptMap.set(rc.id, existing);
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
