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

	const relationships = await db.relationship.findMany({
		where: {
			sessionId,
			OR: [
				{ sourceType: "concept", sourceId: { in: conceptIds } },
				{ targetType: "concept", targetId: { in: conceptIds } },
			],
		},
	});

	const chunkIds = new Set<string>();
	const resourceIds = new Set<string>();
	const chunkConceptMap = new Map<string, Array<{ name: string; relationship: string }>>();

	const addConcept = (chunkId: string, name: string, relationship: string) => {
		const list = chunkConceptMap.get(chunkId);
		if (list) list.push({ name, relationship });
		else chunkConceptMap.set(chunkId, [{ name, relationship }]);
	};

	for (const rel of relationships) {
		const isSource = rel.sourceType === "concept" && conceptIds.includes(rel.sourceId);
		const conceptId = isSource ? rel.sourceId : rel.targetId;
		const entityId = isSource ? rel.targetId : rel.sourceId;
		const entityType = isSource ? rel.targetType : rel.sourceType;
		const name = conceptNames.get(conceptId) || "";

		if (entityType === "chunk") {
			chunkIds.add(entityId);
			addConcept(entityId, name, rel.relationship);
		} else if (entityType === "resource") {
			resourceIds.add(entityId);
		}
	}

	if (resourceIds.size > 0) {
		const resourceChunks = await db.chunk.findMany({
			where: { resourceId: { in: Array.from(resourceIds) } },
			select: { id: true, resourceId: true },
		});
		for (const rc of resourceChunks) {
			chunkIds.add(rc.id);
			for (const rel of relationships) {
				const isSource = rel.sourceType === "concept" && conceptIds.includes(rel.sourceId);
				const entityId = isSource ? rel.targetId : rel.sourceId;
				const entityType = isSource ? rel.targetType : rel.sourceType;
				if (entityType === "resource" && entityId === rc.resourceId) {
					const conceptId = isSource ? rel.sourceId : rel.targetId;
					addConcept(rc.id, conceptNames.get(conceptId) || "", rel.relationship);
				}
			}
		}
	}

	if (chunkIds.size === 0) {
		log.info("searchGraph — concepts matched but no connected chunks");
		return [];
	}

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
