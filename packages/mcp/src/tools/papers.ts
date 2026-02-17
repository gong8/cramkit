import { createLogger } from "@cramkit/shared";
import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

const log = createLogger("mcp");

interface ResourceInfo {
	id: string;
	name: string;
	type: string;
	label: string | null;
	files: Array<{ id: string; filename: string; role: string }>;
}

export const paperTools = {
	list_past_papers: {
		description: "List all past paper resources and whether they have mark schemes for a session.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			log.info(`list_past_papers — session=${sessionId}`);
			const resources = (await apiClient.listResources(sessionId)) as ResourceInfo[];

			const papers = resources.filter((r) => r.type === "PAST_PAPER");

			log.info(`list_past_papers — found ${papers.length} past papers`);
			return JSON.stringify(
				papers.map((paper) => {
					const hasMarkScheme =
						paper.label === "includes_mark_scheme" ||
						paper.files.some((f) => f.role === "MARK_SCHEME");
					return {
						resourceId: paper.id,
						name: paper.name,
						hasMarkScheme,
						files: paper.files.map((f) => ({
							id: f.id,
							filename: f.filename,
							role: f.role,
						})),
					};
				}),
				null,
				2,
			);
		},
	},

	get_past_paper: {
		description: "Get a specific past paper's content.",
		parameters: z.object({
			resourceId: z.string().describe("The resource ID of the past paper"),
		}),
		execute: async ({ resourceId }: { resourceId: string }) => {
			log.info(`get_past_paper — ${resourceId}`);
			const resource = await apiClient.getResourceContent(resourceId);
			return JSON.stringify(resource, null, 2);
		},
	},

	list_problem_sheets: {
		description: "List all problem sheet resources and whether they have solutions for a session.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			log.info(`list_problem_sheets — session=${sessionId}`);
			const resources = (await apiClient.listResources(sessionId)) as ResourceInfo[];

			const sheets = resources.filter((r) => r.type === "PROBLEM_SHEET");

			log.info(`list_problem_sheets — found ${sheets.length} problem sheets`);
			return JSON.stringify(
				sheets.map((sheet) => {
					const hasSolutions =
						sheet.label === "includes_solutions" || sheet.files.some((f) => f.role === "SOLUTIONS");
					return {
						resourceId: sheet.id,
						name: sheet.name,
						hasSolutions,
						files: sheet.files.map((f) => ({
							id: f.id,
							filename: f.filename,
							role: f.role,
						})),
					};
				}),
				null,
				2,
			);
		},
	},
};
