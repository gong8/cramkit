import { createLogger, getDb } from "@cramkit/shared";
import PQueue from "p-queue";
import { type EnrichmentResult, runChatEnrichment } from "../services/chat-enricher.js";
import {
	type CleanupAgentStats,
	applyCleanupResult,
	runCleanupAgent,
} from "../services/cleanup-agent.js";
import { runCrossLinkingAgent } from "../services/cross-linker.js";
import { CancellationError, isApiServerError, sleep } from "../services/errors.js";
import { runProgrammaticCleanup } from "../services/graph-cleanup.js";
import { toTitleCase } from "../services/graph-indexer-utils.js";
import {
	GraphIndexError,
	type Thoroughness,
	indexResourceGraph,
} from "../services/graph-indexer.js";
import { indexResourceMetadata } from "../services/metadata-indexer.js";
import { processResource } from "../services/resource-processor.js";
import { IndexerLogger } from "./indexer-logger.js";

const log = createLogger("api");
const queue = new PQueue({ concurrency: 1 });
const indexingQueue = new PQueue({ concurrency: 1 });

// In-memory abort controllers for active batches (allows cancellation to kill running processes)
const batchAbortControllers = new Map<string, AbortController>();

// In-memory cross-linking status tracking (not persisted — only relevant during active batches)
const crossLinkStatus = new Map<
	string,
	{
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		error?: string;
		linksAdded?: number;
	}
>();

// In-memory metadata extraction status tracking
const metadataStatus = new Map<
	string,
	{
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		total?: number;
		completed?: number;
		failed?: number;
		error?: string;
	}
>();

// In-memory cleanup status tracking
const cleanupStatus = new Map<
	string,
	{
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		error?: string;
		stats?: {
			duplicatesRemoved: number;
			orphansRemoved: number;
			integrityFixes: number;
			conceptsMerged: number;
		};
	}
>();

async function persistPhaseStatus(
	batchId: string,
	field: "phase3Status" | "phase4Status" | "phase5Status",
	value: unknown,
): Promise<void> {
	try {
		const db = getDb();
		await db.indexBatch.update({
			where: { id: batchId },
			data: { [field]: JSON.stringify(value) },
		});
	} catch (e) {
		log.warn(`persistPhaseStatus — failed to write ${field} for batch ${batchId}`, e);
	}
}

export function enqueueProcessing(resourceId: string): void {
	queue.add(() => processResource(resourceId));
	log.info(`enqueueProcessing — resource ${resourceId}, queue size: ${queue.size + queue.pending}`);
}

export const getQueueSize = () => queue.size + queue.pending;

const enrichmentQueue = new PQueue({ concurrency: 1 });

export function enqueueEnrichment(
	sessionId: string,
	conversationId: string,
	entities: Array<{ type: string; id: string }>,
): void {
	enrichmentQueue.add(async () => {
		const startTime = Date.now();
		try {
			const result = await runChatEnrichment({
				sessionId,
				conversationId,
				accessedEntities: entities,
			});
			await writeEnrichmentResults(sessionId, conversationId, result, startTime);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			log.error(
				`enqueueEnrichment — session ${sessionId}, conversation ${conversationId} failed: ${msg}`,
			);
		}
	});
	log.info(
		`enqueueEnrichment — session ${sessionId}, conversation ${conversationId}, ${entities.length} entities, queue size: ${enrichmentQueue.size + enrichmentQueue.pending}`,
	);
}

async function writeEnrichmentResults(
	sessionId: string,
	conversationId: string,
	result: EnrichmentResult,
	startTime: number,
): Promise<void> {
	const db = getDb();
	let relationshipsCreated = 0;

	if (result.links.length > 0) {
		const concepts = await db.concept.findMany({
			where: { sessionId },
			select: { id: true, name: true },
		});
		const conceptMap = new Map(concepts.map((c) => [c.name, c.id]));

		const relationships: Array<{
			sessionId: string;
			sourceType: string;
			sourceId: string;
			sourceLabel: string;
			targetType: string;
			targetId: string;
			targetLabel: string;
			relationship: string;
			confidence: number;
			createdBy: string;
		}> = [];

		for (const link of result.links) {
			const sourceName = toTitleCase(link.sourceConcept);
			const targetName = toTitleCase(link.targetConcept);
			const sourceId = conceptMap.get(sourceName);
			const targetId = conceptMap.get(targetName);
			if (!sourceId || !targetId) continue;

			relationships.push({
				sessionId,
				sourceType: "concept",
				sourceId,
				sourceLabel: sourceName,
				targetType: "concept",
				targetId,
				targetLabel: targetName,
				relationship: link.relationship,
				confidence: link.confidence ?? 0.7,
				createdBy: "enricher",
			});
		}

		if (relationships.length > 0) {
			const existing = await db.relationship.findMany({
				where: {
					sessionId,
					sourceType: "concept",
					targetType: "concept",
				},
				select: { sourceId: true, targetId: true, relationship: true },
			});
			const existingKeys = new Set(
				existing.map((r) => `${r.sourceId}:${r.targetId}:${r.relationship}`),
			);

			const newRels = relationships.filter(
				(r) => !existingKeys.has(`${r.sourceId}:${r.targetId}:${r.relationship}`),
			);

			if (newRels.length > 0) {
				await db.relationship.createMany({ data: newRels });
				relationshipsCreated = newRels.length;
				log.info(
					`writeEnrichmentResults — session ${sessionId}: added ${newRels.length} enricher links`,
				);
			}
		}
	}

	await db.graphLog.create({
		data: {
			sessionId,
			source: "enricher",
			action: "enrich",
			conversationId,
			relationshipsCreated,
			durationMs: Date.now() - startTime,
		},
	});
}

