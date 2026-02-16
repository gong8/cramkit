import { createLogger } from "@cramkit/shared";
import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

const log = createLogger("mcp");

interface FileInfo {
	id: string;
	type: string;
	label: string | null;
	filename: string;
}

interface RelationshipInfo {
	sourceType: string;
	sourceId: string;
	targetType: string;
	targetId: string;
	relationship: string;
}

export const paperTools = {
	list_past_papers: {
		description: "List all past papers and their associated mark schemes for a session.",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			log.info(`list_past_papers — session=${sessionId}`);
			const session = (await apiClient.getSession(sessionId)) as {
				files?: FileInfo[];
			};
			const files = session.files || [];
			const relationships = (await apiClient.getRelationships(sessionId)) as RelationshipInfo[];

			// Find papers: PAST_PAPER or PAST_PAPER_WITH_MARK_SCHEME
			const papers = files.filter(
				(f) => f.type === "PAST_PAPER" || f.type === "PAST_PAPER_WITH_MARK_SCHEME",
			);

			// Build file-to-file link map
			const fileLinks = relationships.filter(
				(r) => r.sourceType === "file" && r.targetType === "file",
			);

			log.info(`list_past_papers — found ${papers.length} papers, ${fileLinks.length} file links`);
			return JSON.stringify(
				papers.map((paper) => {
					// Check for linked mark scheme via Relationship
					const msLink = fileLinks.find(
						(l) => l.sourceId === paper.id && l.relationship === "mark_scheme_of",
					);
					const hasMarkScheme =
						paper.type === "PAST_PAPER_WITH_MARK_SCHEME" || !!msLink;

					return {
						paperId: paper.id,
						label: paper.label || paper.filename,
						hasMarkScheme,
						markSchemeId: msLink?.targetId || null,
						isCombined: paper.type === "PAST_PAPER_WITH_MARK_SCHEME",
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
				files?: FileInfo[];
			};
			const files = session.files || [];
			const relationships = (await apiClient.getRelationships(sessionId)) as RelationshipInfo[];

			// Find sheets: PROBLEM_SHEET or PROBLEM_SHEET_WITH_SOLUTIONS
			const sheets = files.filter(
				(f) => f.type === "PROBLEM_SHEET" || f.type === "PROBLEM_SHEET_WITH_SOLUTIONS",
			);

			const fileLinks = relationships.filter(
				(r) => r.sourceType === "file" && r.targetType === "file",
			);

			log.info(`list_problem_sheets — found ${sheets.length} sheets, ${fileLinks.length} file links`);
			return JSON.stringify(
				sheets.map((sheet) => {
					const solLink = fileLinks.find(
						(l) => l.sourceId === sheet.id && l.relationship === "solutions_of",
					);
					const hasSolutions =
						sheet.type === "PROBLEM_SHEET_WITH_SOLUTIONS" || !!solLink;

					return {
						sheetId: sheet.id,
						label: sheet.label || sheet.filename,
						hasSolutions,
						solutionsId: solLink?.targetId || null,
						isCombined: sheet.type === "PROBLEM_SHEET_WITH_SOLUTIONS",
					};
				}),
				null,
				2,
			);
		},
	},
};
