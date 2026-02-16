import { createLogger, getDb } from "@cramkit/shared";

const log = createLogger("api");

export interface GraphSearchResult {
	chunkId: string;
	fileId: string;
	fileName: string;
	fileType: string;
	title: string | null;
	content: string;
	source: "graph";
	relatedConcepts: Array<{ name: string; relationship: string }>;
}

export async function searchGraph(
	sessionId: string,
	query: string,
	limit: number,
): Promise<GraphSearchResult[]> {
	const db = getDb();
	const queryLower = query.toLowerCase();

	// Find concepts matching the query
	const concepts = await db.concept.findMany({
		where: {
			sessionId,
			OR: [
				{ name: { contains: query } },
				{ description: { contains: query } },
				{ aliases: { contains: query } },
			],
		},
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

	// Collect chunk IDs and file IDs from relationships
	const chunkIds = new Set<string>();
	const fileIds = new Set<string>();
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
		} else if (entityType === "file") {
			fileIds.add(entityId);
		}
	}

	// For file-level relationships, get their chunks
	if (fileIds.size > 0) {
		const fileChunks = await db.chunk.findMany({
			where: { fileId: { in: Array.from(fileIds) } },
			select: { id: true, fileId: true },
		});
		for (const fc of fileChunks) {
			chunkIds.add(fc.id);
			// Find which concepts linked to this file
			const fileRels = relationships.filter(
				(r) =>
					(r.sourceType === "file" && r.sourceId === fc.fileId) ||
					(r.targetType === "file" && r.targetId === fc.fileId),
			);
			for (const rel of fileRels) {
				const conceptId = rel.sourceType === "concept" ? rel.sourceId : rel.targetId;
				const existing = chunkConceptMap.get(fc.id) || [];
				existing.push({
					name: conceptNames.get(conceptId) || "",
					relationship: rel.relationship,
				});
				chunkConceptMap.set(fc.id, existing);
			}
		}
	}

	if (chunkIds.size === 0) {
		log.info(`searchGraph — concepts matched but no connected chunks`);
		return [];
	}

	// Fetch chunks with file metadata
	const chunks = await db.chunk.findMany({
		where: { id: { in: Array.from(chunkIds) } },
		include: {
			file: { select: { id: true, filename: true, type: true } },
		},
		take: limit,
	});

	log.info(`searchGraph — returning ${chunks.length} results from graph`);

	return chunks.map((chunk) => ({
		chunkId: chunk.id,
		fileId: chunk.file.id,
		fileName: chunk.file.filename,
		fileType: chunk.file.type,
		title: chunk.title,
		content: chunk.content,
		source: "graph" as const,
		relatedConcepts: chunkConceptMap.get(chunk.id) || [],
	}));
}
