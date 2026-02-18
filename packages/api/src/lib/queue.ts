import { createLogger, getDb } from "@cramkit/shared";
import PQueue from "p-queue";
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
	thoroughness?: Thoroughness,
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
					...(thoroughness ? { thoroughness } : {}),
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

	for (const job of batch.jobs) {
		indexingQueue.add(() => runIndexJob(job.id));
	}

	log.info(`retryFailedJobs — session ${sessionId}, retrying ${failedJobIds.length} jobs`);
	return failedJobIds.length;
}

export const getIndexingQueueSize = () => indexingQueue.size + indexingQueue.pending;
