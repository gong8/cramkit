import { z } from "zod";
import { apiClient } from "../lib/api-client.js";

export const sessionTools = {
	list_sessions: {
		description: "List all cram sessions",
		parameters: z.object({}),
		execute: async () => {
			const sessions = await apiClient.listSessions();
			return JSON.stringify(sessions, null, 2);
		},
	},

	get_session: {
		description: "Get full details of a cram session including exam scope and notes",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			const session = await apiClient.getSession(sessionId);
			return JSON.stringify(session, null, 2);
		},
	},

	get_exam_scope: {
		description: "Get the exam scope and any extra notes for a session",
		parameters: z.object({
			sessionId: z.string().describe("The session ID"),
		}),
		execute: async ({ sessionId }: { sessionId: string }) => {
			const session = (await apiClient.getSession(sessionId)) as Record<string, unknown>;
			return JSON.stringify(
				{
					scope: session.scope,
					notes: session.notes,
					examDate: session.examDate,
				},
				null,
				2,
			);
		},
	},
};
