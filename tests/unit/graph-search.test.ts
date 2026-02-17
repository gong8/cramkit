import { searchGraph } from "../../packages/api/src/services/graph-search.js";
import { seedGraphData, useTestDb } from "../fixtures/helpers.js";

const db = useTestDb();

describe("searchGraph", () => {
	it("finds chunks via concept name match", async () => {
		const { session } = await seedGraphData(db);

		const results = await searchGraph(session.id, "Wave Equation", 10);

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].source).toBe("graph");
	});

	it("finds chunks via concept alias match", async () => {
		const { session } = await seedGraphData(db);

		const results = await searchGraph(session.id, "diffusion equation", 10);

		expect(results.length).toBeGreaterThan(0);
	});

	it("finds chunks via concept description match", async () => {
		const { session } = await seedGraphData(db);

		const results = await searchGraph(session.id, "wave propagation", 10);

		expect(results.length).toBeGreaterThan(0);
	});

	it("follows resource-concept → resource-chunks path", async () => {
		const { session, resource } = await seedGraphData(db);

		const results = await searchGraph(session.id, "Heat Equation", 10);

		expect(results.length).toBeGreaterThan(0);
		const resultResourceIds = results.map((r) => r.resourceId);
		expect(resultResourceIds).toContain(resource.id);
	});

	it("returns relatedConcepts annotation", async () => {
		const { session } = await seedGraphData(db);

		const results = await searchGraph(session.id, "Wave Equation", 10);

		expect(results.length).toBeGreaterThan(0);
		const withConcepts = results.filter((r) => r.relatedConcepts.length > 0);
		expect(withConcepts.length).toBeGreaterThan(0);
		expect(withConcepts[0].relatedConcepts[0]).toHaveProperty("name");
		expect(withConcepts[0].relatedConcepts[0]).toHaveProperty("relationship");
	});

	it("returns empty for no matches", async () => {
		const { session } = await seedGraphData(db);

		const results = await searchGraph(session.id, "quantum mechanics", 10);

		expect(results).toEqual([]);
	});

	it("respects limit parameter", async () => {
		const { session, resource, concepts } = await seedGraphData(db);

		for (let i = 5; i < 25; i++) {
			const chunk = await db.chunk.create({
				data: {
					resourceId: resource.id,
					index: i,
					title: `Extra Section ${i}`,
					content: `Extra content ${i}`,
				},
			});
			await db.relationship.create({
				data: {
					sessionId: session.id,
					sourceType: "chunk",
					sourceId: chunk.id,
					targetType: "concept",
					targetId: concepts.waveEq.id,
					targetLabel: "Wave Equation",
					relationship: "covers",
					createdBy: "system",
				},
			});
		}

		const results = await searchGraph(session.id, "Wave Equation", 5);

		expect(results.length).toBeLessThanOrEqual(5);
	});

	it("full PDE graph: search 'Separation Of Variables'", async () => {
		const { session, concepts } = await seedGraphData(db);

		const sheetResource = await db.resource.create({
			data: {
				sessionId: session.id,
				name: "PDE Sheet 1",
				type: "PROBLEM_SHEET",
				isIndexed: true,
			},
		});
		const sheetChunk = await db.chunk.create({
			data: {
				resourceId: sheetResource.id,
				index: 0,
				title: "Problem Sheet 1",
				content: "Apply separation of variables to the heat equation",
			},
		});
		await db.relationship.create({
			data: {
				sessionId: session.id,
				sourceType: "chunk",
				sourceId: sheetChunk.id,
				targetType: "concept",
				targetId: concepts.sepVars.id,
				targetLabel: "Separation Of Variables",
				relationship: "applies",
				createdBy: "system",
			},
		});

		const results = await searchGraph(session.id, "Separation Of Variables", 10);

		expect(results.length).toBeGreaterThanOrEqual(2);
		const resourceTypes = results.map((r) => r.resourceType);
		expect(resourceTypes).toContain("LECTURE_NOTES");
		expect(resourceTypes).toContain("PROBLEM_SHEET");
	});
});
