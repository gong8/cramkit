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

export function enqueueSessionGraphIndexing(sessionId: string, fileIds: string[]): void {
	for (const fileId of fileIds) {
		indexingQueue.add(() => indexFileGraph(fileId));
	}
	log.info(`enqueueSessionGraphIndexing — session ${sessionId}, ${fileIds.length} files queued`);
}

export function getIndexingQueueSize(): number {
	return indexingQueue.size + indexingQueue.pending;
}