export function enqueueGraphIndexing(resourceId: string, thoroughness?: Thoroughness): void {
	indexingQueue.add(() => indexResourceGraph(resourceId, thoroughness));
	log.info(
		`enqueueGraphIndexing — resource ${resourceId}, thoroughness=${thoroughness ?? "standard"}, indexing queue size: ${indexingQueue.size + indexingQueue.pending}`,
	);
}

const PHASE_1_TYPES = new Set(["LECTURE_NOTES", "SPECIFICATION"]);

// Circuit breaker: consecutive API failures per batch
const consecutiveApiFailures = new Map<string, number>();
const CIRCUIT_BREAKER_THRESHOLD = 2;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000;

async function runIndexJob(
	jobId: string,
	signal?: AbortSignal,
	indexerLog?: IndexerLogger,
): Promise<void> {
	const db = getDb();
	const activeLog = indexerLog ?? log;

	const job = await db.indexJob.findUnique({
		where: { id: jobId },
		include: { batch: { select: { status: true } }, resource: { select: { name: true } } },
	});
	if (!job) return;

	if (job.batch.status === "cancelled" || signal?.aborted) {
		await db.indexJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
		return;
	}

	// Circuit breaker: if N consecutive jobs failed with API errors, pause before continuing
	const failCount = consecutiveApiFailures.get(job.batchId) ?? 0;
	if (failCount >= CIRCUIT_BREAKER_THRESHOLD) {
		activeLog.warn(
			`runIndexJob — circuit breaker: ${failCount} consecutive API failures, pausing ${CIRCUIT_BREAKER_PAUSE_MS / 1000}s before next attempt...`,
		);
		try {
			await sleep(CIRCUIT_BREAKER_PAUSE_MS, signal);
		} catch {
			await db.indexJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
			return;
		}
		consecutiveApiFailures.set(job.batchId, 0);
	}

	await db.indexJob.update({
		where: { id: jobId },
		data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
	});

	const resourceName = job.resource?.name ?? job.resourceId;
	activeLog.info(
		`runIndexJob — starting "${resourceName}" (job ${jobId}, attempt ${job.attempts + 1})`,
	);

	try {
		const startTime = Date.now();
		await indexResourceGraph(
			job.resourceId,
			(job.thoroughness as Thoroughness) || undefined,
			signal,
			indexerLog,
		);

		// Re-check cancellation after work completes — don't write to a cancelled batch
		if (signal?.aborted || (await isBatchCancelled(job.batchId))) {
			await db.indexJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
			activeLog.info(`runIndexJob — job ${jobId} cancelled (post-completion)`);
			return;
		}

		const durationMs = Date.now() - startTime;
		await db.indexJob.update({
			where: { id: jobId },
			data: { status: "completed", completedAt: new Date(), durationMs },
		});
		await db.indexBatch.update({
			where: { id: job.batchId },
			data: { completed: { increment: 1 } },
		});
		// Reset circuit breaker on success
		consecutiveApiFailures.delete(job.batchId);
		activeLog.info(
			`runIndexJob — completed "${resourceName}" in ${(durationMs / 1000).toFixed(1)}s`,
		);
	} catch (error) {
		if (error instanceof CancellationError) {
			await db.indexJob.update({
				where: { id: jobId },
				data: { status: "cancelled" },
			});
			activeLog.info(`runIndexJob — job ${jobId} cancelled`);
			return;
		}
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorType = error instanceof GraphIndexError ? error.errorType : ("unknown" as const);
		await db.indexJob.update({
			where: { id: jobId },
			data: { status: "failed", errorMessage, errorType },
		});
		await db.indexBatch.update({
			where: { id: job.batchId },
			data: { failed: { increment: 1 } },
		});
		activeLog.error(
			`runIndexJob — "${resourceName}" failed (type=${errorType}): ${errorMessage}`,
			error,
		);

		// Track consecutive API failures for circuit breaker
		if (isApiServerError(error)) {
			consecutiveApiFailures.set(job.batchId, (consecutiveApiFailures.get(job.batchId) ?? 0) + 1);
		} else {
			consecutiveApiFailures.delete(job.batchId);
		}
	}
}

