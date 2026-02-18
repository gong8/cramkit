import { createLogger, getDb } from "@cramkit/shared";
import { CancellationError } from "./errors.js";
import { fuzzyMatchTitle, toTitleCase } from "./graph-indexer-utils.js";
import type { MetadataAgentInput, MetadataExtractionResult } from "./metadata-agent.js";
import { runMetadataAgent } from "./metadata-agent.js";
import { readProcessedFile } from "./storage.js";

const log = createLogger("api");

export class MetadataIndexError extends Error {
	constructor(
		message: string,
		public readonly errorType: "llm_error" | "parse_error" | "db_error" | "unknown",
		public readonly resourceId: string,
	) {
		super(message);
		this.name = "MetadataIndexError";
	}
}

const MAX_LLM_ATTEMPTS = 3;

async function extractWithRetries(
	input: MetadataAgentInput,
	resourceId: string,
	signal?: AbortSignal,
): Promise<MetadataExtractionResult> {
	for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new CancellationError("Metadata extraction cancelled");
		try {
			return await runMetadataAgent(input, signal);
		} catch (error) {
			if (error instanceof CancellationError) throw error;
			log.error(
				`indexResourceMetadata — extraction failed for "${input.resource.name}" (attempt ${attempt}/${MAX_LLM_ATTEMPTS})`,
				error,
			);
			if (attempt === MAX_LLM_ATTEMPTS) {
				throw new MetadataIndexError(
					`Giving up on "${input.resource.name}" after ${MAX_LLM_ATTEMPTS} attempts`,
					"llm_error",
					resourceId,
				);
			}
			log.info(
				`indexResourceMetadata — retrying "${input.resource.name}" (attempt ${attempt + 1}/${MAX_LLM_ATTEMPTS})...`,
			);
		}
	}
	throw new MetadataIndexError("Unreachable", "unknown", resourceId);
}

async function readFileContent(file: {
	processedPath: string | null;
	filename: string;
}): Promise<string> {
	if (file.processedPath) {
		try {
			return await readProcessedFile(file.processedPath);
		} catch {
			return "";
		}
	}
	return "";
}

export async function indexResourceMetadata(
	resourceId: string,
	signal?: AbortSignal,
): Promise<void> {
	const db = getDb();

	const resource = await db.resource.findUnique({
		where: { id: resourceId },
		include: {
			files: {
				select: {
					id: true,
					filename: true,
					role: true,
					processedPath: true,
				},
			},
			chunks: {
				select: {
					id: true,
					title: true,
					content: true,
					depth: true,
					nodeType: true,
					parentId: true,
				},
				orderBy: { index: "asc" },
			},
		},
	});

	if (!resource) {
		throw new MetadataIndexError("Resource not found", "unknown", resourceId);
	}

	if (!resource.isGraphIndexed) {
		throw new MetadataIndexError("Not graph-indexed yet", "unknown", resourceId);
	}

	log.info(`indexResourceMetadata — starting "${resource.name}" (${resourceId})`);

	const startTime = Date.now();

	// Read file content by role
	const filesWithContent = await Promise.all(
		resource.files.map(async (f) => ({
			filename: f.filename,
			role: f.role,
			content: await readFileContent(f),
		})),
	);

	// Fetch existing concepts
	const existingConcepts = await db.concept.findMany({
		where: { sessionId: resource.sessionId },
		select: { id: true, name: true, description: true },
	});

	const agentInput: MetadataAgentInput = {
		resource: { name: resource.name, type: resource.type, label: resource.label },
		files: filesWithContent,
		chunks: resource.chunks,
		existingConcepts,
	};

	const result = await extractWithRetries(agentInput, resourceId, signal);

	if (signal?.aborted) throw new CancellationError("Cancelled before DB write");

	await writeResultToDb(db, result, resource, startTime);

	const qCount = result.questions?.length ?? 0;
	const cuCount = result.conceptUpdates?.length ?? 0;

	try {
		await db.graphLog.create({
			data: {
				sessionId: resource.sessionId,
				source: "metadata-indexer",
				action: "metadata-extract",
				resourceId,
				conceptsUpdated: cuCount,
				durationMs: Date.now() - startTime,
				details: JSON.stringify({ questions: qCount, conceptUpdates: cuCount }),
			},
		});
	} catch (e) {
		log.warn("indexResourceMetadata — failed to write GraphLog", e);
	}

	log.info(
		`indexResourceMetadata — completed "${resource.name}": ${qCount} questions, ${cuCount} concept updates`,
	);
}

