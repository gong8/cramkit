import { z } from "zod";
import { apiClient } from "../lib/api-client.js";
import { resourceId, sessionId } from "./params.js";

interface ResourceInfo {
	id: string;
	name: string;
	type: string;
	label: string | null;
	files: Array<{ id: string; filename: string; role: string }>;
}

function listResourcesByType(type: string, companionLabel: string, companionRole: string) {
	return async ({ sessionId }: { sessionId: string }) => {
		const resources = (await apiClient.listResources(sessionId)) as ResourceInfo[];
		return resources
			.filter((r) => r.type === type)
			.map((r) => ({
				resourceId: r.id,
				name: r.name,
				hasCompanion: r.label === companionLabel || r.files.some((f) => f.role === companionRole),
				files: r.files.map((f) => ({ id: f.id, filename: f.filename, role: f.role })),
			}));
	};
}

export const paperTools = {
	list_past_papers: {
		description: "List all past paper resources and whether they have mark schemes for a session.",
		parameters: z.object({ sessionId }),
		execute: listResourcesByType("PAST_PAPER", "includes_mark_scheme", "MARK_SCHEME"),
	},

	get_past_paper: {
		description: "Get a specific past paper's content.",
		parameters: z.object({ resourceId }),
		execute: async ({ resourceId }: { resourceId: string }) =>
			apiClient.getResourceContent(resourceId),
	},

	list_problem_sheets: {
		description: "List all problem sheet resources and whether they have solutions for a session.",
		parameters: z.object({ sessionId }),
		execute: listResourcesByType("PROBLEM_SHEET", "includes_solutions", "SOLUTIONS"),
	},
};
