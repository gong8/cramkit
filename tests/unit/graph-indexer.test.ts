import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "@cramkit/shared";
import { cleanDb, seedPdeSession } from "../fixtures/helpers";
import {
	lectureNotesResponse,
	pastPaperResponse,
	problemSheetResponse,
	responseWithUnknownConcepts,
} from "../fixtures/llm-responses";

vi.mock("../../packages/api/src/services/llm-client.js", () => ({
	chatCompletion: vi.fn(),
}));

import { chatCompletion } from "../../packages/api/src/services/llm-client.js";
import { indexResourceGraph } from "../../packages/api/src/services/graph-indexer.js";

const db = getDb();

beforeEach(async () => {
	await cleanDb(db);
	vi.mocked(chatCompletion).mockReset();
});

describe("indexResourceGraph", () => {
	it("indexes lecture notes → creates concepts", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);
		const lectureResource = resources[0]; // PDE Lectures Part 1

		await indexResourceGraph(lectureResource.id);

		const concepts = await db.concept.findMany({
			where: { sessionId: lectureResource.sessionId },
		});

		expect(concepts.length).toBeGreaterThanOrEqual(lectureNotesResponse.concepts.length);
		const names = concepts.map((c) => c.name);
		expect(names).toContain("Method Of Characteristics");
		expect(names).toContain("Heat Equation");
		expect(names).toContain("Wave Equation");

		const heatEq = concepts.find((c) => c.name === "Heat Equation");
		expect(heatEq?.description).toBe("Parabolic PDE modelling diffusion");
		expect(heatEq?.aliases).toBe("diffusion equation");
	});

	it("indexes lecture notes → creates resource-concept relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);
		const lectureResource = resources[0];

		await indexResourceGraph(lectureResource.id);

		const rels = await db.relationship.findMany({
			where: {
				sessionId: lectureResource.sessionId,
				createdBy: "system",
				OR: [
					{ sourceType: "resource", sourceId: lectureResource.id },
					{ sourceType: "chunk" },
				],
			},
		});

		expect(rels.length).toBe(lectureNotesResponse.file_concept_links.length);
		for (const rel of rels) {
			expect(rel.targetType).toBe("concept");
			expect(rel.createdBy).toBe("system");
			expect(rel.confidence).toBeGreaterThan(0);
		}
	});

	it("indexes past paper → creates question-concept links", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(pastPaperResponse));
		const { resources } = await seedPdeSession(db);
		const pastPaper = resources[6]; // PDE 2020 Exam

		await indexResourceGraph(pastPaper.id);

		const rels = await db.relationship.findMany({
			where: { sessionId: pastPaper.sessionId, createdBy: "system" },
		});

		const questionRels = rels.filter((r) => r.sourceLabel?.startsWith("Q"));
		expect(questionRels.length).toBe(pastPaperResponse.question_concept_links.length);
	});

	it("indexes problem sheet → creates concept-concept links", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(problemSheetResponse));
		const { resources } = await seedPdeSession(db);
		const sheet = resources[2]; // PDE Problem Sheet 1

		await indexResourceGraph(sheet.id);

		const rels = await db.relationship.findMany({
			where: {
				sessionId: sheet.sessionId,
				sourceType: "concept",
				targetType: "concept",
				createdBy: "system",
			},
		});

		expect(rels.length).toBe(problemSheetResponse.concept_concept_links.length);
	});

	it("normalizes concept names to Title Case", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(
			JSON.stringify({
				concepts: [{ name: "heat equation", description: "test" }],
				file_concept_links: [],
				concept_concept_links: [],
				question_concept_links: [],
			}),
		);
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concepts = await db.concept.findMany({
			where: { sessionId: resources[0].sessionId },
		});
		const names = concepts.map((c) => c.name);
		expect(names).toContain("Heat Equation");
		expect(names).not.toContain("heat equation");
	});

	it("reuses existing concepts (no duplicates)", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);

		// Index first resource
		await indexResourceGraph(resources[0].id);
		const countAfterFirst = await db.concept.count({
			where: { sessionId: resources[0].sessionId },
		});

		// Index second resource with same concepts
		await indexResourceGraph(resources[1].id);
		const countAfterSecond = await db.concept.count({
			where: { sessionId: resources[0].sessionId },
		});

		// Same concepts referenced → count should not double
		expect(countAfterSecond).toBe(countAfterFirst);
	});

	it("re-indexing deletes old system relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);
		const relsAfterFirst = await db.relationship.count({
			where: { sessionId: resources[0].sessionId, createdBy: "system" },
		});
		expect(relsAfterFirst).toBeGreaterThan(0);

		// Re-index same resource with different response
		vi.mocked(chatCompletion).mockResolvedValue(
			JSON.stringify({
				concepts: [{ name: "New Concept Only", description: "test" }],
				file_concept_links: [{ conceptName: "New Concept Only", relationship: "covers", confidence: 0.9 }],
				concept_concept_links: [],
				question_concept_links: [],
			}),
		);

		await indexResourceGraph(resources[0].id);

		const systemRels = await db.relationship.findMany({
			where: { sessionId: resources[0].sessionId, sourceId: resources[0].id, createdBy: "system" },
		});

		// Only the new relationship should exist for this resource
		expect(systemRels.length).toBe(1);
		expect(systemRels[0].targetLabel).toBe("New Concept Only");
	});

	it("re-indexing preserves non-system relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources, chunks } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		// Manually create an amortised relationship
		const concept = await db.concept.findFirst({
			where: { sessionId: resources[0].sessionId },
		});
		await db.relationship.create({
			data: {
				sessionId: resources[0].sessionId,
				sourceType: "chunk",
				sourceId: chunks[0].id,
				targetType: "concept",
				targetId: concept!.id,
				relationship: "related_to",
				confidence: 0.6,
				createdBy: "amortised",
			},
		});

		// Re-index
		await indexResourceGraph(resources[0].id);

		const amortisedRels = await db.relationship.findMany({
			where: { sessionId: resources[0].sessionId, createdBy: "amortised" },
		});
		expect(amortisedRels.length).toBe(1);
	});

	it("sets isGraphIndexed = true on completion", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const resource = await db.resource.findUnique({ where: { id: resources[0].id } });
		expect(resource?.isGraphIndexed).toBe(true);
	});

	it("skips resource not yet content-indexed", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { session } = await seedPdeSession(db);

		// Create a non-indexed resource
		const unindexedResource = await db.resource.create({
			data: {
				sessionId: session.id,
				name: "Not Indexed",
				type: "OTHER",
				isIndexed: false,
			},
		});

		await expect(indexResourceGraph(unindexedResource.id)).rejects.toThrow("Not content-indexed yet");

		expect(chatCompletion).not.toHaveBeenCalled();
		const resource = await db.resource.findUnique({ where: { id: unindexedResource.id } });
		expect(resource?.isGraphIndexed).toBe(false);
	});

	it("skips resource not found", async () => {
		await expect(indexResourceGraph("nonexistent-id")).rejects.toThrow("Resource not found");
		expect(chatCompletion).not.toHaveBeenCalled();
	});

	it("handles LLM returning markdown-wrapped JSON", async () => {
		const wrapped = "```json\n" + JSON.stringify(lectureNotesResponse) + "\n```";
		vi.mocked(chatCompletion).mockResolvedValue(wrapped);
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const concepts = await db.concept.findMany({
			where: { sessionId: resources[0].sessionId },
		});
		expect(concepts.length).toBeGreaterThan(0);
	});

	it("handles LLM returning invalid JSON", async () => {
		vi.mocked(chatCompletion).mockResolvedValue("This is not JSON at all {{{");
		const { resources } = await seedPdeSession(db);

		// Should throw a GraphIndexError after exhausting retries
		await expect(indexResourceGraph(resources[0].id)).rejects.toThrow(/Giving up/);

		const resource = await db.resource.findUnique({ where: { id: resources[0].id } });
		expect(resource?.isGraphIndexed).toBe(false);
	});

	it("handles LLM returning unknown concept names in links", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(responseWithUnknownConcepts));
		const { resources } = await seedPdeSession(db);

		await indexResourceGraph(resources[0].id);

		const rels = await db.relationship.findMany({
			where: { sessionId: resources[0].sessionId, createdBy: "system" },
		});

		// Only the valid Heat Equation link should exist, not Quantum Field Theory/String Theory/Nonexistent
		const targetLabels = rels.map((r) => r.targetLabel);
		expect(targetLabels).toContain("Heat Equation");
		expect(targetLabels).not.toContain("Quantum Field Theory");
		expect(targetLabels).not.toContain("String Theory");
		expect(targetLabels).not.toContain("Nonexistent Concept");
	});

	it("full PDE session: index all 11 resources sequentially", async () => {
		const { resources, session } = await seedPdeSession(db);

		// Lecture notes get lectureNotesResponse, past papers get pastPaperResponse, sheets get problemSheetResponse
		vi.mocked(chatCompletion).mockImplementation(async (messages) => {
			const userMsg = messages.find((m) => m.role === "user")?.content || "";
			if (userMsg.includes("LECTURE_NOTES")) return JSON.stringify(lectureNotesResponse);
			if (userMsg.includes("PAST_PAPER")) return JSON.stringify(pastPaperResponse);
			return JSON.stringify(problemSheetResponse);
		});

		for (const resource of resources) {
			await indexResourceGraph(resource.id);
		}

		const concepts = await db.concept.findMany({ where: { sessionId: session.id } });
		const relationships = await db.relationship.findMany({ where: { sessionId: session.id } });

		// Should have concepts from all response types combined (deduplicated)
		expect(concepts.length).toBeGreaterThanOrEqual(8); // At least the lecture notes concepts
		expect(relationships.length).toBeGreaterThan(0);

		// Cross-resource concept reuse: "Method Of Characteristics" should exist only once
		const mocConcepts = concepts.filter((c) => c.name === "Method Of Characteristics");
		expect(mocConcepts.length).toBe(1);

		// All resources should be marked as graph-indexed
		const indexedResources = await db.resource.findMany({
			where: { sessionId: session.id, isGraphIndexed: true },
		});
		expect(indexedResources.length).toBe(11);
	});
});