async function isBatchCancelled(batchId: string): Promise<boolean> {
	const db = getDb();
	const batch = await db.indexBatch.findUnique({ where: { id: batchId } });
	return batch?.status === "cancelled";
}

async function runCrossLinking(
	sessionId: string,
	batchId: string,
	signal?: AbortSignal,
	indexerLog?: IndexerLogger,
): Promise<void> {
	const db = getDb();
	const activeLog = indexerLog ?? log;

	if ((await isBatchCancelled(batchId)) || signal?.aborted) return;

	crossLinkStatus.set(batchId, { status: "running" });
	const crossLinkStart = Date.now();

	try {
		activeLog.info(`runCrossLinking — session ${sessionId}, starting cross-linking pass`);
		const result = await runCrossLinkingAgent(sessionId, signal, indexerLog);

		// Re-check cancellation after agent returns — don't write results to a cancelled batch
		if (signal?.aborted || (await isBatchCancelled(batchId))) {
			const skipped = { status: "skipped" as const };
			crossLinkStatus.set(batchId, skipped);
			await persistPhaseStatus(batchId, "phase3Status", skipped);
			activeLog.info(`runCrossLinking — session ${sessionId} cancelled (post-agent)`);
			return;
		}

		let linksAdded = 0;
		if (result.links.length > 0) {
			const concepts = await db.concept.findMany({
				where: { sessionId },
				select: { id: true, name: true },
			});
			const conceptMap = new Map(concepts.map((c) => [c.name, c.id]));
			const conceptMapLower = new Map<string, string>();
			for (const [name, id] of conceptMap.entries()) {
				conceptMapLower.set(name.toLowerCase(), id);
			}

			const relationships: Array<{
				sessionId: string;
				sourceType: string;
				sourceId: string;
				sourceLabel: string;
				targetType: string;
				targetId: string;
				targetLabel: string;
				relationship: string;
				confidence: number;
				createdBy: string;
				createdFromResourceId: string | null;
			}> = [];

			for (const link of result.links) {
				const sourceName = toTitleCase(link.sourceConcept);
				const targetName = toTitleCase(link.targetConcept);
				const sourceId =
					conceptMap.get(sourceName) ?? conceptMapLower.get(sourceName.toLowerCase());
				const targetId =
					conceptMap.get(targetName) ?? conceptMapLower.get(targetName.toLowerCase());
				if (!sourceId || !targetId) {
					activeLog.warn("cross-link dropped: concept not found", {
						sourceConcept: link.sourceConcept,
						targetConcept: link.targetConcept,
						sourceResolved: !!sourceId,
						targetResolved: !!targetId,
					});
					continue;
				}

				relationships.push({
					sessionId,
					sourceType: "concept",
					sourceId,
					sourceLabel: sourceName,
					targetType: "concept",
					targetId,
					targetLabel: targetName,
					relationship: link.relationship,
					confidence: link.confidence ?? 0.7,
					createdBy: "system",
					createdFromResourceId: null,
				});
			}

			if (relationships.length > 0) {
				const existing = await db.relationship.findMany({
					where: {
						sessionId,
						sourceType: "concept",
						targetType: "concept",
					},
					select: { sourceId: true, targetId: true, relationship: true },
				});
				const existingKeys = new Set(
					existing.map((r) => `${r.sourceId}:${r.targetId}:${r.relationship}`),
				);

				const newRels = relationships.filter(
					(r) => !existingKeys.has(`${r.sourceId}:${r.targetId}:${r.relationship}`),
				);

				if (newRels.length > 0) {
					await db.relationship.createMany({ data: newRels });
					linksAdded = newRels.length;
					activeLog.info(
						`runCrossLinking — session ${sessionId}: added ${newRels.length} new cross-links`,
					);
				}
			}
		}

		const phase3Result = { status: "completed" as const, linksAdded };
		crossLinkStatus.set(batchId, phase3Result);
		await persistPhaseStatus(batchId, "phase3Status", phase3Result);

		try {
			await db.graphLog.create({
				data: {
					sessionId,
					source: "cross-linker",
					action: "cross-link",
					relationshipsCreated: linksAdded,
					durationMs: Date.now() - crossLinkStart,
				},
			});
		} catch (e) {
			activeLog.warn("runCrossLinking — failed to write GraphLog", e);
		}

		activeLog.info(
			`runCrossLinking — completed in ${((Date.now() - crossLinkStart) / 1000).toFixed(1)}s, ${linksAdded} links added`,
		);
	} catch (error) {
		if (error instanceof CancellationError) {
			const skipped = { status: "skipped" as const };
			crossLinkStatus.set(batchId, skipped);
			await persistPhaseStatus(batchId, "phase3Status", skipped);
			activeLog.info(`runCrossLinking — session ${sessionId} cancelled`);
			return;
		}
		const msg = error instanceof Error ? error.message : String(error);
		activeLog.error(`runCrossLinking — session ${sessionId} failed: ${msg}`, error);
		const failed = { status: "failed" as const, error: msg };
		crossLinkStatus.set(batchId, failed);
		await persistPhaseStatus(batchId, "phase3Status", failed);
		// Cross-linking failure is non-fatal — don't fail the batch
	}
}

