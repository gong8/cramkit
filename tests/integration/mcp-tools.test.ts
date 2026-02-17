vi.mock("../../packages/mcp/src/lib/api-client.js", () => ({
	apiClient: {
		createRelationship: vi.fn().mockResolvedValue({ id: "rel-1", ok: true }),
		getRelated: vi.fn().mockResolvedValue([{ id: "rel-1" }]),
		listConcepts: vi.fn().mockResolvedValue([{ id: "c-1", name: "Heat Equation" }]),
	},
}));

import { apiClient } from "../../packages/mcp/src/lib/api-client.js";
import { graphTools } from "../../packages/mcp/src/tools/graph.js";

beforeEach(() => {
	for (const method of ["createRelationship", "getRelated", "listConcepts"] as const) {
		vi.mocked(apiClient[method]).mockClear();
	}
});

describe("MCP graph tools", () => {
	it("create_link calls createRelationship with createdBy: 'claude'", async () => {
		const result = await graphTools.create_link.execute({
			sessionId: "session-1",
			sourceType: "chunk",
			sourceId: "chunk-1",
			targetType: "concept",
			targetId: "concept-1",
			relationship: "covers",
			confidence: 0.9,
		});

		expect(apiClient.createRelationship).toHaveBeenCalledWith("session-1", {
			sourceType: "chunk",
			sourceId: "chunk-1",
			sourceLabel: undefined,
			targetType: "concept",
			targetId: "concept-1",
			targetLabel: undefined,
			relationship: "covers",
			confidence: 0.9,
			createdBy: "claude",
		});

		expect(result).toHaveProperty("id");
	});

	it("get_related calls getRelated with params", async () => {
		const result = await graphTools.get_related.execute({
			type: "concept",
			id: "concept-1",
			relationshipType: "prerequisite",
		});

		expect(apiClient.getRelated).toHaveBeenCalledWith("concept", "concept-1", "prerequisite");
		expect(result).toBeInstanceOf(Array);
	});

	it("list_concepts calls listConcepts", async () => {
		const result = await graphTools.list_concepts.execute({ sessionId: "session-1" });

		expect(apiClient.listConcepts).toHaveBeenCalledWith("session-1");
		expect(result).toBeInstanceOf(Array);
		expect(result[0].name).toBe("Heat Equation");
	});

	it("all tools have valid Zod parameter schemas", () => {
		for (const [_name, tool] of Object.entries(graphTools)) {
			expect(tool.parameters).toBeDefined();
			expect(typeof tool.parameters.safeParse).toBe("function");
		}

		expect(
			graphTools.create_link.parameters.safeParse({
				sessionId: "s1",
				sourceType: "chunk",
				sourceId: "c1",
				targetType: "concept",
				targetId: "co1",
				relationship: "covers",
			}).success,
		).toBe(true);

		expect(
			graphTools.get_related.parameters.safeParse({
				type: "concept",
				id: "c1",
			}).success,
		).toBe(true);

		expect(
			graphTools.list_concepts.parameters.safeParse({
				sessionId: "s1",
			}).success,
		).toBe(true);
	});
});
