import { createLogger, getDb } from "@cramkit/shared";
import PQueue from "p-queue";
import { GraphIndexError, indexResourceGraph } from "../services/graph-indexer.js";
import { processResource } from "../services/resource-processor.js";

const log = createLogger("api");
const queue = new PQueue({ concurrency: 1 });
const indexingQueue = new PQueue({ concurrency: 1 });

export function enqueueProcessing(resourceId: string): void {
	queue.add(() => processResource(resourceId));
	log.info(`enqueueProcessing — resource ${resourceId}, queue size: ${queue.size + queue.pending}`);
}

export function getQueueSize(): number {
	return queue.size + queue.pending;
}

export function enqueueGraphIndexing(resourceId: string): void {
	indexingQueue.add(() => indexResourceGraph(resourceId));
	log.info(
		`enqueueGraphIndexing — resource ${resourceId}, indexing queue size: ${indexingQueue.size + indexingQueue.pending}`,
	);
}

// --- DB-backed session batch tracking ---

async function runIndexJob(jobId: string): Promise<void> {
	const db = getDb();

	const job = await db.indexJob.findUnique({
		where: { id: jobId },
		include: { batch: { select: { status: true } } },
	});
	if (!job) return;

	// If the batch was cancelled, mark this job cancelled and stop
	if (job.batch.status === "cancelled") {
		await db.indexJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
		return;
	}

	// Mark job as running
	await db.indexJob.update({
		where: { id: jobId },
		data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
	});

	const startTime = Date.now();
	try {
		await indexResourceGraph(job.resourceId);

		// Success
		const durationMs = Date.now() - startTime;
		await db.indexJob.update({
			where: { id: jobId },
			data: { status: "completed", completedAt: new Date(), durationMs },
		});
		await db.indexBatch.update({
			where: { id: job.batchId },
			data: { completed: { increment: 1 } },
		});
	} catch (error) {
		// Failure
		const errorMessage =
			error instanceof GraphIndexError
				? error.message
				: error instanceof Error
					? error.message
					: String(error);
		const errorType =
			error instanceof GraphIndexError ? error.errorType : ("unknown" as const);

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

	// Check if the batch is done (all jobs terminal)
	const batch = await db.indexBatch.findUnique({ where: { id: job.batchId } });
	if (batch && batch.completed + batch.failed >= batch.total) {
		await db.indexBatch.update({
			where: { id: job.batchId },
			data: { status: "completed", completedAt: new Date() },
		});
	}
}

export async function enqueueSessionGraphIndexing(
	sessionId: string,
	resourceIds: string[],
): Promise<string> {
	const db = getDb();

	const batch = await db.indexBatch.create({
		data: {
			sessionId,
			status: "running",
			total: resourceIds.length,
			jobs: {
				create: resourceIds.map((resourceId, i) => ({
					resourceId,
					sortOrder: i,
					status: "pending",
				})),
			},
		},
		include: { jobs: true },
	});

	for (const job of batch.jobs) {
		indexingQueue.add(() => runIndexJob(job.id));
	}

	log.info(
		`enqueueSessionGraphIndexing — session ${sessionId}, batch ${batch.id}, ${resourceIds.length} resources queued`,
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

export async function getSessionBatchStatus(
	sessionId: string,
): Promise<BatchStatusResult | null> {
	const db = getDb();

	// Prefer running batch, then most recent
	let batch = await db.indexBatch.findFirst({
		where: { sessionId, status: "running" },
		include: { jobs: { orderBy: { sortOrder: "asc" } } },
	});
	if (!batch) {
		batch = await db.indexBatch.findFirst({
			where: { sessionId },
			orderBy: { startedAt: "desc" },
			include: { jobs: { orderBy: { sortOrder: "asc" } } },
		});
	}
	if (!batch) return null;

	// Load resource metadata for the batch
	const resourceIds = batch.jobs.map((j) => j.resourceId);
	const batchResources = await db.resource.findMany({
		where: { id: { in: resourceIds } },
		select: { id: true, name: true, type: true },
	});
	const resourceMap = new Map(batchResources.map((r) => [r.id, r]));

	const currentRunning = batch.jobs.find((j) => j.status === "running");

	const resources = batch.jobs.map((j) => {
		const r = resourceMap.get(j.resourceId);
		const status =
			j.status === "running"
				? ("indexing" as const)
				: (j.status as "pending" | "completed" | "cancelled" | "failed");
		return {
			id: j.resourceId,
			name: r?.name ?? "Unknown",
			type: r?.type ?? "OTHER",
			status,
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
		currentResourceId: currentRunning?.resourceId ?? null,
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
		// Reset any "running" jobs back to "pending" (they were interrupted mid-execution)
		await db.indexJob.updateMany({
			where: { batchId: batch.id, status: "running" },
			data: { status: "pending" },
		});

		const pendingJobs = await db.indexJob.findMany({
			where: { batchId: batch.id, status: "pending" },
			orderBy: { sortOrder: "asc" },
		});

		for (const job of pendingJobs) {
			indexingQueue.add(() => runIndexJob(job.id));
		}

		log.info(
			`resumeInterruptedBatches — batch ${batch.id}: re-enqueued ${pendingJobs.length} pending jobs`,
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

	// Reset failed jobs to pending
	await db.indexJob.updateMany({
		where: { id: { in: failedJobIds } },
		data: { status: "pending", errorMessage: null, errorType: null },
	});

	// If batch was completed/cancelled, set it back to running and recalculate failed count
	if (batch.status !== "running") {
		await db.indexBatch.update({
			where: { id: batch.id },
			data: { status: "running", failed: 0, completedAt: null },
		});
	} else {
		await db.indexBatch.update({
			where: { id: batch.id },
			data: { failed: { decrement: failedJobIds.length } },
		});
	}

	// Re-enqueue
	for (const job of batch.jobs) {
		indexingQueue.add(() => runIndexJob(job.id));
	}

	log.info(`retryFailedJobs — session ${sessionId}, retrying ${failedJobIds.length} jobs`);
	return failedJobIds.length;
}

export function getIndexingQueueSize(): number {
	return indexingQueue.size + indexingQueue.pending;
}