async function runGraphCleanup(
	sessionId: string,
	batchId: string,
	signal?: AbortSignal,
	indexerLog?: IndexerLogger,
): Promise<void> {
	const activeLog = indexerLog ?? log;

	if ((await isBatchCancelled(batchId)) || signal?.aborted) return;

	cleanupStatus.set(batchId, { status: "running" });
	const cleanupStart = Date.now();

	try {
		activeLog.info(`runGraphCleanup — session ${sessionId}, starting cleanup`);

		// Step 1: programmatic cleanup
		const progStats = await runProgrammaticCleanup(sessionId, signal, indexerLog);

		if (signal?.aborted || (await isBatchCancelled(batchId))) {
			const skipped = { status: "skipped" as const };
			cleanupStatus.set(batchId, skipped);
			await persistPhaseStatus(batchId, "phase4Status", skipped);
			return;
		}

		// Step 2: LLM cleanup agent
		let agentStats: CleanupAgentStats = {
			conceptsMerged: 0,
			conceptsDeleted: 0,
			relationshipsDeleted: 0,
			duplicatesAfterMerge: 0,
		};

		try {
			const agentResult = await runCleanupAgent(sessionId, signal, indexerLog);

			// Re-check cancellation after agent returns — don't apply results to a cancelled batch
			if (signal?.aborted || (await isBatchCancelled(batchId))) {
				const skipped = { status: "skipped" as const };
				cleanupStatus.set(batchId, skipped);
				await persistPhaseStatus(batchId, "phase4Status", skipped);
				activeLog.info(`runGraphCleanup — session ${sessionId} cancelled (post-agent)`);
				return;
			}

			agentStats = await applyCleanupResult(sessionId, agentResult);
		} catch (error) {
			if (error instanceof CancellationError) throw error;
			const msg = error instanceof Error ? error.message : String(error);
			activeLog.warn(`runGraphCleanup — LLM cleanup agent failed (non-fatal): ${msg}`, error);
		}

		const combinedStats = {
			duplicatesRemoved: progStats.duplicateRelationshipsRemoved + agentStats.duplicatesAfterMerge,
			orphansRemoved: progStats.orphanedConceptsRemoved + agentStats.conceptsDeleted,
			integrityFixes: progStats.integrityIssuesFixed + agentStats.relationshipsDeleted,
			conceptsMerged: agentStats.conceptsMerged,
		};

		const phase4Result = { status: "completed" as const, stats: combinedStats };
		cleanupStatus.set(batchId, phase4Result);
		await persistPhaseStatus(batchId, "phase4Status", phase4Result);

		try {
			const db = getDb();
			await db.graphLog.create({
				data: {
					sessionId,
					source: "cleanup",
					action: "cleanup",
					conceptsUpdated: combinedStats.conceptsMerged,
					relationshipsCreated: 0,
					durationMs: Date.now() - cleanupStart,
					details: JSON.stringify(combinedStats),
				},
			});
		} catch (e) {
			activeLog.warn("runGraphCleanup — failed to write GraphLog", e);
		}

		activeLog.info(
			`runGraphCleanup — completed in ${((Date.now() - cleanupStart) / 1000).toFixed(1)}s — duplicates=${combinedStats.duplicatesRemoved}, orphans=${combinedStats.orphansRemoved}, integrity=${combinedStats.integrityFixes}, merged=${combinedStats.conceptsMerged}`,
		);
	} catch (error) {
		if (error instanceof CancellationError) {
			const skipped = { status: "skipped" as const };
			cleanupStatus.set(batchId, skipped);
			await persistPhaseStatus(batchId, "phase4Status", skipped);
			activeLog.info(`runGraphCleanup — session ${sessionId} cancelled`);
			return;
		}
		const msg = error instanceof Error ? error.message : String(error);
		activeLog.error(`runGraphCleanup — session ${sessionId} failed: ${msg}`, error);
		const failed = { status: "failed" as const, error: msg };
		cleanupStatus.set(batchId, failed);
		await persistPhaseStatus(batchId, "phase4Status", failed);
		// Cleanup failure is non-fatal — don't fail the batch
	}
}

