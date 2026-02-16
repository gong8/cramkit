import { createLogger } from "@cramkit/shared";
import PQueue from "p-queue";
import { processFile } from "../services/file-processor.js";
import { indexFileGraph } from "../services/graph-indexer.js";

const log = createLogger("api");
const queue = new PQueue({ concurrency: 1 });
const indexingQueue = new PQueue({ concurrency: 2 });

export function enqueueProcessing(fileId: string): void {
	queue.add(() => processFile(fileId));
	log.info(`enqueueProcessing — file ${fileId}, queue size: ${queue.size + queue.pending}`);
}

export function getQueueSize(): number {
	return queue.size + queue.pending;
}

export function enqueueGraphIndexing(fileId: string): void {
	indexingQueue.add(() => indexFileGraph(fileId));
	log.info(`enqueueGraphIndexing — file ${fileId}, indexing queue size: ${indexingQueue.size + indexingQueue.pending}`);
}

// --- Session batch tracking ---

interface SessionBatchState {
	fileIds: string[];
	completedFileIds: string[];
	currentFileId: string | null;
	startedAt: number;
	cancelled: boolean;
}

const sessionBatches = new Map<string, SessionBatchState>();

export function enqueueSessionGraphIndexing(sessionId: string, fileIds: string[]): void {
	const batch: SessionBatchState = {
		fileIds,
		completedFileIds: [],
		currentFileId: null,
		startedAt: Date.now(),
		cancelled: false,
	};
	sessionBatches.set(sessionId, batch);

	for (const fileId of fileIds) {
		indexingQueue.add(async () => {
			if (batch.cancelled) {
				log.info(`enqueueSessionGraphIndexing — skipping ${fileId} (cancelled)`);
				return;
			}
			batch.currentFileId = fileId;
			await indexFileGraph(fileId);
			batch.completedFileIds.push(fileId);
			batch.currentFileId = null;
		});
	}
	log.info(`enqueueSessionGraphIndexing — session ${sessionId}, ${fileIds.length} files queued`);
}

export function cancelSessionIndexing(sessionId: string): boolean {
	const batch = sessionBatches.get(sessionId);
	if (!batch) return false;
	batch.cancelled = true;
	log.info(`cancelSessionIndexing — session ${sessionId}, cancelled (${batch.completedFileIds.length}/${batch.fileIds.length} done)`);
	return true;
}

export function getSessionBatchStatus(sessionId: string): SessionBatchState | null {
	return sessionBatches.get(sessionId) ?? null;
}

export function getIndexingQueueSize(): number {
	return indexingQueue.size + indexingQueue.pending;
}
