import PQueue from "p-queue";
import { processFile } from "../services/file-processor.js";

const queue = new PQueue({ concurrency: 1 });

export function enqueueProcessing(fileId: string): void {
	queue.add(() => processFile(fileId));
}

export function getQueueSize(): number {
	return queue.size + queue.pending;
}