async function runMetadataExtraction(
	sessionId: string,
	batchId: string,
	signal?: AbortSignal,
	indexerLog?: IndexerLogger,
): Promise<void> {
	const db = getDb();
	const activeLog = indexerLog ?? log;

	if ((await isBatchCancelled(batchId)) || signal?.aborted) return;

	// Find all successfully graph-indexed resources in this batch
	const batch = await db.indexBatch.findUnique({
		where: { id: batchId },
		include: {
			jobs: {
				where: { status: "completed" },
				select: { resourceId: true },
			},
		},
	});
	if (!batch || batch.jobs.length === 0) {
		const skipped = { status: "skipped" as const };
		metadataStatus.set(batchId, skipped);
		await persistPhaseStatus(batchId, "phase5Status", skipped);
		return;
	}

	// Only process resources that are graph-indexed but not yet meta-indexed
	const resources = await db.resource.findMany({
		where: {
			id: { in: batch.jobs.map((j) => j.resourceId) },
			isGraphIndexed: true,
			isMetaIndexed: false,
		},
		select: { id: true, name: true },
	});

	if (resources.length === 0) {
		const done = { status: "completed" as const, total: 0, completed: 0, failed: 0 };
		metadataStatus.set(batchId, done);
		await persistPhaseStatus(batchId, "phase5Status", done);
		return;
	}

	metadataStatus.set(batchId, {
		status: "running",
		total: resources.length,
		completed: 0,
		failed: 0,
	});

	const metaQueue = new PQueue({ concurrency: 3 });
	let completed = 0;
	let failed = 0;

	for (const resource of resources) {
		metaQueue.add(
			async () => {
				if (signal?.aborted || (await isBatchCancelled(batchId))) return;
				try {
					await indexResourceMetadata(resource.id, signal, indexerLog);
					// Re-check cancellation — don't count results for a cancelled batch
					if (signal?.aborted || (await isBatchCancelled(batchId))) return;
					completed++;
					metadataStatus.set(batchId, {
						status: "running",
						total: resources.length,
						completed,
						failed,
					});
				} catch (error) {
					if (error instanceof CancellationError) return;
					failed++;
					const msg = error instanceof Error ? error.message : String(error);
					activeLog.error(`runMetadataExtraction — "${resource.name}" failed: ${msg}`, error);
					metadataStatus.set(batchId, {
						status: "running",
						total: resources.length,
						completed,
						failed,
					});
					// Non-fatal: don't fail the batch
				}
			},
			{ signal },
		);
	}

	try {
		await metaQueue.onIdle();
	} catch (error) {
		if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
	}

	if (signal?.aborted || (await isBatchCancelled(batchId))) {
		const skipped = { status: "skipped" as const };
		metadataStatus.set(batchId, skipped);
		await persistPhaseStatus(batchId, "phase5Status", skipped);
		return;
	}

	const phase5Result = {
		status: "completed" as const,
		total: resources.length,
		completed,
		failed,
	};
	metadataStatus.set(batchId, phase5Result);
	await persistPhaseStatus(batchId, "phase5Status", phase5Result);

	activeLog.info(
		`runMetadataExtraction — session ${sessionId}: ${completed}/${resources.length} completed, ${failed} failed`,
	);
}

