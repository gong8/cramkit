import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";
import type { ExtractionAgentInput, ExtractionResult } from "./extraction-agent.js";
import { runExtractionAgent } from "./extraction-agent.js";
import { findChunkByLabel, fuzzyMatchTitle, toTitleCase } from "./graph-indexer-utils.js";

const log = createLogger("api");

export type Thoroughness = "quick" | "standard" | "thorough";

export class GraphIndexError extends Error {
	constructor(
		message: string,
		public readonly errorType: "llm_error" | "parse_error" | "db_error" | "unknown",
		public readonly resourceId: string,
	) {
		super(message);
		this.name = "GraphIndexError";
	}
}

interface ChunkInfo {
	id: string;
	title: string | null;
	content: string;
	depth: number;
	nodeType: string;
	parentId: string | null;
	diskPath: string | null;
}

const MAX_LLM_ATTEMPTS = 3;

async function extractWithRetries(
	input: ExtractionAgentInput,
	resourceId: string,
): Promise<ExtractionResult> {
	for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
		try {
			return await runExtractionAgent(input);
		} catch (error) {
			log.error(
				`indexResourceGraph — extraction failed for "${input.resource.name}" (attempt ${attempt}/${MAX_LLM_ATTEMPTS})`,
				error,
			);
			if (attempt === MAX_LLM_ATTEMPTS) {
				throw new GraphIndexError(
					`Giving up on "${input.resource.name}" after ${MAX_LLM_ATTEMPTS} attempts`,
					"llm_error",
					resourceId,
				);
			}
			log.info(
				`indexResourceGraph — retrying "${input.resource.name}" (attempt ${attempt + 1}/${MAX_LLM_ATTEMPTS})...`,
			);
		}
	}
	throw new GraphIndexError("Unreachable", "unknown", resourceId);
}

type RelData = Prisma.RelationshipCreateManyInput;

function makeRel(
	sessionId: string,
	sourceType: string,
	sourceId: string,
	sourceLabel: string,
	targetId: string,
	targetLabel: string,
	relationship: string,
	confidence: number,
): RelData {
	return {
		sessionId,
		sourceType,
		sourceId,
		sourceLabel,
		targetType: "concept",
		targetId,
		targetLabel,
		relationship,
		confidence,
		createdBy: "system",
	};
}

function resolveConcept(
	name: string,
	conceptMap: Map<string, string>,
): { id: string; name: string } | null {
	const titleCased = toTitleCase(name);
	const id = conceptMap.get(titleCased);
	return id ? { id, name: titleCased } : null;
}

function buildRelationshipData(
	result: ExtractionResult,
	conceptMap: Map<string, string>,
	chunkByTitle: Map<string, string>,
	chunks: ChunkInfo[],
	sessionId: string,
	resourceId: string,
	resourceName: string,
): RelData[] {
	const relationships: RelData[] = [];

	for (const link of result.file_concept_links) {
		const target = resolveConcept(link.conceptName, conceptMap);
		if (!target) continue;

		let sourceType = "resource";
		let sourceId = resourceId;
		let sourceLabel = resourceName;

		if (link.chunkTitle) {
			const chunkId = fuzzyMatchTitle(link.chunkTitle, chunkByTitle);
			if (chunkId) {
				sourceType = "chunk";
				sourceId = chunkId;
				sourceLabel = link.chunkTitle;
			}
		}

		relationships.push(
			makeRel(
				sessionId,
				sourceType,
				sourceId,
				sourceLabel,
				target.id,
				target.name,
				link.relationship,
				link.confidence ?? 0.8,
			),
		);
	}

	for (const link of result.concept_concept_links) {
		const source = resolveConcept(link.sourceConcept, conceptMap);
		const target = resolveConcept(link.targetConcept, conceptMap);
		if (!source || !target) continue;

		relationships.push(
			makeRel(
				sessionId,
				"concept",
				source.id,
				source.name,
				target.id,
				target.name,
				link.relationship,
				link.confidence ?? 0.7,
			),
		);
	}

	for (const link of result.question_concept_links) {
		const target = resolveConcept(link.conceptName, conceptMap);
		if (!target) continue;

		const matchingChunk = findChunkByLabel(chunks, link.questionLabel);
		relationships.push(
			makeRel(
				sessionId,
				matchingChunk ? "chunk" : "resource",
				matchingChunk?.id || resourceId,
				link.questionLabel,
				target.id,
				target.name,
				link.relationship,
				link.confidence ?? 0.8,
			),
		);
	}

	return relationships;
}

