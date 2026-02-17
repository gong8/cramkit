import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";

const log = createLogger("api");

const MAX_NEW_RELATIONSHIPS = 10;

interface SearchResult {
	chunkId: string;
	resourceId: string;
}

export async function amortiseSearchResults(
	sessionId: string,
	query: string,
	contentResults: SearchResult[],
): Promise<void> {
	try {
		const db = getDb();

		if (contentResults.length === 0) return;

		// Token-based concept matching (consistent with graph-search)
		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 1);
		const allConcepts = await db.concept.findMany({
			where: { sessionId },
			select: { id: true, name: true },
		});
		const matchingConcepts = allConcepts.filter((c) => {
			const text = c.name.toLowerCase();
			return terms.length > 0 && terms.every((t) => text.includes(t));
		});

		if (matchingConcepts.length === 0) return;

		const chunkIds = contentResults.map((r) => r.chunkId);
		const conceptIds = matchingConcepts.map((c) => c.id);

		// Batch fetch: existing relationships + chunk titles
		const [existing, chunks] = await Promise.all([
			db.relationship.findMany({
				where: {
					sessionId,
					sourceType: "chunk",
					sourceId: { in: chunkIds },
					targetType: "concept",
					targetId: { in: conceptIds },
				},
				select: { sourceId: true, targetId: true },
			}),
			db.chunk.findMany({
				where: { id: { in: chunkIds } },
				select: { id: true, title: true },
			}),
		]);

		const existingSet = new Set(existing.map((r) => `${r.sourceId}:${r.targetId}`));
		const chunkTitleMap = new Map(chunks.map((c) => [c.id, c.title]));

		const toCreate: Prisma.RelationshipCreateManyInput[] = [];

		for (const result of contentResults) {
			if (toCreate.length >= MAX_NEW_RELATIONSHIPS) break;
			for (const concept of matchingConcepts) {
				if (toCreate.length >= MAX_NEW_RELATIONSHIPS) break;
				if (existingSet.has(`${result.chunkId}:${concept.id}`)) continue;

				toCreate.push({
					sessionId,
					sourceType: "chunk",
					sourceId: result.chunkId,
					sourceLabel: chunkTitleMap.get(result.chunkId) || null,
					targetType: "concept",
					targetId: concept.id,
					targetLabel: concept.name,
					relationship: "related_to",
					confidence: 0.6,
					createdBy: "amortised",
				});
			}
		}

		if (toCreate.length > 0) {
			await db.relationship.createMany({ data: toCreate });
			log.info(
				`amortiseSearchResults — created ${toCreate.length} new relationships` +
					` for query "${query}"`,
			);
		}
	} catch (error) {
		log.error("amortiseSearchResults — failed", error);
	}
}
