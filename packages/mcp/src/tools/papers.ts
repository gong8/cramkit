import { z } from "zod";
import { apiClient } from "../lib/api-client.js";
import { resourceId, sessionId } from "./params.js";

interface ResourceInfo {
	id: string;
	name: string;
	type: string;
	label: string | null;
	isMetaIndexed: boolean;
	metadata: string | null;
	files: Array<{ id: string; filename: string; role: string }>;
}

interface QuestionSummary {
	id: string;
	questionNumber: string;
	parentNumber: string | null;
	marks: number | null;
	questionType: string | null;
	commandWords: string | null;
	relatedConcepts: Array<{ name: string; relationship: string }>;
	parts?: QuestionSummary[];
}

async function listResourcesByTypeWithGraph(
	type: string,
	companionLabel: string,
	companionRole: string,
	sid: string,
) {
	const resources = (await apiClient.listResources(sid)) as ResourceInfo[];
	const filtered = resources.filter((r) => r.type === type);

	const results = await Promise.all(
		filtered.map(async (r) => {
			const base = {
				resourceId: r.id,
				name: r.name,
				hasCompanion: r.label === companionLabel || r.files.some((f) => f.role === companionRole),
				files: r.files.map((f) => ({ id: f.id, filename: f.filename, role: f.role })),
			};

			// If meta-indexed, include graph data
			if (r.isMetaIndexed) {
				try {
					const questions = (await apiClient.listPaperQuestions(r.id)) as QuestionSummary[];
					const metadata = r.metadata ? JSON.parse(r.metadata) : null;
					const summarize = (q: QuestionSummary): Record<string, unknown> => ({
						questionNumber: q.questionNumber,
						marks: q.marks,
						questionType: q.questionType,
						relatedConcepts: q.relatedConcepts.map((c) => c.name),
						parts: q.parts?.map(summarize),
					});
					return {
						...base,
						metadata,
						questions: questions.map(summarize),
					};
				} catch {
					return base;
				}
			}

			return base;
		}),
	);

	return results;
}

export const paperTools = {
	list_past_papers: {
		description:
			"List all past paper resources with their questions, marks, types, and tested concepts. Returns graph data when available.",
		parameters: z.object({ sessionId }),
		execute: async ({ sessionId }: { sessionId: string }) =>
			listResourcesByTypeWithGraph("PAST_PAPER", "includes_mark_scheme", "MARK_SCHEME", sessionId),
	},

	get_past_paper: {
		description: "Get a specific past paper's content.",
		parameters: z.object({ resourceId }),
		execute: async ({ resourceId }: { resourceId: string }) =>
			apiClient.getResourceContent(resourceId),
	},

	list_problem_sheets: {
		description:
			"List all problem sheet resources with their questions, marks, and tested concepts. Returns graph data when available.",
		parameters: z.object({ sessionId }),
		execute: async ({ sessionId }: { sessionId: string }) =>
			listResourcesByTypeWithGraph("PROBLEM_SHEET", "includes_solutions", "SOLUTIONS", sessionId),
	},

	list_paper_questions: {
		description:
			"List all exam questions for a past paper or problem sheet with marks, types, command words, and tested concepts. Returns hierarchical question tree.",
		parameters: z.object({ resourceId }),
		execute: async ({ resourceId }: { resourceId: string }) =>
			apiClient.listPaperQuestions(resourceId),
	},

	get_paper_question: {
		description:
			"Get a specific question with full verbatim content, mark scheme text, solution text, and tested concepts.",
		parameters: z.object({
			questionId: z.string().describe("The question ID"),
		}),
		execute: async ({ questionId }: { questionId: string }) =>
			apiClient.getPaperQuestion(questionId),
	},
};
