import { getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDb } from "../fixtures/helpers";

vi.mock("../../packages/api/src/services/llm-client.js", () => ({
	chatCompletion: vi.fn(),
}));

import { searchRoutes } from "../../packages/api/src/routes/search.js";

const db = getDb();

function getApp() {
	const app = new Hono();
	app.route("/search", searchRoutes);
	return app;
}

/** Seed a session with content + graph data for search testing */
async function seedSearchData() {
	const session = await db.session.create({ data: { name: "Search Test" } });

	const resource = await db.resource.create({
		data: {
			sessionId: session.id,
			name: "PDE Lectures",
			type: "LECTURE_NOTES",
			isIndexed: true,
		},
	});

	// Create chunks with searchable content
	const chunkWithContent = await db.chunk.create({
		data: {
			resourceId: resource.id,
			index: 0,
			title: "Heat Equation Introduction",
			content: "The heat equation is a parabolic PDE that models diffusion processes.",
			keywords: "heat equation, diffusion",
		},
	});

	const chunkGraphOnly = await db.chunk.create({
		data: {
			resourceId: resource.id,
			index: 1,
			title: "Section 2",
			content: "This section covers some advanced mathematical techniques for boundary analysis.",
		},
	});

	const chunkBoth = await db.chunk.create({
		data: {
			resourceId: resource.id,
			index: 2,
			title: "Wave Equation",
			content: "The wave equation describes wave propagation phenomena.",
			keywords: "wave equation",
		},
	});

	// Create concepts
	const heatConcept = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Heat Equation",
			description: "Parabolic PDE modelling diffusion",
		},
	});

	const waveConcept = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Wave Equation",
			description: "Hyperbolic PDE for wave propagation",
		},
	});

	// Link graph-only chunk to concept (not found via content search)
	await db.relationship.create({
		data: {
			sessionId: session.id,
			sourceType: "chunk",
			sourceId: chunkGraphOnly.id,
			targetType: "concept",
			targetId: heatConcept.id,
			targetLabel: "Heat Equation",
			relationship: "covers",
			createdBy: "system",
		},
	});

	// Link chunkBoth to wave concept (also findable via content search)
	await db.relationship.create({
		data: {
			sessionId: session.id,
			sourceType: "chunk",
			sourceId: chunkBoth.id,
			targetType: "concept",
			targetId: waveConcept.id,
			targetLabel: "Wave Equation",
			relationship: "covers",
			createdBy: "system",
		},
	});

	return {
		session,
		resource,
		chunkWithContent,
		chunkGraphOnly,
		chunkBoth,
		heatConcept,
		waveConcept,
	};
}

beforeEach(async () => {
	// Allow any lingering async amortisation from previous test to settle
	await new Promise((r) => setTimeout(r, 50));
	await cleanDb(db);
});

describe("search routes", () => {
	it("content-only search (no graph data)", async () => {
		const { session } = await seedSearchData();
		const app = getApp();

		// Search for "diffusion" — matches chunkWithContent via content but no direct concept match
		const res = await app.request(`/search/sessions/${session.id}/search?q=diffusion`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body.length).toBeGreaterThan(0);

		// The content-matched result should have source "content" or "both"
		// (it might be "both" if the concept alias "diffusion" matches in graph too)
		const sources = body.map((r) => r.source);
		expect(sources.some((s: string) => s === "content" || s === "both")).toBe(true);
	});

	it("graph-only search (query matches concept but not chunk text)", async () => {
		const { session, chunkGraphOnly } = await seedSearchData();
		const app = getApp();

		// "Heat Equation" matches the concept, which links to chunkGraphOnly
		// chunkGraphOnly content is "advanced mathematical techniques" — doesn't contain "Heat Equation"
		// But chunkWithContent DOES contain "heat equation" in its content
		// So we test with a term that only matches via graph
		const res = await app.request(`/search/sessions/${session.id}/search?q=Heat Equation`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body.length).toBeGreaterThan(0);

		// chunkGraphOnly should appear (via graph path)
		const graphOnlyResult = body.find((r) => r.chunkId === chunkGraphOnly.id);
		expect(graphOnlyResult).toBeDefined();
	});

	it("both sources (chunk text matches AND concept matches)", async () => {
		const { session, chunkBoth } = await seedSearchData();
		const app = getApp();

		// "Wave Equation" matches both: chunk content AND concept
		const res = await app.request(`/search/sessions/${session.id}/search?q=Wave Equation`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];

		const bothResult = body.find((r) => r.chunkId === chunkBoth.id);
		expect(bothResult).toBeDefined();
		expect(bothResult.source).toBe("both");
		expect(bothResult.relatedConcepts).toBeDefined();
		expect(bothResult.relatedConcepts.length).toBeGreaterThan(0);
	});

	it("deduplication", async () => {
		const { session, chunkBoth } = await seedSearchData();
		const app = getApp();

		const res = await app.request(`/search/sessions/${session.id}/search?q=Wave Equation`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];

		// chunkBoth should appear only once despite matching content + graph
		const matches = body.filter((r) => r.chunkId === chunkBoth.id);
		expect(matches.length).toBe(1);
	});

	it("amortisation fires after search", async () => {
		const { session } = await seedSearchData();
		const app = getApp();

		await app.request(`/search/sessions/${session.id}/search?q=Heat Equation`);

		// Wait a bit for async amortisation
		await new Promise((resolve) => setTimeout(resolve, 200));

		const amortisedRels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		// Should have created amortised relationships
		expect(amortisedRels.length).toBeGreaterThan(0);
	});

	it("respects limit across merged results", async () => {
		const session = await db.session.create({ data: { name: "Limit Test" } });
		const resource = await db.resource.create({
			data: {
				sessionId: session.id,
				name: "Big Resource",
				type: "LECTURE_NOTES",
				isIndexed: true,
			},
		});

		// Create 10 chunks with "PDE" in content
		for (let i = 0; i < 10; i++) {
			await db.chunk.create({
				data: {
					resourceId: resource.id,
					index: i,
					content: `PDE content section ${i}`,
				},
			});
		}

		const app = getApp();
		const res = await app.request(`/search/sessions/${session.id}/search?q=PDE&limit=3`);

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body.length).toBeLessThanOrEqual(3);
	});
});
