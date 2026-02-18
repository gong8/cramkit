import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";

const log = createLogger("api");

const MAX_NEW_RELATIONSHIPS = 10;
const MIN_CONCEPT_NAME_LENGTH = 3;

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
		const amortiseStart = Date.now();

		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 1);
		if (contentResults.length === 0 || terms.length === 0) return;

		const allConcepts = await db.concept.findMany({
			where: { sessionId },
			select: { id: true, name: true },
		});
		const matchingConcepts = allConcepts.filter((c) => {
			const text = c.name.toLowerCase();
			return terms.every((t) => text.includes(t));
		});

		if (matchingConcepts.length === 0) return;

		const chunkIds = contentResults.map((r) => r.chunkId);
		const conceptIds = matchingConcepts.map((c) => c.id);

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
					sourceLabel: chunkTitleMap.get(result.chunkId) ?? null,
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

			try {
				await db.graphLog.create({
					data: {
						sessionId,
						source: "amortiser",
						action: "amortise",
						relationshipsCreated: toCreate.length,
						durationMs: Date.now() - amortiseStart,
						details: JSON.stringify({ query }),
					},
				});
			} catch (e) {
				log.warn("amortiseSearchResults — failed to write GraphLog", e);
			}
		}
	} catch (error) {
		log.error("amortiseSearchResults — failed", error);
	}
}

export async function amortiseRead(
	sessionId: string,
	entities: Array<{ type: "chunk" | "resource"; id: string; label: string | null }>,
	matchText: string,
): Promise<void> {
	try {
		if (entities.length === 0 || matchText.length === 0) return;

		const db = getDb();
		const amortiseStart = Date.now();
		const text = matchText.toLowerCase();

		const allConcepts = await db.concept.findMany({
			where: { sessionId },
			select: { id: true, name: true, aliases: true },
		});

		const matchingConcepts = allConcepts.filter((c) => {
			if (c.name.length < MIN_CONCEPT_NAME_LENGTH) return false;
			if (text.includes(c.name.toLowerCase())) return true;
			if (c.aliases) {
				return c.aliases
					.split(",")
					.some(
						(a) =>
							a.trim().length >= MIN_CONCEPT_NAME_LENGTH && text.includes(a.trim().toLowerCase()),
					);
			}
			return false;
		});

		if (matchingConcepts.length === 0) return;

		const chunkEntities = entities.filter((e) => e.type === "chunk");
		if (chunkEntities.length === 0) return;

		const chunkIds = chunkEntities.map((e) => e.id);
		const conceptIds = matchingConcepts.map((c) => c.id);

		const existing = await db.relationship.findMany({
			where: {
				sessionId,
				sourceType: "chunk",
				sourceId: { in: chunkIds },
				targetType: "concept",
				targetId: { in: conceptIds },
			},
			select: { sourceId: true, targetId: true },
		});

		const existingSet = new Set(existing.map((r) => `${r.sourceId}:${r.targetId}`));
		const labelMap = new Map(chunkEntities.map((e) => [e.id, e.label]));

		const toCreate: Prisma.RelationshipCreateManyInput[] = [];

		for (const entity of chunkEntities) {
			if (toCreate.length >= MAX_NEW_RELATIONSHIPS) break;
			for (const concept of matchingConcepts) {
				if (toCreate.length >= MAX_NEW_RELATIONSHIPS) break;
				if (existingSet.has(`${entity.id}:${concept.id}`)) continue;

				toCreate.push({
					sessionId,
					sourceType: "chunk",
					sourceId: entity.id,
					sourceLabel: labelMap.get(entity.id) ?? null,
					targetType: "concept",
					targetId: concept.id,
					targetLabel: concept.name,
					relationship: "related_to",
					confidence: 0.5,
					createdBy: "amortised",
				});
			}
		}

		if (toCreate.length > 0) {
			await db.relationship.createMany({ data: toCreate });
			log.info(`amortiseRead — created ${toCreate.length} new relationships`);

			try {
				await db.graphLog.create({
					data: {
						sessionId,
						source: "amortiser",
						action: "amortise",
						relationshipsCreated: toCreate.length,
						durationMs: Date.now() - amortiseStart,
						details: JSON.stringify({
							matchText: matchText.slice(0, 200),
						}),
					},
				});
			} catch (e) {
				log.warn("amortiseRead — failed to write GraphLog", e);
			}
		}
	} catch (error) {
		log.error("amortiseRead — failed", error);
	}
}