async function runPhasedBatch(batchId: string): Promise<void> {
	const db = getDb();

	const batch = await db.indexBatch.findUnique({
		where: { id: batchId },
		include: {
			jobs: {
				orderBy: { sortOrder: "asc" },
				include: { resource: { select: { type: true, name: true } } },
			},
		},
	});
	if (!batch) return;

	const controller = new AbortController();
	batchAbortControllers.set(batchId, controller);
	const { signal } = controller;

	const indexerLog = new IndexerLogger(batchId, batch.sessionId);
	const batchStart = Date.now();

	try {
		const sessionId = batch.sessionId;
		const phase1Jobs = batch.jobs.filter((j) => PHASE_1_TYPES.has(j.resource.type));
		const phase2Jobs = batch.jobs.filter((j) => !PHASE_1_TYPES.has(j.resource.type));

		// Log batch config
		indexerLog.info(`runPhasedBatch — batch ${batchId}, session ${sessionId}`);
		indexerLog.info(
			`runPhasedBatch — ${batch.jobs.length} total resources: phase1=${phase1Jobs.length} (sequential), phase2=${phase2Jobs.length} (parallel)`,
		);
		for (const job of batch.jobs) {
			const phase = PHASE_1_TYPES.has(job.resource.type) ? 1 : 2;
			indexerLog.info(
				`  resource: "${job.resource.name}" type=${job.resource.type} phase=${phase} thoroughness=${job.thoroughness || "standard"}`,
			);
		}

		// Phase 1: sequential (lectures/specs establish concepts)
		indexerLog.startPhase(1);
		for (const job of phase1Jobs) {
			if (signal.aborted || (await isBatchCancelled(batchId))) break;
			await runIndexJob(job.id, signal, indexerLog);
		}
		indexerLog.endPhase();

		// Phase 2: parallel (papers/sheets/other link to concepts)
		if (!signal.aborted && !(await isBatchCancelled(batchId)) && phase2Jobs.length > 0) {
			indexerLog.startPhase(2);
			const phase2Queue = new PQueue({ concurrency: 3 });
			for (const job of phase2Jobs) {
				phase2Queue.add(
					async () => {
						if (signal.aborted || (await isBatchCancelled(batchId))) return;
						await runIndexJob(job.id, signal, indexerLog);
					},
					{ signal },
				);
			}
			try {
				await phase2Queue.onIdle();
			} catch (error) {
				// PQueue throws AbortError when signal is aborted — suppress it
				if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
			}
			indexerLog.endPhase();
		}

		// Phase 3: cross-linking pass
		if (!signal.aborted && !(await isBatchCancelled(batchId))) {
			indexerLog.startPhase(3);
			await runCrossLinking(sessionId, batchId, signal, indexerLog);
			indexerLog.endPhase();
		}

		// Phase 4: graph cleanup
		if (!signal.aborted && !(await isBatchCancelled(batchId))) {
			indexerLog.startPhase(4);
			await runGraphCleanup(sessionId, batchId, signal, indexerLog);
			indexerLog.endPhase();
		}

		// Phase 5: metadata extraction (per-resource, parallel, concurrency=3)
		if (!signal.aborted && !(await isBatchCancelled(batchId))) {
			indexerLog.startPhase(5);
			await runMetadataExtraction(sessionId, batchId, signal, indexerLog);
			indexerLog.endPhase();
		}

		// Finalize batch status
		const finalBatch = await db.indexBatch.findUnique({ where: { id: batchId } });
		if (finalBatch && finalBatch.status !== "cancelled") {
			if (finalBatch.completed + finalBatch.failed >= finalBatch.total) {
				await db.indexBatch.update({
					where: { id: batchId },
					data: { status: "completed", completedAt: new Date() },
				});
			}
		}

		const totalDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
		indexerLog.info(
			`runPhasedBatch — batch ${batchId} finished in ${totalDuration}s — completed=${finalBatch?.completed ?? "?"}, failed=${finalBatch?.failed ?? "?"}`,
		);
	} finally {
		indexerLog.info(`runPhasedBatch — logs written to ${indexerLog.dir}`);
		indexerLog.close();
		batchAbortControllers.delete(batchId);
		consecutiveApiFailures.delete(batchId);
	}
}

export async function enqueueSessionGraphIndexing(
	sessionId: string,
	resourceIds: string[],
	thoroughness?: Thoroughness,
): Promise<string> {
	const db = getDb();

	// Fetch resource types to determine phase ordering
	const resources = await db.resource.findMany({
		where: { id: { in: resourceIds } },
		select: { id: true, type: true },
	});
	const typeMap = new Map(resources.map((r) => [r.id, r.type]));

	// Sort: phase 1 types first (lower sortOrder), then phase 2
	const sorted = [...resourceIds].sort((a, b) => {
		const aPhase1 = PHASE_1_TYPES.has(typeMap.get(a) ?? "") ? 0 : 1;
		const bPhase1 = PHASE_1_TYPES.has(typeMap.get(b) ?? "") ? 0 : 1;
		return aPhase1 - bPhase1;
	});

	const batch = await db.indexBatch.create({
		data: {
			sessionId,
			status: "running",
			total: sorted.length,
			jobs: {
				create: sorted.map((resourceId, i) => ({
					resourceId,
					sortOrder: i,
					status: "pending",
					...(thoroughness ? { thoroughness } : {}),
				})),
			},
		},
		include: { jobs: true },
	});

	// Initialize cross-link, cleanup, and metadata status
	crossLinkStatus.set(batch.id, { status: "pending" });
	cleanupStatus.set(batch.id, { status: "pending" });
	metadataStatus.set(batch.id, { status: "pending" });

	// Enqueue a single phased batch run (keeps concurrency=1 at batch level)
	indexingQueue.add(() => runPhasedBatch(batch.id));

	const p1Count = sorted.filter((id) => PHASE_1_TYPES.has(typeMap.get(id) ?? "")).length;
	log.info(
		`enqueueSessionGraphIndexing — session ${sessionId}, batch ${batch.id}, ${resourceIds.length} resources (phase1=${p1Count}, phase2=${sorted.length - p1Count})`,
	);
	return batch.id;
}