async function writeResultToDb(
	db: ReturnType<typeof getDb>,
	result: MetadataExtractionResult,
	resource: {
		id: string;
		sessionId: string;
		name: string;
		chunks: Array<{ id: string; title: string | null }>;
	},
	startTime: number,
): Promise<void> {
	try {
		await db.$transaction(
			async (tx) => {
				// Idempotent: delete existing PaperQuestion records and question relationships
				await tx.paperQuestion.deleteMany({
					where: { resourceId: resource.id },
				});
				await tx.relationship.deleteMany({
					where: {
						sessionId: resource.sessionId,
						sourceType: "question",
						createdFromResourceId: resource.id,
					},
				});

				// Build chunk title map for fuzzy matching
				const chunkByTitle = new Map<string, string>();
				for (const chunk of resource.chunks) {
					if (chunk.title) {
						chunkByTitle.set(chunk.title.toLowerCase(), chunk.id);
					}
				}

				// Load concept map
				const allConcepts = await tx.concept.findMany({
					where: { sessionId: resource.sessionId },
					select: { id: true, name: true },
				});
				const conceptMap = new Map(allConcepts.map((c) => [c.name, c.id]));

				// Write PaperQuestion records
				if (result.questions && result.questions.length > 0) {
					for (const q of result.questions) {
						const chunkId = q.chunkTitle ? fuzzyMatchTitle(q.chunkTitle, chunkByTitle) : null;

						const pq = await tx.paperQuestion.create({
							data: {
								resourceId: resource.id,
								sessionId: resource.sessionId,
								chunkId,
								questionNumber: q.questionNumber,
								parentNumber: q.parentNumber ?? null,
								marks: q.marks ?? null,
								questionType: q.questionType ?? null,
								commandWords: q.commandWords ?? null,
								content: q.content,
								markSchemeText: q.markSchemeText ?? null,
								solutionText: q.solutionText ?? null,
								metadata: q.metadata ? JSON.stringify(q.metadata) : null,
							},
						});

						// Create question→concept relationships
						if (q.conceptLinks) {
							for (const link of q.conceptLinks) {
								const conceptName = toTitleCase(link.conceptName);
								const conceptId = conceptMap.get(conceptName);
								if (!conceptId) continue;

								await tx.relationship.create({
									data: {
										sessionId: resource.sessionId,
										sourceType: "question",
										sourceId: pq.id,
										sourceLabel: q.questionNumber,
										targetType: "concept",
										targetId: conceptId,
										targetLabel: conceptName,
										relationship: link.relationship,
										confidence: link.confidence ?? 0.8,
										createdBy: "system",
										createdFromResourceId: resource.id,
									},
								});
							}
						}
					}
				}

				// Update concept content
				if (result.conceptUpdates && result.conceptUpdates.length > 0) {
					for (const cu of result.conceptUpdates) {
						const conceptName = toTitleCase(cu.name);
						const existing = await tx.concept.findUnique({
							where: {
								sessionId_name: {
									sessionId: resource.sessionId,
									name: conceptName,
								},
							},
							select: { id: true, content: true },
						});
						if (!existing) continue;

						// Don't overwrite content if already set (higher-priority resource may have set it)
						const updateData: Record<string, unknown> = {};
						if (cu.content && !existing.content) {
							updateData.content = cu.content;
						}
						if (cu.contentType) {
							updateData.contentType = cu.contentType;
						}
						if (cu.metadata) {
							updateData.metadata = JSON.stringify(cu.metadata);
						}

						if (Object.keys(updateData).length > 0) {
							await tx.concept.update({
								where: { id: existing.id },
								data: updateData,
							});
						}
					}
				}

				// Update resource metadata
				const resourceUpdate: Record<string, unknown> = {
					isMetaIndexed: true,
					metaIndexDurationMs: Date.now() - startTime,
				};
				if (result.resourceMetadata) {
					resourceUpdate.metadata = JSON.stringify(result.resourceMetadata);
				}
				await tx.resource.update({
					where: { id: resource.id },
					data: resourceUpdate,
				});

				// Update chunk metadata
				if (result.chunkMetadata && result.chunkMetadata.length > 0) {
					for (const cm of result.chunkMetadata) {
						const chunkId = fuzzyMatchTitle(cm.chunkTitle, chunkByTitle);
						if (!chunkId) continue;

						await tx.chunk.update({
							where: { id: chunkId },
							data: { metadata: JSON.stringify(cm.metadata) },
						});
					}
				}
			},
			{ timeout: 30000 },
		);
	} catch (error) {
		if (error instanceof MetadataIndexError) throw error;
		throw new MetadataIndexError(
			error instanceof Error ? error.message : String(error),
			"db_error",
			resource.id,
		);
	}
}
