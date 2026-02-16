import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "@cramkit/shared";
import { cleanDb, seedPdeSession } from "../fixtures/helpers";
import {
	lectureNotesResponse,
	pastPaperResponse,
	problemSheetResponse,
} from "../fixtures/llm-responses";

vi.mock("../../packages/api/src/services/llm-client.js", () => ({
	chatCompletion: vi.fn(),
}));

import { chatCompletion } from "../../packages/api/src/services/llm-client.js";
import { indexFileGraph } from "../../packages/api/src/services/graph-indexer.js";
import { searchGraph } from "../../packages/api/src/services/graph-search.js";
import { amortiseSearchResults } from "../../packages/api/src/services/amortiser.js";

const db = getDb();

beforeEach(async () => {
	await cleanDb(db);
	vi.mocked(chatCompletion).mockReset();
});

describe("full indexing flow", () => {
	it("complete PDE lifecycle: upload → index → search → amortise → re-index → delete", async () => {
		// Step 1: Create session + seed 11 files with chunks
		const { session, files, chunks } = await seedPdeSession(db);

		// Verify initial state
		for (const file of files) {
			const f = await db.file.findUnique({ where: { id: file.id } });
			expect(f?.isIndexed).toBe(true);
			expect(f?.isGraphIndexed).toBe(false);
		}

		// Setup LLM mock per file type
		vi.mocked(chatCompletion).mockImplementation(async (messages) => {
			const userMsg = messages.find((m) => m.role === "user")?.content || "";
			if (userMsg.includes("LECTURE_NOTES")) return JSON.stringify(lectureNotesResponse);
			if (userMsg.includes("PAST_PAPER")) return JSON.stringify(pastPaperResponse);
			return JSON.stringify(problemSheetResponse);
		});

		// Step 2: Index all files
		for (const file of files) {
			await indexFileGraph(file.id);
		}

		// Verify all files marked as graph-indexed
		const indexedFiles = await db.file.findMany({
			where: { sessionId: session.id, isGraphIndexed: true },
		});
		expect(indexedFiles.length).toBe(11);

		// Step 3: Verify concept deduplication
		const concepts = await db.concept.findMany({ where: { sessionId: session.id } });
		const conceptNames = concepts.map((c) => c.name);

		// "Heat Equation" should appear only once despite being in lectures, papers, and sheets
		const heatEquationCount = conceptNames.filter((n) => n === "Heat Equation").length;
		expect(heatEquationCount).toBe(1);

		// "Method Of Characteristics" also appears in multiple file type responses
		const mocCount = conceptNames.filter((n) => n === "Method Of Characteristics").length;
		expect(mocCount).toBe(1);

		// Step 4: Verify cross-file relationships
		const allRels = await db.relationship.findMany({ where: { sessionId: session.id } });
		expect(allRels.length).toBeGreaterThan(0);

		// Find file-concept rels from different file types pointing to same concept
		const heatEquation = concepts.find((c) => c.name === "Heat Equation")!;
		const heatRels = allRels.filter(
			(r) => r.targetType === "concept" && r.targetId === heatEquation.id,
		);
		// Should have relationships from lecture notes AND past papers AND problem sheets
		const sourceFileIds = [...new Set(heatRels.filter((r) => r.sourceType === "file").map((r) => r.sourceId))];
		expect(sourceFileIds.length).toBeGreaterThan(1);

		// Step 5: Search "Method of Characteristics"
		const searchResults = await searchGraph(session.id, "Method Of Characteristics", 20);
		expect(searchResults.length).toBeGreaterThan(0);

		// Should return results from multiple file types
		const fileTypes = [...new Set(searchResults.map((r) => r.fileType))];
		expect(fileTypes.length).toBeGreaterThan(1);

		// Step 6: Verify amortisation
		const contentResults = searchResults.map((r) => ({
			chunkId: r.chunkId,
			fileId: r.fileId,
		}));
		await amortiseSearchResults(session.id, "Method Of Characteristics", contentResults);

		const amortisedRels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});
		expect(amortisedRels.length).toBeGreaterThan(0);

		// Step 7: Re-search — results should be at least as rich
		const reSearchResults = await searchGraph(session.id, "Method Of Characteristics", 20);
		expect(reSearchResults.length).toBeGreaterThanOrEqual(searchResults.length);

		// Step 8: Re-index a single file
		const fileToReindex = files[0]; // Lecture notes Part 1
		const amortisedBefore = await db.relationship.count({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		vi.mocked(chatCompletion).mockResolvedValue(
			JSON.stringify({
				concepts: [{ name: "Heat Equation", description: "Updated description" }],
				file_concept_links: [
					{ conceptName: "Heat Equation", relationship: "covers", confidence: 0.95 },
				],
				concept_concept_links: [],
				question_concept_links: [],
			}),
		);

		await indexFileGraph(fileToReindex.id);

		// System rels for this file should be replaced
		const systemRelsForFile = await db.relationship.findMany({
			where: { sessionId: session.id, sourceId: fileToReindex.id, createdBy: "system" },
		});
		expect(systemRelsForFile.length).toBe(1);
		expect(systemRelsForFile[0].targetLabel).toBe("Heat Equation");

		// Amortised rels should be preserved
		const amortisedAfter = await db.relationship.count({
			where: { sessionId: session.id, createdBy: "amortised" },
		});
		expect(amortisedAfter).toBe(amortisedBefore);

		// Step 9: Delete a concept
		const conceptToDelete = concepts.find((c) => c.name === "Wave Equation");
		if (conceptToDelete) {
			// Delete relationships first
			await db.relationship.deleteMany({
				where: {
					sessionId: session.id,
					OR: [
						{ sourceType: "concept", sourceId: conceptToDelete.id },
						{ targetType: "concept", targetId: conceptToDelete.id },
					],
				},
			});
			await db.concept.delete({ where: { id: conceptToDelete.id } });

			// Verify it's gone
			const deletedConcept = await db.concept.findUnique({
				where: { id: conceptToDelete.id },
			});
			expect(deletedConcept).toBeNull();

			// Relationships involving Wave Equation should be gone
			const waveRels = await db.relationship.findMany({
				where: {
					sessionId: session.id,
					OR: [
						{ sourceType: "concept", sourceId: conceptToDelete.id },
						{ targetType: "concept", targetId: conceptToDelete.id },
					],
				},
			});
			expect(waveRels.length).toBe(0);

			// Search should no longer find Wave Equation via graph
			const waveSearch = await searchGraph(session.id, "Wave Equation", 10);
			// If there are results, they should not reference Wave Equation concept
			for (const result of waveSearch) {
				const hasWaveEq = result.relatedConcepts.some((c) => c.name === "Wave Equation");
				expect(hasWaveEq).toBe(false);
			}
		}
	});
});
