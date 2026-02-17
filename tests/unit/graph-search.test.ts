import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@cramkit/shared";
import { cleanDb } from "../fixtures/helpers";
import { searchGraph } from "../../packages/api/src/services/graph-search.js";

const db = getDb();

// Helper to seed a session with concepts, chunks, and relationships
async function seedGraphData() {
	const session = await db.session.create({
		data: { name: "PDE Test Session" },
	});

	const resource = await db.resource.create({
		data: {
			sessionId: session.id,
			name: "PDE Lectures",
			type: "LECTURE_NOTES",
			isIndexed: true,
		},
	});

	// Create multiple chunks
	const chunks = [];
	for (let i = 0; i < 5; i++) {
		chunks.push(
			await db.chunk.create({
				data: {
					resourceId: resource.id,
					index: i,
					title: `Section ${i + 1}`,
					content: `Content for section ${i + 1} about PDEs`,
				},
			}),
		);
	}

	// Create concepts
	const heatEq = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Heat Equation",
			description: "Parabolic PDE modelling diffusion",
			aliases: "diffusion equation",
		},
	});

	const waveEq = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Wave Equation",
			description: "Hyperbolic PDE for wave propagation",
		},
	});

	const sepVars = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Separation Of Variables",
			description: "Technique decomposing PDE into ODEs",
		},
	});

	// Create relationships: resource -> concept
	await db.relationship.create({
		data: {
			sessionId: session.id,
			sourceType: "resource",
			sourceId: resource.id,
			sourceLabel: resource.name,
			targetType: "concept",
			targetId: heatEq.id,
			targetLabel: "Heat Equation",
			relationship: "covers",
			createdBy: "system",
		},
	});

	// chunk -> concept
	await db.relationship.create({
		data: {
			sessionId: session.id,
			sourceType: "chunk",
			sourceId: chunks[0].id,
			targetType: "concept",
			targetId: waveEq.id,
			targetLabel: "Wave Equation",
			relationship: "covers",
			createdBy: "system",
		},
	});

	// chunk -> concept for separation of variables
	await db.relationship.create({
		data: {
			sessionId: session.id,
			sourceType: "chunk",
			sourceId: chunks[1].id,
			targetType: "concept",
			targetId: sepVars.id,
			targetLabel: "Separation Of Variables",
			relationship: "introduces",
			createdBy: "system",
		},
	});

	return { session, resource, chunks, concepts: { heatEq, waveEq, sepVars } };
}

beforeEach(async () => {
	await cleanDb(db);
});

describe("searchGraph", () => {
	it("finds chunks via concept name match", async () => {
		const { session } = await seedGraphData();

		const results = await searchGraph(session.id, "Wave Equation", 10);

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].source).toBe("graph");
	});

	it("finds chunks via concept alias match", async () => {
		const { session } = await seedGraphData();

		// "diffusion equation" is an alias for Heat Equation
		const results = await searchGraph(session.id, "diffusion equation", 10);

		expect(results.length).toBeGreaterThan(0);
	});

	it("finds chunks via concept description match", async () => {
		const { session } = await seedGraphData();

		// "wave propagation" appears in Wave Equation's description
		const results = await searchGraph(session.id, "wave propagation", 10);

		expect(results.length).toBeGreaterThan(0);
	});

	it("follows resource-concept → resource-chunks path", async () => {
		const { session, resource, chunks } = await seedGraphData();

		// Heat Equation is linked to the resource, so its chunks should be returned
		const results = await searchGraph(session.id, "Heat Equation", 10);

		expect(results.length).toBeGreaterThan(0);
		// Results should include chunks from the linked resource
		const resultResourceIds = results.map((r) => r.resourceId);
		expect(resultResourceIds).toContain(resource.id);
	});

	it("returns relatedConcepts annotation", async () => {
		const { session } = await seedGraphData();

		const results = await searchGraph(session.id, "Wave Equation", 10);

		expect(results.length).toBeGreaterThan(0);
		const withConcepts = results.filter((r) => r.relatedConcepts.length > 0);
		expect(withConcepts.length).toBeGreaterThan(0);
		expect(withConcepts[0].relatedConcepts[0]).toHaveProperty("name");
		expect(withConcepts[0].relatedConcepts[0]).toHaveProperty("relationship");
	});

	it("returns empty for no matches", async () => {
		const { session } = await seedGraphData();

		const results = await searchGraph(session.id, "quantum mechanics", 10);

		expect(results).toEqual([]);
	});

	it("respects limit parameter", async () => {
		const { session, resource, concepts } = await seedGraphData();

		// Add many more chunks linked to the same concept
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
		const { session, resource, chunks, concepts } = await seedGraphData();

		// Add a problem sheet resource with chunk linked to separation of variables
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
