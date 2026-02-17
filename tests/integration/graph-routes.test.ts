import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { getDb } from "@cramkit/shared";
import { cleanDb, seedPdeSession } from "../fixtures/helpers";
import { lectureNotesResponse, pastPaperResponse, problemSheetResponse } from "../fixtures/llm-responses";

vi.mock("../../packages/api/src/services/llm-client.js", () => ({
	chatCompletion: vi.fn(),
}));

vi.mock("../../packages/api/src/lib/queue.js", () => ({
	enqueueGraphIndexing: vi.fn(),
	enqueueSessionGraphIndexing: vi.fn(),
	enqueueProcessing: vi.fn(),
	getIndexingQueueSize: vi.fn().mockReturnValue(0),
	getSessionBatchStatus: vi.fn().mockReturnValue(null),
	cancelSessionIndexing: vi.fn().mockReturnValue(false),
}));

import { chatCompletion } from "../../packages/api/src/services/llm-client.js";
import { enqueueGraphIndexing, enqueueSessionGraphIndexing } from "../../packages/api/src/lib/queue.js";
import { indexResourceGraph } from "../../packages/api/src/services/graph-indexer.js";
import { graphRoutes } from "../../packages/api/src/routes/graph.js";

const db = getDb();

function getApp() {
	const app = new Hono();
	app.route("/graph", graphRoutes);
	return app;
}

beforeEach(async () => {
	await cleanDb(db);
	vi.mocked(chatCompletion).mockReset();
	vi.mocked(enqueueGraphIndexing).mockClear();
	vi.mocked(enqueueSessionGraphIndexing).mockClear();
});

describe("graph routes", () => {
	it("GET /graph/sessions/:id/concepts — empty session", async () => {
		const session = await db.session.create({ data: { name: "Empty" } });
		const app = getApp();

		const res = await app.request(`/graph/sessions/${session.id}/concepts`);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	it("GET /graph/sessions/:id/concepts — after indexing", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { session, resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const app = getApp();
		const res = await app.request(`/graph/sessions/${session.id}/concepts`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as any[];
		expect(body.length).toBeGreaterThan(0);

		// Should be sorted by name ascending
		const names = body.map((c: any) => c.name);
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
	});

	it("GET /graph/concepts/:id — returns concept + relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concept = await db.concept.findFirst({ where: { name: "Heat Equation" } });
		const app = getApp();
		const res = await app.request(`/graph/concepts/${concept!.id}`);

		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.name).toBe("Heat Equation");
		expect(body).toHaveProperty("relationships");
		expect(Array.isArray(body.relationships)).toBe(true);
	});

	it("GET /graph/concepts/:id — 404 for missing concept", async () => {
		const app = getApp();
		const res = await app.request("/graph/concepts/nonexistent");

		expect(res.status).toBe(404);
	});

	it("DELETE /graph/concepts/:id — removes concept + relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources, session } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concept = await db.concept.findFirst({ where: { name: "Heat Equation" } });
		const app = getApp();
		const res = await app.request(`/graph/concepts/${concept!.id}`, { method: "DELETE" });

		expect(res.status).toBe(200);

		// Concept should be gone
		const deleted = await db.concept.findUnique({ where: { id: concept!.id } });
		expect(deleted).toBeNull();

		// Relationships involving this concept should be gone
		const rels = await db.relationship.findMany({
			where: {
				sessionId: session.id,
				OR: [
					{ sourceType: "concept", sourceId: concept!.id },
					{ targetType: "concept", targetId: concept!.id },
				],
			},
		});
		expect(rels.length).toBe(0);
	});

	it("GET /graph/related — by concept", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concept = await db.concept.findFirst({ where: { name: "Heat Equation" } });
		const app = getApp();
		const res = await app.request(`/graph/related?type=concept&id=${concept!.id}`);

		expect(res.status).toBe(200);
		const body = await res.json() as any[];
		expect(body.length).toBeGreaterThan(0);
	});

	it("GET /graph/related — missing params → 400", async () => {
		const app = getApp();
		const res = await app.request("/graph/related");

		expect(res.status).toBe(400);
		const body = await res.json() as any;
		expect(body.error).toMatch(/type and id/i);
	});

	it("POST /graph/sessions/:id/index-resource — queues indexing", async () => {
		const { session, resources } = await seedPdeSession(db);

		const app = getApp();
		const res = await app.request(`/graph/sessions/${session.id}/index-resource`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ resourceId: resources[0].id }),
		});

		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.ok).toBe(true);
		expect(body.resourceId).toBe(resources[0].id);
		expect(enqueueGraphIndexing).toHaveBeenCalledWith(resources[0].id);
	});

	it("POST /graph/sessions/:id/index-resource — invalid body → 400", async () => {
		const session = await db.session.create({ data: { name: "Test" } });
		const app = getApp();

		const res = await app.request(`/graph/sessions/${session.id}/index-resource`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
	});

	it("POST /graph/sessions/:id/index-all — queues unindexed resources", async () => {
		const { session } = await seedPdeSession(db);

		const app = getApp();
		const res = await app.request(`/graph/sessions/${session.id}/index-all`, {
			method: "POST",
		});

		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.ok).toBe(true);
		// All 11 resources are isIndexed but not isGraphIndexed
		expect(body.queued).toBe(11);
		expect(enqueueSessionGraphIndexing).toHaveBeenCalled();
	});

	it("GET /graph/sessions/:id/index-status — returns progress", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { session, resources } = await seedPdeSession(db);

		// Index one resource directly
		await indexResourceGraph(resources[0].id);

		const app = getApp();
		const res = await app.request(`/graph/sessions/${session.id}/index-status`);

		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body).toHaveProperty("total");
		expect(body).toHaveProperty("indexed");
		expect(body).toHaveProperty("inProgress");
		expect(body.total).toBe(11);
		expect(body.indexed).toBe(1);
	});

	it("full PDE flow: index-all → poll status → verify concepts", async () => {
		const { session, resources } = await seedPdeSession(db);

		vi.mocked(chatCompletion).mockImplementation(async (messages) => {
			const userMsg = messages.find((m) => m.role === "user")?.content || "";
			if (userMsg.includes("LECTURE_NOTES")) return JSON.stringify(lectureNotesResponse);
			if (userMsg.includes("PAST_PAPER")) return JSON.stringify(pastPaperResponse);
			return JSON.stringify(problemSheetResponse);
		});

		// Index all resources directly (not via queue to avoid timing issues)
		for (const resource of resources) {
			await indexResourceGraph(resource.id);
		}

		const app = getApp();

		// Check status
		const statusRes = await app.request(`/graph/sessions/${session.id}/index-status`);
		const status = await statusRes.json() as any;
		expect(status.indexed).toBe(11);

		// Check concepts
		const conceptsRes = await app.request(`/graph/sessions/${session.id}/concepts`);
		const concepts = await conceptsRes.json() as any[];
		expect(concepts.length).toBeGreaterThanOrEqual(8);

		// Verify Method Of Characteristics exists
		const moc = concepts.find((c: any) => c.name === "Method Of Characteristics");
		expect(moc).toBeDefined();
	});
});
