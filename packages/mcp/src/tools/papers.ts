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
	questionNumber: string;
	marks: number | null;
	questionType: string | null;
	relatedConcepts: Array<{ name: string }>;
	parts?: QuestionSummary[];
}

function summarizeQuestion(q: QuestionSummary): Record<string, unknown> {
	return {
		questionNumber: q.questionNumber,
		marks: q.marks,
		questionType: q.questionType,
		relatedConcepts: q.relatedConcepts.map((c) => c.name),
		parts: q.parts?.map(summarizeQuestion),
	};
}

async function listResourcesByTypeWithGraph(
	type: string,
	companionLabel: string,
	companionRole: string,
	sid: string,
) {
	const resources = (await apiClient.listResources(sid)) as ResourceInfo[];
	return Promise.all(
		resources
			.filter((r) => r.type === type)
			.map(async (r) => {
				const base = {
					resourceId: r.id,
					name: r.name,
					hasCompanion: r.label === companionLabel || r.files.some((f) => f.role === companionRole),
					files: r.files.map((f) => ({ id: f.id, filename: f.filename, role: f.role })),
				};

				if (!r.isMetaIndexed) return base;

				try {
					const questions = (await apiClient.listPaperQuestions(r.id)) as QuestionSummary[];
					return {
						...base,
						metadata: r.metadata ? JSON.parse(r.metadata) : null,
						questions: questions.map(summarizeQuestion),
					};
				} catch {
					return base;
				}
			}),
	);
}

export const paperTools = {
	list_past_papers: {
		description:
			"List all past paper resources with their questions, marks, types, and tested concepts. Returns graph data when available.",
		parameters: z.object({ sessionId }),
		execute: async (p: { sessionId: string }) =>
			listResourcesByTypeWithGraph(
				"PAST_PAPER",
				"includes_mark_scheme",
				"MARK_SCHEME",
				p.sessionId,
			),
	},

	get_past_paper: {
		description: "Get a specific past paper's content.",
		parameters: z.object({ resourceId }),
		execute: async (p: { resourceId: string }) => apiClient.getResourceContent(p.resourceId),
	},

	list_problem_sheets: {
		description:
			"List all problem sheet resources with their questions, marks, and tested concepts. Returns graph data when available.",
		parameters: z.object({ sessionId }),
		execute: async (p: { sessionId: string }) =>
			listResourcesByTypeWithGraph("PROBLEM_SHEET", "includes_solutions", "SOLUTIONS", p.sessionId),
	},

	list_paper_questions: {
		description:
			"List all exam questions for a past paper or problem sheet with marks, types, command words, and tested concepts. Returns hierarchical question tree.",
		parameters: z.object({ resourceId }),
		execute: async (p: { resourceId: string }) => apiClient.listPaperQuestions(p.resourceId),
	},

	get_paper_question: {
		description:
			"Get a specific question with full verbatim content, mark scheme text, solution text, and tested concepts.",
		parameters: z.object({
			questionId: z.string().describe("The question ID"),
		}),
		execute: async (p: { questionId: string }) => apiClient.getPaperQuestion(p.questionId),
	},
};