export async function cancelSessionIndexing(sessionId: string): Promise<boolean> {
	const db = getDb();

	const batch = await db.indexBatch.findFirst({
		where: { sessionId, status: "running" },
		orderBy: { startedAt: "desc" },
	});
	if (!batch) return false;

	await db.indexBatch.update({
		where: { id: batch.id },
		data: { status: "cancelled", completedAt: new Date() },
	});
	await db.indexJob.updateMany({
		where: { batchId: batch.id, status: { in: ["pending", "running"] } },
		data: { status: "cancelled" },
	});

	// Abort in-flight processes (kills spawned claude CLI processes via SIGTERM)
	const controller = batchAbortControllers.get(batch.id);
	if (controller) {
		controller.abort();
		batchAbortControllers.delete(batch.id);
	}

	// Persist skipped status for phases that haven't completed yet
	const skipped = JSON.stringify({ status: "skipped" });
	const clCurrent = crossLinkStatus.get(batch.id);
	const cuCurrent = cleanupStatus.get(batch.id);
	const mdCurrent = metadataStatus.get(batch.id);
	const phaseUpdates: Record<string, string> = {};
	if (!clCurrent || clCurrent.status === "pending" || clCurrent.status === "running") {
		phaseUpdates.phase3Status = skipped;
	}
	if (!cuCurrent || cuCurrent.status === "pending" || cuCurrent.status === "running") {
		phaseUpdates.phase4Status = skipped;
	}
	if (!mdCurrent || mdCurrent.status === "pending" || mdCurrent.status === "running") {
		phaseUpdates.phase5Status = skipped;
	}
	if (Object.keys(phaseUpdates).length > 0) {
		try {
			await db.indexBatch.update({ where: { id: batch.id }, data: phaseUpdates });
		} catch (e) {
			log.warn("cancelSessionIndexing — failed to persist phase status", e);
		}
	}

	crossLinkStatus.delete(batch.id);
	cleanupStatus.delete(batch.id);
	metadataStatus.delete(batch.id);
	log.info(`cancelSessionIndexing — session ${sessionId}, batch ${batch.id} cancelled`);
	return true;
}

export interface PhaseInfo {
	current: 1 | 2 | 3 | 4 | 5 | null;
	phase1: { total: number; completed: number; failed: number; mode: "sequential" };
	phase2: {
		total: number;
		completed: number;
		failed: number;
		running: number;
		mode: "parallel";
		concurrency: number;
	};
	phase3: {
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		error?: string;
		linksAdded?: number;
	};
	phase4: {
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		error?: string;
		stats?: {
			duplicatesRemoved: number;
			orphansRemoved: number;
			integrityFixes: number;
			conceptsMerged: number;
		};
	};
	phase5: {
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		total?: number;
		completed?: number;
		failed?: number;
	};
}

export interface BatchStatusResult {
	batchId: string;
	batchTotal: number;
	batchCompleted: number;
	batchFailed: number;
	currentResourceId: string | null;
	startedAt: number;
	cancelled: boolean;
	phase: PhaseInfo;
	resources: Array<{
		id: string;
		name: string;
		type: string;
		phase: 1 | 2;
		status: "pending" | "indexing" | "completed" | "cancelled" | "failed";
		durationMs: number | null;
		errorMessage: string | null;
		errorType: string | null;
		attempts: number;
	}>;
}

