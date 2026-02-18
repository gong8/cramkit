import { mockLlmByResourceType, seedPdeSession, useTestDb } from "../fixtures/helpers.js";

vi.mock("../../packages/api/src/services/llm-client.js", () => ({
	chatCompletion: vi.fn(),
	getCliModel: vi.fn().mockReturnValue("sonnet"),
	LLM_MODEL: "sonnet",
	BLOCKED_BUILTIN_TOOLS: [],
}));

vi.mock("../../packages/api/src/services/extraction-agent.js", () => ({
	runExtractionAgent: vi.fn().mockImplementation(async (input: { resource: { type: string } }) => {
		const { chatCompletion: cc } = await import("../../packages/api/src/services/llm-client.js");
		const raw = await cc([{ role: "user", content: input.resource.type }]);
		const text = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
		return JSON.parse(text);
	}),
}));

import { amortiseSearchResults } from "../../packages/api/src/services/amortiser.js";
import { indexResourceGraph } from "../../packages/api/src/services/graph-indexer.js";
import { searchGraph } from "../../packages/api/src/services/graph-search.js";
import { chatCompletion } from "../../packages/api/src/services/llm-client.js";

const db = useTestDb();

beforeEach(() => {
	vi.mocked(chatCompletion).mockReset();
});

describe("full indexing flow", () => {
	it("complete PDE lifecycle: upload → index → search → amortise → re-index → delete", async () => {
		const { session, resources } = await seedPdeSession(db);

		for (const resource of resources) {
			const r = await db.resource.findUnique({ where: { id: resource.id } });
			expect(r?.isIndexed).toBe(true);
			expect(r?.isGraphIndexed).toBe(false);
		}

		vi.mocked(chatCompletion).mockImplementation(async (messages) =>
			mockLlmByResourceType(messages),
		);

		for (const resource of resources) {
			await indexResourceGraph(resource.id);
		}

		const indexedResources = await db.resource.findMany({
			where: { sessionId: session.id, isGraphIndexed: true },
		});
		expect(indexedResources.length).toBe(11);

		const concepts = await db.concept.findMany({ where: { sessionId: session.id } });
		const conceptNames = concepts.map((c) => c.name);

		expect(conceptNames.filter((n) => n === "Heat Equation").length).toBe(1);
		expect(conceptNames.filter((n) => n === "Method Of Characteristics").length).toBe(1);

		const allRels = await db.relationship.findMany({ where: { sessionId: session.id } });
		expect(allRels.length).toBeGreaterThan(0);

		const heatEquation = concepts.find((c) => c.name === "Heat Equation");
		expect(heatEquation).toBeDefined();
		const heatRels = allRels.filter(
			(r) => r.targetType === "concept" && r.targetId === heatEquation?.id,
		);
		const sourceResourceIds = [
			...new Set(heatRels.filter((r) => r.sourceType === "resource").map((r) => r.sourceId)),
		];
		expect(sourceResourceIds.length).toBeGreaterThan(1);

		const searchResults = await searchGraph(session.id, "Method Of Characteristics", 20);
		expect(searchResults.length).toBeGreaterThan(0);

		const resourceTypes = [...new Set(searchResults.map((r) => r.resourceType))];
		expect(resourceTypes.length).toBeGreaterThan(1);

		const contentResults = searchResults.map((r) => ({
			chunkId: r.chunkId,
			resourceId: r.resourceId,
		}));
		await amortiseSearchResults(session.id, "Method Of Characteristics", contentResults);

		const amortisedRels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});
		expect(amortisedRels.length).toBeGreaterThan(0);

		const reSearchResults = await searchGraph(session.id, "Method Of Characteristics", 20);
		expect(reSearchResults.length).toBeGreaterThanOrEqual(searchResults.length);

		const resourceToReindex = resources[0];
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

		await indexResourceGraph(resourceToReindex.id);

		const systemRelsForResource = await db.relationship.findMany({
			where: { sessionId: session.id, sourceId: resourceToReindex.id, createdBy: "system" },
		});
		expect(systemRelsForResource.length).toBe(1);
		expect(systemRelsForResource[0].targetLabel).toBe("Heat Equation");

		const amortisedAfter = await db.relationship.count({
			where: { sessionId: session.id, createdBy: "amortised" },
		});
		expect(amortisedAfter).toBe(amortisedBefore);

		const conceptToDelete = concepts.find((c) => c.name === "Wave Equation");
		if (conceptToDelete) {
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

			expect(await db.concept.findUnique({ where: { id: conceptToDelete.id } })).toBeNull();

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

			const waveSearch = await searchGraph(session.id, "Wave Equation", 10);
			for (const result of waveSearch) {
				const hasWaveEq = result.relatedConcepts.some((c) => c.name === "Wave Equation");
				expect(hasWaveEq).toBe(false);
			}
		}
	});
});
