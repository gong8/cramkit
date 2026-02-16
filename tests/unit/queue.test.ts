import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../packages/api/src/services/graph-indexer.js", () => ({
	indexFileGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../packages/api/src/services/file-processor.js", () => ({
	processFile: vi.fn().mockResolvedValue(undefined),
}));

import { indexFileGraph } from "../../packages/api/src/services/graph-indexer.js";
import { processFile } from "../../packages/api/src/services/file-processor.js";
import {
	enqueueGraphIndexing,
	enqueueSessionGraphIndexing,
	getIndexingQueueSize,
	enqueueProcessing,
	getQueueSize,
} from "../../packages/api/src/lib/queue.js";

beforeEach(() => {
	vi.mocked(indexFileGraph).mockReset().mockResolvedValue(undefined);
	vi.mocked(processFile).mockReset().mockResolvedValue(undefined);
});

describe("queue", () => {
	it("enqueueGraphIndexing calls indexFileGraph", async () => {
		vi.mocked(indexFileGraph).mockResolvedValue(undefined);

		enqueueGraphIndexing("file-1");

		// Wait for the queue to process
		await vi.waitFor(() => {
			expect(indexFileGraph).toHaveBeenCalledWith("file-1");
		});
	});

	it("enqueueSessionGraphIndexing enqueues all files", async () => {
		const fileIds = ["f1", "f2", "f3", "f4", "f5"];

		enqueueSessionGraphIndexing("session-1", fileIds);

		await vi.waitFor(() => {
			expect(indexFileGraph).toHaveBeenCalledTimes(5);
		});

		for (const id of fileIds) {
			expect(indexFileGraph).toHaveBeenCalledWith(id);
		}
	});

	it("getIndexingQueueSize returns pending + active", () => {
		// Create long-running tasks to observe queue size
		vi.mocked(indexFileGraph).mockImplementation(
			() => new Promise((resolve) => setTimeout(resolve, 100)),
		);

		enqueueGraphIndexing("f1");
		enqueueGraphIndexing("f2");
		enqueueGraphIndexing("f3");

		// Immediately after enqueuing, some should be pending
		const size = getIndexingQueueSize();
		expect(size).toBeGreaterThanOrEqual(1);
	});

	it("indexing queue concurrency is 2", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const completed: string[] = [];

		vi.mocked(indexFileGraph).mockImplementation(async (fileId: string) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 50));
			concurrent--;
			completed.push(fileId);
		});

		const ids = ["conc-f1", "conc-f2", "conc-f3", "conc-f4", "conc-f5"];
		for (const id of ids) {
			enqueueGraphIndexing(id);
		}

		await vi.waitFor(
			() => {
				expect(completed.length).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 5000 },
		);

		// Verify all our IDs completed
		for (const id of ids) {
			expect(completed).toContain(id);
		}

		expect(maxConcurrent).toBe(2);
	});

	it("processing and indexing queues are independent", async () => {
		let processingRunning = false;
		let indexingRanWhileProcessing = false;

		vi.mocked(processFile).mockImplementation(async () => {
			processingRunning = true;
			await new Promise((resolve) => setTimeout(resolve, 50));
			processingRunning = false;
		});

		vi.mocked(indexFileGraph).mockImplementation(async () => {
			if (processingRunning) indexingRanWhileProcessing = true;
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		enqueueProcessing("file-a");
		enqueueGraphIndexing("file-b");

		await vi.waitFor(
			() => {
				expect(processFile).toHaveBeenCalledTimes(1);
				expect(indexFileGraph).toHaveBeenCalledTimes(1);
			},
			{ timeout: 2000 },
		);

		// Indexing should have run while processing was still running (independent queues)
		expect(indexingRanWhileProcessing).toBe(true);
	});
});