function deduplicateRelationships(relationships: RelData[]): RelData[] {
	const seen = new Set<string>();
	return relationships.filter((r) => {
		const key = `${r.sourceType}:${r.sourceId}:${r.targetType}:${r.targetId}:${r.relationship}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function clearOldRelationships(
	tx: Prisma.TransactionClient,
	sessionId: string,
	resourceId: string,
	chunks: ChunkInfo[],
): Promise<void> {
	const sourceIds = [resourceId, ...chunks.map((c) => c.id)];
	await tx.relationship.deleteMany({
		where: {
			sessionId,
			createdBy: "system",
			OR: [{ sourceId: { in: sourceIds } }, { sourceType: "resource", sourceId: resourceId }],
		},
	});
}

async function upsertConcepts(
	tx: Prisma.TransactionClient,
	sessionId: string,
	concepts: ExtractionResult["concepts"],
): Promise<void> {
	for (const concept of concepts) {
		const name = toTitleCase(concept.name);
		await tx.concept.upsert({
			where: { sessionId_name: { sessionId, name } },
			update: {
				description: concept.description || undefined,
				aliases: concept.aliases || undefined,
			},
			create: {
				sessionId,
				name,
				description: concept.description || null,
				aliases: concept.aliases || null,
				createdBy: "system",
			},
		});
	}
}

async function loadConceptMap(
	tx: Prisma.TransactionClient,
	sessionId: string,
): Promise<Map<string, string>> {
	const allConcepts = await tx.concept.findMany({
		where: { sessionId },
		select: { id: true, name: true },
	});
	return new Map(allConcepts.map((c) => [c.name, c.id]));
}

function buildChunkTitleMap(chunks: ChunkInfo[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const chunk of chunks) {
		if (chunk.title) {
			map.set(chunk.title.toLowerCase(), chunk.id);
		}
	}
	return map;
}

async function writeResultToDb(
	db: ReturnType<typeof getDb>,
	result: ExtractionResult,
	resource: { id: string; sessionId: string; name: string },
	chunks: ChunkInfo[],
	startTime: number,
): Promise<void> {
	try {
		await db.$transaction(
			async (tx) => {
				await clearOldRelationships(tx, resource.sessionId, resource.id, chunks);
				await upsertConcepts(tx, resource.sessionId, result.concepts);

				const conceptMap = await loadConceptMap(tx, resource.sessionId);
				const chunkByTitle = buildChunkTitleMap(chunks);

				const relationships = deduplicateRelationships(
					buildRelationshipData(
						result,
						conceptMap,
						chunkByTitle,
						chunks,
						resource.sessionId,
						resource.id,
						resource.name,
					),
				);

				if (relationships.length > 0) {
					await tx.relationship.createMany({ data: relationships });
				}

				await tx.resource.update({
					where: { id: resource.id },
					data: { isGraphIndexed: true, graphIndexDurationMs: Date.now() - startTime },
				});
			},
			{ timeout: 30000 },
		);
	} catch (error) {
		if (error instanceof GraphIndexError) throw error;
		throw new GraphIndexError(
			error instanceof Error ? error.message : String(error),
			"db_error",
			resource.id,
		);
	}
}

export async function indexResourceGraph(
	resourceId: string,
	thoroughness?: Thoroughness,
): Promise<void> {
	const db = getDb();

	const resource = await db.resource.findUnique({
		where: { id: resourceId },
		include: {
			files: {
				select: { id: true, filename: true, role: true },
			},
			chunks: {
				select: {
					id: true,
					content: true,
					title: true,
					depth: true,
					nodeType: true,
					parentId: true,
					diskPath: true,
				},
				orderBy: { index: "asc" },
			},
		},
	});

	if (!resource) {
		throw new GraphIndexError("Resource not found", "unknown", resourceId);
	}

	if (!resource.isIndexed) {
		throw new GraphIndexError("Not content-indexed yet", "unknown", resourceId);
	}

	const mode = thoroughness ?? "standard";
	log.info(
		`indexResourceGraph — starting "${resource.name}" (${resourceId}) [thoroughness=${mode}]`,
	);

	const startTime = Date.now();

	// Fetch existing concepts and their relationships for the agent
	const existingConcepts = await db.concept.findMany({
		where: { sessionId: resource.sessionId },
		select: { name: true, description: true },
	});

	const existingRels = await db.relationship.findMany({
		where: { sessionId: resource.sessionId, createdBy: "system" },
		select: {
			sourceLabel: true,
			targetLabel: true,
			relationship: true,
			confidence: true,
		},
	});

	// Group relationships by concept name
	const relMap = new Map<
		string,
		Array<{
			sourceLabel: string | null;
			targetLabel: string | null;
			relationship: string;
			confidence: number;
		}>
	>();
	for (const rel of existingRels) {
		for (const label of [rel.sourceLabel, rel.targetLabel]) {
			if (label) {
				if (!relMap.has(label)) relMap.set(label, []);
				relMap.get(label)?.push(rel);
			}
		}
	}

	const agentInput: ExtractionAgentInput = {
		resource: { name: resource.name, type: resource.type, label: resource.label },
		files: resource.files,
		chunks: resource.chunks,
		existingConcepts,
		existingRelationships: relMap,
		thoroughness: mode,
	};

	const result = await extractWithRetries(agentInput, resourceId);

	await writeResultToDb(
		db,
		result,
		{ id: resourceId, sessionId: resource.sessionId, name: resource.name },
		resource.chunks,
		startTime,
	);

	const totalRels =
		result.file_concept_links.length +
		result.concept_concept_links.length +
		result.question_concept_links.length;
	log.info(
		`indexResourceGraph — completed "${resource.name}": ${result.concepts.length} concepts, ${totalRels} relationships`,
	);
}
