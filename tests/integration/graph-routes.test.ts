import {
	createRouteApp,
	mockLlmByResourceType,
	seedPdeSession,
	useTestDb,
} from "../fixtures/helpers.js";
import { lectureNotesResponse } from "../fixtures/llm-responses.js";

vi.mock("../../packages/api/src/services/llm-client.js", () => ({
	chatCompletion: vi.fn(),
}));

vi.mock("../../packages/api/src/lib/queue.js", () => ({
	enqueueGraphIndexing: vi.fn(),
	enqueueSessionGraphIndexing: vi.fn().mockResolvedValue("batch-id"),
	enqueueProcessing: vi.fn(),
	getIndexingQueueSize: vi.fn().mockReturnValue(0),
	getSessionBatchStatus: vi.fn().mockResolvedValue(null),
	cancelSessionIndexing: vi.fn().mockResolvedValue(false),
	retryFailedJobs: vi.fn().mockResolvedValue(0),
	resumeInterruptedBatches: vi.fn().mockResolvedValue(undefined),
}));

import {
	enqueueGraphIndexing,
	enqueueSessionGraphIndexing,
} from "../../packages/api/src/lib/queue.js";
import { graphRoutes } from "../../packages/api/src/routes/graph.js";
import { indexResourceGraph } from "../../packages/api/src/services/graph-indexer.js";
import { chatCompletion } from "../../packages/api/src/services/llm-client.js";

const db = useTestDb();
const app = createRouteApp("/graph", graphRoutes);

beforeEach(() => {
	vi.mocked(chatCompletion).mockReset();
	vi.mocked(enqueueGraphIndexing).mockClear();
	vi.mocked(enqueueSessionGraphIndexing).mockClear();
});

function mockLlm(response: object) {
	vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(response));
}

describe("graph routes", () => {
	it("GET /graph/sessions/:id/concepts — empty session", async () => {
		const session = await db.session.create({ data: { name: "Empty" } });

		const res = await app.request(`/graph/sessions/${session.id}/concepts`);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("GET /graph/sessions/:id/concepts — after indexing", async () => {
		mockLlm(lectureNotesResponse);
		const { session, resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const res = await app.request(`/graph/sessions/${session.id}/concepts`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body.length).toBeGreaterThan(0);

		const names = body.map((c) => c.name);
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
	});

	it("GET /graph/concepts/:id — returns concept + relationships", async () => {
		mockLlm(lectureNotesResponse);
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concept = await db.concept.findFirst({ where: { name: "Heat Equation" } });
		const res = await app.request(`/graph/concepts/${concept?.id}`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.name).toBe("Heat Equation");
		expect(body).toHaveProperty("relationships");
		expect(Array.isArray(body.relationships)).toBe(true);
	});

	it("GET /graph/concepts/:id — 404 for missing concept", async () => {
		const res = await app.request("/graph/concepts/nonexistent");

		expect(res.status).toBe(404);
	});

	it("DELETE /graph/concepts/:id — removes concept + relationships", async () => {
		mockLlm(lectureNotesResponse);
		const { resources, session } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concept = await db.concept.findFirst({ where: { name: "Heat Equation" } });
		const res = await app.request(`/graph/concepts/${concept?.id}`, { method: "DELETE" });

		expect(res.status).toBe(200);

		expect(await db.concept.findUnique({ where: { id: concept?.id } })).toBeNull();

		const rels = await db.relationship.findMany({
			where: {
				sessionId: session.id,
				OR: [
					{ sourceType: "concept", sourceId: concept?.id },
					{ targetType: "concept", targetId: concept?.id },
				],
			},
		});
		expect(rels.length).toBe(0);
	});

	it("GET /graph/related — by concept", async () => {
		mockLlm(lectureNotesResponse);
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concept = await db.concept.findFirst({ where: { name: "Heat Equation" } });
		const res = await app.request(`/graph/related?type=concept&id=${concept?.id}`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body.length).toBeGreaterThan(0);
	});

	it("GET /graph/related — missing params → 400", async () => {
		const res = await app.request("/graph/related");

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toMatch(/type and id/i);
	});

	it("POST /graph/sessions/:id/index-resource — queues indexing", async () => {
		const { session, resources } = await seedPdeSession(db);

		const res = await app.request(`/graph/sessions/${session.id}/index-resource`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ resourceId: resources[0].id }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.resourceId).toBe(resources[0].id);
		expect(enqueueSessionGraphIndexing).toHaveBeenCalledWith(session.id, [resources[0].id]);
	});

	it("POST /graph/sessions/:id/index-resource — invalid body → 400", async () => {
		const session = await db.session.create({ data: { name: "Test" } });

		const res = await app.request(`/graph/sessions/${session.id}/index-resource`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
	});

	it("POST /graph/sessions/:id/index-all — queues unindexed resources", async () => {
		const { session } = await seedPdeSession(db);

		const res = await app.request(`/graph/sessions/${session.id}/index-all`, {
			method: "POST",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.queued).toBe(11);
		expect(enqueueSessionGraphIndexing).toHaveBeenCalled();
	});

	it("GET /graph/sessions/:id/index-status — returns progress", async () => {
		mockLlm(lectureNotesResponse);
		const { session, resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const res = await app.request(`/graph/sessions/${session.id}/index-status`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("total");
		expect(body).toHaveProperty("indexed");
		expect(body).toHaveProperty("inProgress");
		expect(body.total).toBe(11);
		expect(body.indexed).toBe(1);
	});

	it("full PDE flow: index-all → poll status → verify concepts", async () => {
		const { session, resources } = await seedPdeSession(db);

		vi.mocked(chatCompletion).mockImplementation(async (messages) =>
			mockLlmByResourceType(messages),
		);

		for (const resource of resources) {
			await indexResourceGraph(resource.id);
		}

		const statusRes = await app.request(`/graph/sessions/${session.id}/index-status`);
		const status = (await statusRes.json()) as Record<string, unknown>;
		expect(status.indexed).toBe(11);

		const conceptsRes = await app.request(`/graph/sessions/${session.id}/concepts`);
		const concepts = (await conceptsRes.json()) as Record<string, unknown>[];
		expect(concepts.length).toBeGreaterThanOrEqual(8);

		const moc = concepts.find((c) => c.name === "Method Of Characteristics");
		expect(moc).toBeDefined();
	});
});
