import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../packages/api/src/services/graph-indexer.js", () => ({
	indexResourceGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../packages/api/src/services/resource-processor.js", () => ({
	processResource: vi.fn().mockResolvedValue(undefined),
}));

import { indexResourceGraph } from "../../packages/api/src/services/graph-indexer.js";
import { processResource } from "../../packages/api/src/services/resource-processor.js";
import {
	enqueueGraphIndexing,
	enqueueSessionGraphIndexing,
	getIndexingQueueSize,
	enqueueProcessing,
	getQueueSize,
} from "../../packages/api/src/lib/queue.js";

beforeEach(() => {
	vi.mocked(indexResourceGraph).mockReset().mockResolvedValue(undefined);
	vi.mocked(processResource).mockReset().mockResolvedValue(undefined);
});

describe("queue", () => {
	it("enqueueGraphIndexing calls indexResourceGraph", async () => {
		vi.mocked(indexResourceGraph).mockResolvedValue(undefined);

		enqueueGraphIndexing("resource-1");

		// Wait for the queue to process
		await vi.waitFor(() => {
			expect(indexResourceGraph).toHaveBeenCalledWith("resource-1");
		});
	});

	it("enqueueSessionGraphIndexing enqueues all resources", async () => {
		const resourceIds = ["r1", "r2", "r3", "r4", "r5"];

		enqueueSessionGraphIndexing("session-1", resourceIds);

		await vi.waitFor(() => {
			expect(indexResourceGraph).toHaveBeenCalledTimes(5);
		});

		for (const id of resourceIds) {
			expect(indexResourceGraph).toHaveBeenCalledWith(id);
		}
	});

	it("getIndexingQueueSize returns pending + active", () => {
		// Create long-running tasks to observe queue size
		vi.mocked(indexResourceGraph).mockImplementation(
			() => new Promise((resolve) => setTimeout(resolve, 100)),
		);

		enqueueGraphIndexing("r1");
		enqueueGraphIndexing("r2");
		enqueueGraphIndexing("r3");

		// Immediately after enqueuing, some should be pending
		const size = getIndexingQueueSize();
		expect(size).toBeGreaterThanOrEqual(1);
	});

	it("indexing queue concurrency is 1", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const completed: string[] = [];

		vi.mocked(indexResourceGraph).mockImplementation(async (resourceId: string) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 20));
			concurrent--;
			completed.push(resourceId);
		});

		const ids = ["conc-r1", "conc-r2", "conc-r3"];
		for (const id of ids) {
			enqueueGraphIndexing(id);
		}

		await vi.waitFor(
			() => {
				expect(completed).toEqual(expect.arrayContaining(ids));
			},
			{ timeout: 5000 },
		);

		// Concurrency reduced to 1 to prevent SQLite write contention
		expect(maxConcurrent).toBe(1);
	});

	it("processing and indexing queues are independent", async () => {
		let processingRunning = false;
		let indexingRanWhileProcessing = false;

		vi.mocked(processResource).mockImplementation(async () => {
			processingRunning = true;
			await new Promise((resolve) => setTimeout(resolve, 50));
			processingRunning = false;
		});

		vi.mocked(indexResourceGraph).mockImplementation(async () => {
			if (processingRunning) indexingRanWhileProcessing = true;
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		enqueueProcessing("resource-a");
		enqueueGraphIndexing("resource-b");

		await vi.waitFor(
			() => {
				expect(processResource).toHaveBeenCalledWith("resource-a");
				expect(indexResourceGraph).toHaveBeenCalledWith("resource-b");
			},
			{ timeout: 2000 },
		);

		// Indexing should have run while processing was still running (independent queues)
		expect(indexingRanWhileProcessing).toBe(true);
	});
});