export async function getSessionBatchStatus(sessionId: string): Promise<BatchStatusResult | null> {
	const db = getDb();

	const jobsInclude = { jobs: { orderBy: { sortOrder: "asc" as const } } };
	const batch =
		(await db.indexBatch.findFirst({
			where: { sessionId, status: "running" },
			include: jobsInclude,
		})) ??
		(await db.indexBatch.findFirst({
			where: { sessionId },
			orderBy: { startedAt: "desc" },
			include: jobsInclude,
		}));
	if (!batch) return null;

	const batchResources = await db.resource.findMany({
		where: { id: { in: batch.jobs.map((j) => j.resourceId) } },
		select: { id: true, name: true, type: true },
	});
	const resourceMap = new Map(batchResources.map((r) => [r.id, r]));

	const resources = batch.jobs.map((j) => {
		const r = resourceMap.get(j.resourceId);
		const type = r?.type ?? "OTHER";
		return {
			id: j.resourceId,
			name: r?.name ?? "Unknown",
			type,
			phase: (PHASE_1_TYPES.has(type) ? 1 : 2) as 1 | 2,
			status: (j.status === "running"
				? "indexing"
				: j.status) as BatchStatusResult["resources"][0]["status"],
			durationMs: j.durationMs,
			errorMessage: j.errorMessage,
			errorType: j.errorType,
			attempts: j.attempts,
		};
	});

	// Compute phase stats
	const p1Resources = resources.filter((r) => r.phase === 1);
	const p2Resources = resources.filter((r) => r.phase === 2);

	const p1Completed = p1Resources.filter((r) => r.status === "completed").length;
	const p1Failed = p1Resources.filter((r) => r.status === "failed").length;
	const p1Done = p1Completed + p1Failed >= p1Resources.length;

	const p2Completed = p2Resources.filter((r) => r.status === "completed").length;
	const p2Failed = p2Resources.filter((r) => r.status === "failed").length;
	const p2Running = p2Resources.filter((r) => r.status === "indexing").length;
	const p2Done = p2Resources.length === 0 || p2Completed + p2Failed >= p2Resources.length;

	const resolvePhaseStatus = <T>(inMemory: T | undefined, persisted: string | null): T => {
		if (batch.status === "cancelled") {
			return persisted ? JSON.parse(persisted) : ({ status: "skipped" } as T);
		}
		if (inMemory) return { ...inMemory };
		if (persisted) return JSON.parse(persisted);
		if (batch.status === "completed") return { status: "completed" } as T;
		return { status: "pending" } as T;
	};

	const phase3Status = resolvePhaseStatus<PhaseInfo["phase3"]>(
		crossLinkStatus.get(batch.id),
		batch.phase3Status,
	);
	const phase4Status = resolvePhaseStatus<PhaseInfo["phase4"]>(
		cleanupStatus.get(batch.id),
		batch.phase4Status,
	);
	const phase5Status = resolvePhaseStatus<PhaseInfo["phase5"]>(
		metadataStatus.get(batch.id),
		batch.phase5Status,
	);

	// Determine current phase
	let currentPhase: PhaseInfo["current"] = null;
	if (batch.status === "running") {
		if (!p1Done) {
			currentPhase = 1;
		} else if (!p2Done) {
			currentPhase = 2;
		} else if (phase3Status.status === "running") {
			currentPhase = 3;
		} else if (phase4Status.status === "running") {
			currentPhase = 4;
		} else if (phase5Status.status === "running") {
			currentPhase = 5;
		}
	}

	return {
		batchId: batch.id,
		batchTotal: batch.total,
		batchCompleted: batch.completed,
		batchFailed: batch.failed,
		currentResourceId: batch.jobs.find((j) => j.status === "running")?.resourceId ?? null,
		startedAt: batch.startedAt.getTime(),
		cancelled: batch.status === "cancelled",
		phase: {
			current: currentPhase,
			phase1: {
				total: p1Resources.length,
				completed: p1Completed,
				failed: p1Failed,
				mode: "sequential",
			},
			phase2: {
				total: p2Resources.length,
				completed: p2Completed,
				failed: p2Failed,
				running: p2Running,
				mode: "parallel",
				concurrency: 3,
			},
			phase3: phase3Status,
			phase4: phase4Status,
			phase5: phase5Status,
		},
		resources,
	};
}

export async function resumeInterruptedBatches(): Promise<void> {
	const db = getDb();

	const interrupted = await db.indexBatch.findMany({
		where: { status: "running" },
		include: { jobs: true },
	});

	if (interrupted.length === 0) return;

	log.info(`resumeInterruptedBatches — found ${interrupted.length} interrupted batch(es)`);

	for (const batch of interrupted) {
		await db.indexJob.updateMany({
			where: { batchId: batch.id, status: "running" },
			data: { status: "pending" },
		});

		crossLinkStatus.set(batch.id, { status: "pending" });
		cleanupStatus.set(batch.id, { status: "pending" });
		metadataStatus.set(batch.id, { status: "pending" });
		indexingQueue.add(() => runPhasedBatch(batch.id));

		const pendingCount = batch.jobs.filter(
			(j) => j.status === "pending" || j.status === "running",
		).length;
		log.info(
			`resumeInterruptedBatches — batch ${batch.id}: re-enqueued with ${pendingCount} pending jobs`,
		);
	}
}

export async function retryFailedJobs(sessionId: string): Promise<number> {
	const db = getDb();

	const batch = await db.indexBatch.findFirst({
		where: { sessionId },
		orderBy: { startedAt: "desc" },
		include: { jobs: { where: { status: "failed" } } },
	});

	if (!batch || batch.jobs.length === 0) return 0;

	const failedJobIds = batch.jobs.map((j) => j.id);

	await db.indexJob.updateMany({
		where: { id: { in: failedJobIds } },
		data: { status: "pending", errorMessage: null, errorType: null },
	});

	await db.indexBatch.update({
		where: { id: batch.id },
		data:
			batch.status !== "running"
				? { status: "running", failed: 0, completedAt: null }
				: { failed: { decrement: failedJobIds.length } },
	});

	crossLinkStatus.set(batch.id, { status: "pending" });
	cleanupStatus.set(batch.id, { status: "pending" });
	metadataStatus.set(batch.id, { status: "pending" });
	indexingQueue.add(() => runPhasedBatch(batch.id));

	log.info(`retryFailedJobs — session ${sessionId}, retrying ${failedJobIds.length} jobs`);
	return failedJobIds.length;
}

export const getIndexingQueueSize = () => indexingQueue.size + indexingQueue.pending;
