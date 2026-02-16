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
import { indexFileGraph } from "../../packages/api/src/services/graph-indexer.js";

const db = getDb();

beforeEach(async () => {
	await cleanDb(db);
	vi.mocked(chatCompletion).mockReset();
});

describe("indexFileGraph", () => {
	it("indexes lecture notes → creates concepts", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { files } = await seedPdeSession(db);
		const lectureFile = files[0]; // PDE_Lectures_Part1.pdf

		await indexFileGraph(lectureFile.id);

		const concepts = await db.concept.findMany({
			where: { sessionId: lectureFile.sessionId },
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

	it("indexes lecture notes → creates file-concept relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { files } = await seedPdeSession(db);
		const lectureFile = files[0];

		await indexFileGraph(lectureFile.id);

		const rels = await db.relationship.findMany({
			where: { sessionId: lectureFile.sessionId, sourceType: "file", sourceId: lectureFile.id },
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
		const { files } = await seedPdeSession(db);
		const pastPaper = files[6]; // PDE_2020.pdf

		await indexFileGraph(pastPaper.id);

		const rels = await db.relationship.findMany({
			where: { sessionId: pastPaper.sessionId, createdBy: "system" },
		});

		const questionRels = rels.filter((r) => r.sourceLabel?.startsWith("Q"));
		expect(questionRels.length).toBe(pastPaperResponse.question_concept_links.length);
	});

	it("indexes problem sheet → creates concept-concept links", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(problemSheetResponse));
		const { files } = await seedPdeSession(db);
		const sheet = files[2]; // PDE_Sheet_1.pdf

		await indexFileGraph(sheet.id);

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
		const { files } = await seedPdeSession(db);

		await indexFileGraph(files[0].id);

		const concepts = await db.concept.findMany({
			where: { sessionId: files[0].sessionId },
		});
		const names = concepts.map((c) => c.name);
		expect(names).toContain("Heat Equation");
		expect(names).not.toContain("heat equation");
	});

	it("reuses existing concepts (no duplicates)", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { files } = await seedPdeSession(db);

		// Index first file
		await indexFileGraph(files[0].id);
		const countAfterFirst = await db.concept.count({
			where: { sessionId: files[0].sessionId },
		});

		// Index second file with same concepts
		await indexFileGraph(files[1].id);
		const countAfterSecond = await db.concept.count({
			where: { sessionId: files[0].sessionId },
		});

		// Same concepts referenced → count should not double
		expect(countAfterSecond).toBe(countAfterFirst);
	});

	it("re-indexing deletes old system relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { files } = await seedPdeSession(db);

		await indexFileGraph(files[0].id);
		const relsAfterFirst = await db.relationship.count({
			where: { sessionId: files[0].sessionId, createdBy: "system" },
		});
		expect(relsAfterFirst).toBeGreaterThan(0);

		// Re-index same file with different response
		vi.mocked(chatCompletion).mockResolvedValue(
			JSON.stringify({
				concepts: [{ name: "New Concept Only", description: "test" }],
				file_concept_links: [{ conceptName: "New Concept Only", relationship: "covers", confidence: 0.9 }],
				concept_concept_links: [],
				question_concept_links: [],
			}),
		);

		await indexFileGraph(files[0].id);

		const systemRels = await db.relationship.findMany({
			where: { sessionId: files[0].sessionId, sourceId: files[0].id, createdBy: "system" },
		});

		// Only the new relationship should exist for this file
		expect(systemRels.length).toBe(1);
		expect(systemRels[0].targetLabel).toBe("New Concept Only");
	});

	it("re-indexing preserves non-system relationships", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { files, chunks } = await seedPdeSession(db);

		await indexFileGraph(files[0].id);

		// Manually create an amortised relationship
		const concept = await db.concept.findFirst({
			where: { sessionId: files[0].sessionId },
		});
		await db.relationship.create({
			data: {
				sessionId: files[0].sessionId,
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
		await indexFileGraph(files[0].id);

		const amortisedRels = await db.relationship.findMany({
			where: { sessionId: files[0].sessionId, createdBy: "amortised" },
		});
		expect(amortisedRels.length).toBe(1);
	});

	it("sets isGraphIndexed = true on completion", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { files } = await seedPdeSession(db);

		await indexFileGraph(files[0].id);

		const file = await db.file.findUnique({ where: { id: files[0].id } });
		expect(file?.isGraphIndexed).toBe(true);
	});

	it("skips file not yet content-indexed", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse));
		const { session } = await seedPdeSession(db);

		// Create a non-indexed file
		const unindexedFile = await db.file.create({
			data: {
				sessionId: session.id,
				filename: "not_indexed.pdf",
				type: "OTHER",
				rawPath: "/tmp/not_indexed.pdf",
				isIndexed: false,
			},
		});

		await indexFileGraph(unindexedFile.id);

		expect(chatCompletion).not.toHaveBeenCalled();
		const file = await db.file.findUnique({ where: { id: unindexedFile.id } });
		expect(file?.isGraphIndexed).toBe(false);
	});

	it("skips file not found", async () => {
		await indexFileGraph("nonexistent-id");
		expect(chatCompletion).not.toHaveBeenCalled();
	});

	it("handles LLM returning markdown-wrapped JSON", async () => {
		const wrapped = "```json\n" + JSON.stringify(lectureNotesResponse) + "\n```";
		vi.mocked(chatCompletion).mockResolvedValue(wrapped);
		const { files } = await seedPdeSession(db);

		await indexFileGraph(files[0].id);

		const concepts = await db.concept.findMany({
			where: { sessionId: files[0].sessionId },
		});
		expect(concepts.length).toBeGreaterThan(0);
	});

	it("handles LLM returning invalid JSON", async () => {
		vi.mocked(chatCompletion).mockResolvedValue("This is not JSON at all {{{");
		const { files } = await seedPdeSession(db);

		// Should not throw
		await indexFileGraph(files[0].id);

		const file = await db.file.findUnique({ where: { id: files[0].id } });
		expect(file?.isGraphIndexed).toBe(false);
	});

	it("handles LLM returning unknown concept names in links", async () => {
		vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(responseWithUnknownConcepts));
		const { files } = await seedPdeSession(db);

		await indexFileGraph(files[0].id);

		const rels = await db.relationship.findMany({
			where: { sessionId: files[0].sessionId, createdBy: "system" },
		});

		// Only the valid Heat Equation link should exist, not Quantum Field Theory/String Theory/Nonexistent
		const targetLabels = rels.map((r) => r.targetLabel);
		expect(targetLabels).toContain("Heat Equation");
		expect(targetLabels).not.toContain("Quantum Field Theory");
		expect(targetLabels).not.toContain("String Theory");
		expect(targetLabels).not.toContain("Nonexistent Concept");
	});

	it("full PDE session: index all 11 files sequentially", async () => {
		const { files, session } = await seedPdeSession(db);

		// Lecture notes get lectureNotesResponse, past papers get pastPaperResponse, sheets get problemSheetResponse
		vi.mocked(chatCompletion).mockImplementation(async (messages) => {
			const userMsg = messages.find((m) => m.role === "user")?.content || "";
			if (userMsg.includes("LECTURE_NOTES")) return JSON.stringify(lectureNotesResponse);
			if (userMsg.includes("PAST_PAPER")) return JSON.stringify(pastPaperResponse);
			return JSON.stringify(problemSheetResponse);
		});

		for (const file of files) {
			await indexFileGraph(file.id);
		}

		const concepts = await db.concept.findMany({ where: { sessionId: session.id } });
		const relationships = await db.relationship.findMany({ where: { sessionId: session.id } });

		// Should have concepts from all response types combined (deduplicated)
		expect(concepts.length).toBeGreaterThanOrEqual(8); // At least the lecture notes concepts
		expect(relationships.length).toBeGreaterThan(0);

		// Cross-file concept reuse: "Method Of Characteristics" should exist only once
		const mocConcepts = concepts.filter((c) => c.name === "Method Of Characteristics");
		expect(mocConcepts.length).toBe(1);

		// All files should be marked as graph-indexed
		const indexedFiles = await db.file.findMany({
			where: { sessionId: session.id, isGraphIndexed: true },
		});
		expect(indexedFiles.length).toBe(11);
	});
});
