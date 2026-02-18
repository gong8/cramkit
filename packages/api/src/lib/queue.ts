import { createLogger, getDb } from "@cramkit/shared";
import PQueue from "p-queue";
import { runCrossLinkingAgent } from "../services/cross-linker.js";
import { CancellationError } from "../services/errors.js";
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

// In-memory abort controllers for active batches (allows cancellation to kill running processes)
const batchAbortControllers = new Map<string, AbortController>();

// In-memory cross-linking status tracking (not persisted — only relevant during active batches)
const crossLinkStatus = new Map<
	string,
	{ status: "pending" | "running" | "completed" | "failed"; error?: string; linksAdded?: number }
>();

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

async function runIndexJob(jobId: string, signal?: AbortSignal): Promise<void> {
	const db = getDb();

	const job = await db.indexJob.findUnique({
		where: { id: jobId },
		include: { batch: { select: { status: true } } },
	});
	if (!job) return;

	if (job.batch.status === "cancelled" || signal?.aborted) {
		await db.indexJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
		return;
	}

	await db.indexJob.update({
		where: { id: jobId },
		data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
	});

	try {
		const startTime = Date.now();
		await indexResourceGraph(
			job.resourceId,
			(job.thoroughness as Thoroughness) || undefined,
			signal,
		);
		await db.indexJob.update({
			where: { id: jobId },
			data: { status: "completed", completedAt: new Date(), durationMs: Date.now() - startTime },
		});
		await db.indexBatch.update({
			where: { id: job.batchId },
			data: { completed: { increment: 1 } },
		});
	} catch (error) {
		if (error instanceof CancellationError) {
			await db.indexJob.update({
				where: { id: jobId },
				data: { status: "cancelled" },
			});
			log.info(`runIndexJob — job ${jobId} cancelled`);
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
		log.error(`runIndexJob — job ${jobId} failed: ${errorMessage}`);
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
): Promise<void> {
	const db = getDb();

	if ((await isBatchCancelled(batchId)) || signal?.aborted) return;

	crossLinkStatus.set(batchId, { status: "running" });

	try {
		log.info(`runCrossLinking — session ${sessionId}, starting cross-linking pass`);
		const result = await runCrossLinkingAgent(sessionId, signal);

		let linksAdded = 0;
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
					createdBy: "system",
				});
			}

			if (relationships.length > 0) {
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
					linksAdded = newRels.length;
					log.info(
						`runCrossLinking — session ${sessionId}: added ${newRels.length} new cross-links`,
					);
				}
			}
		}

		crossLinkStatus.set(batchId, { status: "completed", linksAdded });
	} catch (error) {
		if (error instanceof CancellationError) {
			crossLinkStatus.set(batchId, { status: "skipped" });
			log.info(`runCrossLinking — session ${sessionId} cancelled`);
			return;
		}
		const msg = error instanceof Error ? error.message : String(error);
		log.error(`runCrossLinking — session ${sessionId} failed: ${msg}`);
		crossLinkStatus.set(batchId, { status: "failed", error: msg });
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

	const controller = new AbortController();
	batchAbortControllers.set(batchId, controller);
	const { signal } = controller;

	try {
		const sessionId = batch.sessionId;
		const phase1Jobs = batch.jobs.filter((j) => PHASE_1_TYPES.has(j.resource.type));
		const phase2Jobs = batch.jobs.filter((j) => !PHASE_1_TYPES.has(j.resource.type));

		// Phase 1: sequential (lectures/specs establish concepts)
		log.info(
			`runPhasedBatch — batch ${batchId}: Phase 1 — ${phase1Jobs.length} lecture/spec resources (sequential)`,
		);
		for (const job of phase1Jobs) {
			if (signal.aborted || (await isBatchCancelled(batchId))) break;
			await runIndexJob(job.id, signal);
		}

		// Phase 2: parallel (papers/sheets/other link to concepts)
		if (!signal.aborted && !(await isBatchCancelled(batchId)) && phase2Jobs.length > 0) {
			log.info(
				`runPhasedBatch — batch ${batchId}: Phase 2 — ${phase2Jobs.length} paper/sheet resources (parallel, concurrency=3)`,
			);
			const phase2Queue = new PQueue({ concurrency: 3 });
			for (const job of phase2Jobs) {
				phase2Queue.add(
					async () => {
						if (signal.aborted || (await isBatchCancelled(batchId))) return;
						await runIndexJob(job.id, signal);
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
		}

		// Phase 3: cross-linking pass
		if (!signal.aborted && !(await isBatchCancelled(batchId))) {
			log.info(`runPhasedBatch — batch ${batchId}: Phase 3 — cross-linking`);
			await runCrossLinking(sessionId, batchId, signal);
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
	} finally {
		batchAbortControllers.delete(batchId);
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

	// Initialize cross-link status
	crossLinkStatus.set(batch.id, { status: "pending" });

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
		where: { batchId: batch.id, status: "pending" },
		data: { status: "cancelled" },
	});

	// Abort in-flight processes (kills spawned claude CLI processes via SIGTERM)
	const controller = batchAbortControllers.get(batch.id);
	if (controller) {
		controller.abort();
		batchAbortControllers.delete(batch.id);
	}

	crossLinkStatus.delete(batch.id);
	log.info(`cancelSessionIndexing — session ${sessionId}, batch ${batch.id} cancelled`);
	return true;
}

export interface PhaseInfo {
	current: 1 | 2 | 3 | null;
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

	// Determine cross-linking status
	const clStatus = crossLinkStatus.get(batch.id);
	let phase3Status: PhaseInfo["phase3"];
	if (batch.status === "cancelled") {
		phase3Status = { status: "skipped" };
	} else if (clStatus) {
		phase3Status = { ...clStatus };
	} else if (batch.status === "completed") {
		// Batch completed but no tracked cross-link status — already done
		phase3Status = { status: "completed" };
	} else {
		phase3Status = { status: "pending" };
	}

	// Determine current phase
	let currentPhase: PhaseInfo["current"] = null;
	if (batch.status === "running") {
		if (!p1Done) {
			currentPhase = 1;
		} else if (!p2Done) {
			currentPhase = 2;
		} else if (phase3Status.status === "running") {
			currentPhase = 3;
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
	indexingQueue.add(() => runPhasedBatch(batch.id));

	log.info(`retryFailedJobs — session ${sessionId}, retrying ${failedJobIds.length} jobs`);
	return failedJobIds.length;
}

export const getIndexingQueueSize = () => indexingQueue.size + indexingQueue.pending;
