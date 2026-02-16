import { createLogger } from "@cramkit/shared";
import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

const log = createLogger("mcp");

export const paperTools = {
	list_past_papers: {
		description: "List all past papers and their associated mark schemes for a session.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			log.info(`list_past_papers — session=${sessionId}`);
			const session = (await apiClient.getSession(sessionId)) as {
				files?: Array<{ id: string; type: string; label: string | null; filename: string }>;
			};
			const files = session.files || [];
			const papers = files.filter((f) => f.type === "PAST_PAPER");
			const markSchemes = files.filter((f) => f.type === "MARK_SCHEME");

			log.info(`list_past_papers — found ${papers.length} papers, ${markSchemes.length} mark schemes`);
			return JSON.stringify(
				papers.map((paper) => ({
					paperId: paper.id,
					label: paper.label || paper.filename,
					hasMarkScheme: markSchemes.some((ms) => ms.label?.includes(paper.label || "") || false),
				})),
				null,
				2,
			);
		},
	},

	get_past_paper: {
		description: "Get a specific past paper's content.",
		parameters: z.object({
			fileId: z.string().describe("The file ID of the past paper"),
		}),
		execute: async ({ fileId }: { fileId: string }) => {
			log.info(`get_past_paper — ${fileId}`);
			const file = await apiClient.getFileContent(fileId);
			return JSON.stringify(file, null, 2);
		},
	},

	list_problem_sheets: {
		description: "List all problem sheets and their solutions for a session.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			log.info(`list_problem_sheets — session=${sessionId}`);
			const session = (await apiClient.getSession(sessionId)) as {
				files?: Array<{ id: string; type: string; label: string | null; filename: string }>;
			};
			const files = session.files || [];
			const sheets = files.filter((f) => f.type === "PROBLEM_SHEET");
			const solutions = files.filter((f) => f.type === "PROBLEM_SHEET_SOLUTIONS");

			log.info(`list_problem_sheets — found ${sheets.length} sheets, ${solutions.length} solutions`);
			return JSON.stringify(
				sheets.map((sheet) => ({
					sheetId: sheet.id,
					label: sheet.label || sheet.filename,
					hasSolutions: solutions.some((sol) => sol.label?.includes(sheet.label || "") || false),
				})),
				null,
				2,
			);
		},
	},
};
