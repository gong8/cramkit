import { getDb, initDb } from "@cramkit/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDb } from "../fixtures/helpers.js";

vi.mock("../../packages/api/src/services/graph-indexer.js", () => ({
	indexResourceGraph: vi.fn().mockResolvedValue(undefined),
	GraphIndexError: class GraphIndexError extends Error {
		constructor(
			message: string,
			public readonly errorType: string,
			public readonly resourceId: string,
		) {
			super(message);
			this.name = "GraphIndexError";
		}
	},
}));

vi.mock("../../packages/api/src/services/resource-processor.js", () => ({
	processResource: vi.fn().mockResolvedValue(undefined),
}));

import {
	enqueueGraphIndexing,
	enqueueProcessing,
	enqueueSessionGraphIndexing,
	getIndexingQueueSize,
} from "../../packages/api/src/lib/queue.js";
import { indexResourceGraph } from "../../packages/api/src/services/graph-indexer.js";
import { processResource } from "../../packages/api/src/services/resource-processor.js";

beforeEach(async () => {
	vi.mocked(indexResourceGraph).mockReset().mockResolvedValue(undefined);
	vi.mocked(processResource).mockReset().mockResolvedValue(undefined);
	await initDb();
	const db = getDb();
	await cleanDb(db);
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
		const db = getDb();

		// Create session + resources so DB operations succeed
		const session = await db.session.create({ data: { name: "Test" } });
		const resourceIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await db.resource.create({
				data: {
					sessionId: session.id,
					name: `Resource ${i}`,
					type: "LECTURE_NOTES",
					isIndexed: true,
				},
			});
			resourceIds.push(r.id);
		}

		await enqueueSessionGraphIndexing(session.id, resourceIds);

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
