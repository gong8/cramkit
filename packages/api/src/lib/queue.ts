import { createLogger, getDb } from "@cramkit/shared";
import PQueue from "p-queue";
import { runCrossLinkingAgent } from "../services/cross-linker.js";
import { toTitleCase } from "../services/graph-indexer-utils.js";
import {
	GraphIndexError,
	type Thoroughness,
	indexResourceGraph,
} from "../services/graph-indexer.js";
import { processResource } from "../services/resource-processor.js";

const log = createLogger("api");
const queue = new PQueue({ concurrency: 1 });
const indexingQueue = new PQueue({ concurrency: 1 });

export function enqueueProcessing(resourceId: string): void {
	queue.add(() => processResource(resourceId));
	log.info(`enqueueProcessing — resource ${resourceId}, queue size: ${queue.size + queue.pending}`);
}

export const getQueueSize = () => queue.size + queue.pending;

export function enqueueGraphIndexing(resourceId: string, thoroughness?: Thoroughness): void {
	indexingQueue.add(() => indexResourceGraph(resourceId, thoroughness));
	log.info(
		`enqueueGraphIndexing — resource ${resourceId}, thoroughness=${thoroughness ?? "standard"}, indexing queue size: ${indexingQueue.size + indexingQueue.pending}`,
	);
}

const PHASE_1_TYPES = new Set(["LECTURE_NOTES", "SPECIFICATION"]);

async function runIndexJob(jobId: string): Promise<void> {
	const db = getDb();

	const job = await db.indexJob.findUnique({
		where: { id: jobId },
		include: { batch: { select: { status: true } } },
	});
	if (!job) return;

	if (job.batch.status === "cancelled") {
		await db.indexJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
		return;
	}

	await db.indexJob.update({
		where: { id: jobId },
		data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
	});

	try {
		const startTime = Date.now();
		await indexResourceGraph(job.resourceId, (job.thoroughness as Thoroughness) || undefined);
		await db.indexJob.update({
			where: { id: jobId },
			data: { status: "completed", completedAt: new Date(), durationMs: Date.now() - startTime },
		});
		await db.indexBatch.update({
			where: { id: job.batchId },
			data: { completed: { increment: 1 } },
		});
	} catch (error) {
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
		log.error(`runIndexJob — job ${jobId} failed: ${errorMessage}`);
	}
}

async function isBatchCancelled(batchId: string): Promise<boolean> {
	const db = getDb();
	const batch = await db.indexBatch.findUnique({ where: { id: batchId } });
	return batch?.status === "cancelled";
}

async function runCrossLinking(sessionId: string, batchId: string): Promise<void> {
	const db = getDb();

	if (await isBatchCancelled(batchId)) return;

	try {
		log.info(`runCrossLinking — session ${sessionId}, starting cross-linking pass`);
		const result = await runCrossLinkingAgent(sessionId);

		if (result.links.length > 0) {
			// Write cross-links to DB
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
					createdBy: "system",
				});
			}

			if (relationships.length > 0) {
				// Deduplicate against existing relationships
				const existing = await db.relationship.findMany({
					where: {
						sessionId,
						sourceType: "concept",
						targetType: "concept",
						createdBy: "system",
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
					log.info(
						`runCrossLinking — session ${sessionId}: added ${newRels.length} new cross-links`,
					);
				}
			}
		}
	} catch (error) {
		log.error(
			`runCrossLinking — session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		// Cross-linking failure is non-fatal — don't fail the batch
	}
}

async function runPhasedBatch(batchId: string): Promise<void> {
	const db = getDb();

	const batch = await db.indexBatch.findUnique({
		where: { id: batchId },
		include: {
			jobs: {
				orderBy: { sortOrder: "asc" },
				include: { resource: { select: { type: true } } },
			},
		},
	});
	if (!batch) return;

	const sessionId = batch.sessionId;
	const phase1Jobs = batch.jobs.filter((j) => PHASE_1_TYPES.has(j.resource.type));
	const phase2Jobs = batch.jobs.filter((j) => !PHASE_1_TYPES.has(j.resource.type));

	// Phase 1: sequential (lectures/specs establish concepts)
	log.info(
		`runPhasedBatch — batch ${batchId}: Phase 1 — ${phase1Jobs.length} lecture/spec resources (sequential)`,
	);
	for (const job of phase1Jobs) {
		if (await isBatchCancelled(batchId)) break;
		await runIndexJob(job.id);
	}

	// Phase 2: parallel (papers/sheets/other link to concepts)
	if (!(await isBatchCancelled(batchId)) && phase2Jobs.length > 0) {
		log.info(
			`runPhasedBatch — batch ${batchId}: Phase 2 — ${phase2Jobs.length} paper/sheet resources (parallel, concurrency=3)`,
		);
		const phase2Queue = new PQueue({ concurrency: 3 });
		for (const job of phase2Jobs) {
			phase2Queue.add(async () => {
				if (await isBatchCancelled(batchId)) return;
				await runIndexJob(job.id);
			});
		}
		await phase2Queue.onIdle();
	}

	// Phase 3: cross-linking pass
	if (!(await isBatchCancelled(batchId))) {
		log.info(`runPhasedBatch — batch ${batchId}: Phase 3 — cross-linking`);
		await runCrossLinking(sessionId, batchId);
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

	// Enqueue a single phased batch run (keeps concurrency=1 at batch level)
	indexingQueue.add(() => runPhasedBatch(batch.id));

	log.info(
		`enqueueSessionGraphIndexing — session ${sessionId}, batch ${batch.id}, ${resourceIds.length} resources queued (phase1=${sorted.filter((id) => PHASE_1_TYPES.has(typeMap.get(id) ?? "")).length}, phase2=${sorted.filter((id) => !PHASE_1_TYPES.has(typeMap.get(id) ?? "")).length})`,
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
		where: { batchId: batch.id, status: "pending" },
		data: { status: "cancelled" },
	});

	log.info(`cancelSessionIndexing — session ${sessionId}, batch ${batch.id} cancelled`);
	return true;
}

export interface BatchStatusResult {
	batchId: string;
	batchTotal: number;
	batchCompleted: number;
	batchFailed: number;
	currentResourceId: string | null;
	startedAt: number;
	cancelled: boolean;
	resources: Array<{
		id: string;
		name: string;
		type: string;
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
		return {
			id: j.resourceId,
			name: r?.name ?? "Unknown",
			type: r?.type ?? "OTHER",
			status: (j.status === "running"
				? "indexing"
				: j.status) as BatchStatusResult["resources"][0]["status"],
			durationMs: j.durationMs,
			errorMessage: j.errorMessage,
			errorType: j.errorType,
			attempts: j.attempts,
		};
	});

	return {
		batchId: batch.id,
		batchTotal: batch.total,
		batchCompleted: batch.completed,
		batchFailed: batch.failed,
		currentResourceId: batch.jobs.find((j) => j.status === "running")?.resourceId ?? null,
		startedAt: batch.startedAt.getTime(),
		cancelled: batch.status === "cancelled",
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

		// Re-enqueue as a phased batch
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

	// Re-enqueue as phased batch to handle retried jobs properly
	indexingQueue.add(() => runPhasedBatch(batch.id));

	log.info(`retryFailedJobs — session ${sessionId}, retrying ${failedJobIds.length} jobs`);
	return failedJobIds.length;
}

export const getIndexingQueueSize = () => indexingQueue.size + indexingQueue.pending;
