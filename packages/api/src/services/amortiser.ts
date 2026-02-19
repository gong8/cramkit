import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";

const log = createLogger("api");

const MAX_NEW_RELATIONSHIPS = 10;
const MIN_CONCEPT_NAME_LENGTH = 3;

interface SearchResult {
	chunkId: string;
	resourceId: string;
}

async function persistAmortisedRelationships(
	sessionId: string,
	toCreate: Prisma.RelationshipCreateManyInput[],
	startTime: number,
	logDetails: Record<string, unknown>,
	label: string,
): Promise<void> {
	if (toCreate.length === 0) return;

	const db = getDb();
	await db.relationship.createMany({ data: toCreate });
	log.info(`${label} — created ${toCreate.length} new relationships`);

	try {
		await db.graphLog.create({
			data: {
				sessionId,
				source: "amortiser",
				action: "amortise",
				relationshipsCreated: toCreate.length,
				durationMs: Date.now() - startTime,
				details: JSON.stringify(logDetails),
			},
		});
	} catch (e) {
		log.warn(`${label} — failed to write GraphLog`, e);
	}
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

		const queryLower = query.toLowerCase().trim();
		const allConcepts = await db.concept.findMany({
			where: { sessionId },
			select: { id: true, name: true },
		});
		const matchingConcepts = allConcepts.filter((c) => {
			const text = c.name.toLowerCase();
			return terms.every((t) => text.includes(t));
		});

		if (matchingConcepts.length === 0) return;

		// Pre-compute exact name matches for confidence scoring:
		// exact match (query === concept name) is a stronger signal than partial/substring
		const exactMatchIds = new Set(
			matchingConcepts.filter((c) => c.name.toLowerCase() === queryLower).map((c) => c.id),
		);

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

				// Exact concept name match gets higher confidence (0.7) than partial (0.6)
				const confidence = exactMatchIds.has(concept.id) ? 0.7 : 0.6;

				toCreate.push({
					sessionId,
					sourceType: "chunk",
					sourceId: result.chunkId,
					sourceLabel: chunkTitleMap.get(result.chunkId) ?? null,
					targetType: "concept",
					targetId: concept.id,
					targetLabel: concept.name,
					relationship: "related_to",
					confidence,
					createdBy: "amortised",
				});
			}
		}

		await persistAmortisedRelationships(
			sessionId,
			toCreate,
			amortiseStart,
			{ query },
			"amortiseSearchResults",
		);
	} catch (error) {
		log.error("amortiseSearchResults — failed", error);
	}
}

/** Parse aliases string into cleaned, validated alias list */
function parseAliases(aliases: string | null): string[] {
	if (!aliases) return [];
	return aliases
		.split(",")
		.map((a) => a.trim())
		.filter((a) => a.length >= MIN_CONCEPT_NAME_LENGTH);
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
			const validAliases = parseAliases(c.aliases);
			return validAliases.some((a) => text.includes(a.toLowerCase()));
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
			const titleLower = (labelMap.get(entity.id) ?? "").toLowerCase();

			for (const concept of matchingConcepts) {
				if (toCreate.length >= MAX_NEW_RELATIONSHIPS) break;
				if (existingSet.has(`${entity.id}:${concept.id}`)) continue;

				// Determine confidence based on where the concept name appears:
				// - Both title and content: 0.7 (strongest signal for read amortisation)
				// - Title only: 0.65 (title mention is a strong signal)
				// - Content only: 0.5 (baseline for read amortisation)
				const nameLower = concept.name.toLowerCase();
				const inTitle = titleLower.length > 0 && titleLower.includes(nameLower);
				const inContent = text.includes(nameLower);
				let confidence = 0.5;
				if (inTitle && inContent) {
					confidence = 0.7;
				} else if (inTitle) {
					confidence = 0.65;
				}

				toCreate.push({
					sessionId,
					sourceType: "chunk",
					sourceId: entity.id,
					sourceLabel: labelMap.get(entity.id) ?? null,
					targetType: "concept",
					targetId: concept.id,
					targetLabel: concept.name,
					relationship: "related_to",
					confidence,
					createdBy: "amortised",
				});
			}
		}

		await persistAmortisedRelationships(
			sessionId,
			toCreate,
			amortiseStart,
			{ matchText: matchText.slice(0, 200) },
			"amortiseRead",
		);
	} catch (error) {
		log.error("amortiseRead — failed", error);
	}
}
