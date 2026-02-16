import { createLogger, getDb } from "@cramkit/shared";

const log = createLogger("api");

const MAX_NEW_RELATIONSHIPS = 10;

interface SearchResult {
	chunkId: string;
	fileId: string;
}

export async function amortiseSearchResults(
	sessionId: string,
	query: string,
	contentResults: SearchResult[],
): Promise<void> {
	try {
		const db = getDb();

		// Find concepts matching the search query
		const matchingConcepts = await db.concept.findMany({
			where: {
				sessionId,
				OR: [
					{ name: { contains: query } },
					{ description: { contains: query } },
					{ aliases: { contains: query } },
				],
			},
			select: { id: true, name: true },
		});

		if (matchingConcepts.length === 0 || contentResults.length === 0) {
			return;
		}

		let created = 0;

		for (const result of contentResults) {
			if (created >= MAX_NEW_RELATIONSHIPS) break;

			for (const concept of matchingConcepts) {
				if (created >= MAX_NEW_RELATIONSHIPS) break;

				// Check if relationship already exists
				const existing = await db.relationship.findFirst({
					where: {
						sessionId,
						sourceType: "chunk",
						sourceId: result.chunkId,
						targetType: "concept",
						targetId: concept.id,
					},
				});

				if (existing) continue;

				await db.relationship.create({
					data: {
						sessionId,
						sourceType: "chunk",
						sourceId: result.chunkId,
						targetType: "concept",
						targetId: concept.id,
						targetLabel: concept.name,
						relationship: "related_to",
						confidence: 0.6,
						createdBy: "amortised",
					},
				});

				created++;
			}
		}

		if (created > 0) {
			log.info(`amortiseSearchResults — created ${created} new relationships for query "${query}"`);
		}
	} catch (error) {
		log.error("amortiseSearchResults — failed", error);
	}
}
