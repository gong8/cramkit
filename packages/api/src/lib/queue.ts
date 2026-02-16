import { createLogger } from "@cramkit/shared";
import PQueue from "p-queue";
import { processFile } from "../services/file-processor.js";

const log = createLogger("api");
const queue = new PQueue({ concurrency: 1 });

export function enqueueProcessing(fileId: string): void {
	queue.add(() => processFile(fileId));
	log.info(`enqueueProcessing — file ${fileId}, queue size: ${queue.size + queue.pending}`);
}

export function getQueueSize(): number {
	return queue.size + queue.pending;
}
