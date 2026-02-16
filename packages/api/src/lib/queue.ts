import { createLogger } from "@cramkit/shared";
import PQueue from "p-queue";
import { processResource } from "../services/resource-processor.js";
import { indexResourceGraph } from "../services/graph-indexer.js";

const log = createLogger("api");
const queue = new PQueue({ concurrency: 1 });
const indexingQueue = new PQueue({ concurrency: 2 });

export function enqueueProcessing(resourceId: string): void {
	queue.add(() => processResource(resourceId));
	log.info(`enqueueProcessing — resource ${resourceId}, queue size: ${queue.size + queue.pending}`);
}

export function getQueueSize(): number {
	return queue.size + queue.pending;
}

export function enqueueGraphIndexing(resourceId: string): void {
	indexingQueue.add(() => indexResourceGraph(resourceId));
	log.info(`enqueueGraphIndexing — resource ${resourceId}, indexing queue size: ${indexingQueue.size + indexingQueue.pending}`);
}

// --- Session batch tracking ---

interface SessionBatchState {
	resourceIds: string[];
	completedResourceIds: string[];
	currentResourceId: string | null;
	startedAt: number;
	cancelled: boolean;
}

const sessionBatches = new Map<string, SessionBatchState>();

export function enqueueSessionGraphIndexing(sessionId: string, resourceIds: string[]): void {
	const batch: SessionBatchState = {
		resourceIds,
		completedResourceIds: [],
		currentResourceId: null,
		startedAt: Date.now(),
		cancelled: false,
	};
	sessionBatches.set(sessionId, batch);

	for (const resourceId of resourceIds) {
		indexingQueue.add(async () => {
			if (batch.cancelled) {
				log.info(`enqueueSessionGraphIndexing — skipping ${resourceId} (cancelled)`);
				return;
			}
			batch.currentResourceId = resourceId;
			await indexResourceGraph(resourceId);
			batch.completedResourceIds.push(resourceId);
			batch.currentResourceId = null;
		});
	}
	log.info(`enqueueSessionGraphIndexing — session ${sessionId}, ${resourceIds.length} resources queued`);
}

export function cancelSessionIndexing(sessionId: string): boolean {
	const batch = sessionBatches.get(sessionId);
	if (!batch) return false;
	batch.cancelled = true;
	log.info(`cancelSessionIndexing — session ${sessionId}, cancelled (${batch.completedResourceIds.length}/${batch.resourceIds.length} done)`);
	return true;
}

export function getSessionBatchStatus(sessionId: string): SessionBatchState | null {
	return sessionBatches.get(sessionId) ?? null;
}

export function getIndexingQueueSize(): number {
	return indexingQueue.size + indexingQueue.pending;
}
