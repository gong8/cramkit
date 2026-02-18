import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";
import { CancellationError } from "./errors.js";

const log = createLogger("api");

export interface CleanupStats {
	duplicateRelationshipsRemoved: number;
	orphanedConceptsRemoved: number;
	integrityIssuesFixed: number;
}

async function deduplicateSessionRelationships(
	tx: Prisma.TransactionClient,
	sessionId: string,
): Promise<number> {
	const relationships = await tx.relationship.findMany({
		where: { sessionId },
		select: {
			id: true,
			sourceType: true,
			sourceId: true,
			targetType: true,
			targetId: true,
			relationship: true,
			confidence: true,
			createdAt: true,
		},
		orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
	});

	const SYMMETRIC_TYPES = new Set(["related_to", "contradicts"]);

	const groups = new Map<string, typeof relationships>();
	for (const rel of relationships) {
		let key: string;
		if (SYMMETRIC_TYPES.has(rel.relationship)) {
			const [first, second] = [rel.sourceId, rel.targetId].sort();
			key = `${rel.sourceType}:${first}:${rel.targetType}:${second}:${rel.relationship}`;
		} else {
			key = `${rel.sourceType}:${rel.sourceId}:${rel.targetType}:${rel.targetId}:${rel.relationship}`;
		}
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)?.push(rel);
	}

	const idsToDelete: string[] = [];
	for (const group of groups.values()) {
		if (group.length <= 1) continue;
		// Keep first (highest confidence, earliest createdAt), delete rest
		for (let i = 1; i < group.length; i++) {
			idsToDelete.push(group[i].id);
		}
	}

	if (idsToDelete.length > 0) {
		await tx.relationship.deleteMany({
			where: { id: { in: idsToDelete } },
		});
	}

	return idsToDelete.length;
}

async function removeOrphanedConcepts(
	tx: Prisma.TransactionClient,
	sessionId: string,
): Promise<number> {
	const concepts = await tx.concept.findMany({
		where: { sessionId },
		select: { id: true },
	});

	if (concepts.length === 0) return 0;

	const conceptIds = new Set(concepts.map((c) => c.id));

	const referencedAsSource = await tx.relationship.findMany({
		where: { sessionId, sourceType: "concept", sourceId: { in: [...conceptIds] } },
		select: { sourceId: true },
	});
	const referencedAsTarget = await tx.relationship.findMany({
		where: { sessionId, targetType: "concept", targetId: { in: [...conceptIds] } },
		select: { targetId: true },
	});

	const referencedIds = new Set([
		...referencedAsSource.map((r) => r.sourceId),
		...referencedAsTarget.map((r) => r.targetId),
	]);

	const orphanIds = [...conceptIds].filter((id) => !referencedIds.has(id));

	if (orphanIds.length > 0) {
		await tx.concept.deleteMany({
			where: { id: { in: orphanIds } },
		});
	}

	return orphanIds.length;
}

async function validateReferentialIntegrity(
	tx: Prisma.TransactionClient,
	sessionId: string,
): Promise<number> {
	const conceptRels = await tx.relationship.findMany({
		where: {
			sessionId,
			OR: [{ sourceType: "concept" }, { targetType: "concept" }],
		},
		select: { id: true, sourceType: true, sourceId: true, targetType: true, targetId: true },
	});

	if (conceptRels.length === 0) return 0;

	// Collect all concept IDs referenced in relationships
	const referencedConceptIds = new Set<string>();
	for (const rel of conceptRels) {
		if (rel.sourceType === "concept") referencedConceptIds.add(rel.sourceId);
		if (rel.targetType === "concept") referencedConceptIds.add(rel.targetId);
	}

	// Check which concept IDs actually exist
	const existingConcepts = await tx.concept.findMany({
		where: { id: { in: [...referencedConceptIds] } },
		select: { id: true },
	});
	const existingIds = new Set(existingConcepts.map((c) => c.id));

	// Find relationships pointing to non-existent concepts
	const danglingIds = conceptRels
		.filter((rel) => {
			if (rel.sourceType === "concept" && !existingIds.has(rel.sourceId)) return true;
			if (rel.targetType === "concept" && !existingIds.has(rel.targetId)) return true;
			return false;
		})
		.map((rel) => rel.id);

	if (danglingIds.length > 0) {
		await tx.relationship.deleteMany({
			where: { id: { in: danglingIds } },
		});
	}

	return danglingIds.length;
}

export async function runProgrammaticCleanup(
	sessionId: string,
	signal?: AbortSignal,
): Promise<CleanupStats> {
	const db = getDb();

	const stats = await db.$transaction(
		async (tx) => {
			const duplicateRelationshipsRemoved = await deduplicateSessionRelationships(tx, sessionId);

			if (signal?.aborted) throw new CancellationError("programmatic cleanup cancelled");

			const orphanedConceptsRemoved = await removeOrphanedConcepts(tx, sessionId);

			if (signal?.aborted) throw new CancellationError("programmatic cleanup cancelled");

			const integrityIssuesFixed = await validateReferentialIntegrity(tx, sessionId);

			return { duplicateRelationshipsRemoved, orphanedConceptsRemoved, integrityIssuesFixed };
		},
		{ timeout: 30000 },
	);

	const total =
		stats.duplicateRelationshipsRemoved +
		stats.orphanedConceptsRemoved +
		stats.integrityIssuesFixed;

	if (total > 0) {
		log.info(
			`runProgrammaticCleanup — session ${sessionId}: removed ${stats.duplicateRelationshipsRemoved} duplicate rels, ${stats.orphanedConceptsRemoved} orphaned concepts, ${stats.integrityIssuesFixed} integrity issues`,
		);
	} else {
		log.info(`runProgrammaticCleanup — session ${sessionId}: graph is clean, nothing to fix`);
	}

	return stats;
}

// Re-export for use after merge operations
export { deduplicateSessionRelationships };
