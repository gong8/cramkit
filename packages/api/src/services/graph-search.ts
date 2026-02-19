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

interface RelSide {
	conceptId: string;
	entityId: string;
	entityType: string;
	relationship: string;
}

function resolveRelSide(
	rel: {
		sourceType: string;
		sourceId: string;
		targetType: string;
		targetId: string;
		relationship: string;
	},
	conceptIds: Set<string>,
): RelSide | null {
	if (rel.sourceType === "concept" && conceptIds.has(rel.sourceId)) {
		return {
			conceptId: rel.sourceId,
			entityId: rel.targetId,
			entityType: rel.targetType,
			relationship: rel.relationship,
		};
	}
	if (rel.targetType === "concept" && conceptIds.has(rel.targetId)) {
		return {
			conceptId: rel.targetId,
			entityId: rel.sourceId,
			entityType: rel.sourceType,
			relationship: rel.relationship,
		};
	}
	return null;
}

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
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
	const conceptIds = new Set(concepts.map((c) => c.id));
	const conceptNames = new Map(concepts.map((c) => [c.id, c.name]));

	const relationships = await db.relationship.findMany({
		where: {
			sessionId,
			OR: [
				{ sourceType: "concept", sourceId: { in: [...conceptIds] } },
				{ targetType: "concept", targetId: { in: [...conceptIds] } },
			],
		},
	});

	const chunkIds = new Set<string>();
	const chunkConceptMap = new Map<string, Array<{ name: string; relationship: string }>>();
	const resourceConceptEntries: Array<{
		resourceId: string;
		name: string;
		relationship: string;
	}> = [];

	for (const rel of relationships) {
		const side = resolveRelSide(rel, conceptIds);
		if (!side) continue;
		const name = conceptNames.get(side.conceptId) ?? "";

		if (side.entityType === "chunk") {
			chunkIds.add(side.entityId);
			appendToMap(chunkConceptMap, side.entityId, { name, relationship: side.relationship });
		} else if (side.entityType === "resource") {
			resourceConceptEntries.push({
				resourceId: side.entityId,
				name,
				relationship: side.relationship,
			});
		}
	}

	if (resourceConceptEntries.length > 0) {
		const resourceIds = [...new Set(resourceConceptEntries.map((e) => e.resourceId))];
		const resourceChunks = await db.chunk.findMany({
			where: { resourceId: { in: resourceIds } },
			select: { id: true, resourceId: true },
		});
		for (const rc of resourceChunks) {
			chunkIds.add(rc.id);
			for (const entry of resourceConceptEntries) {
				if (entry.resourceId === rc.resourceId) {
					appendToMap(chunkConceptMap, rc.id, {
						name: entry.name,
						relationship: entry.relationship,
					});
				}
			}
		}
	}

	if (chunkIds.size === 0) {
		log.info("searchGraph — concepts matched but no connected chunks");
		return [];
	}

	const chunks = await db.chunk.findMany({
		where: { id: { in: [...chunkIds] } },
		include: { resource: { select: { id: true, name: true, type: true } } },
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
		relatedConcepts: chunkConceptMap.get(chunk.id) ?? [],
	}));
}
