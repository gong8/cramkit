import { z } from "zod";
import { apiClient } from "../lib/api-client.js";
import { sessionId } from "./params.js";

export const sessionTools = {
	list_sessions: {
		description: "List all cram sessions",
		parameters: z.object({}),
		execute: async () => apiClient.listSessions(),
	},

	get_session: {
		description: "Get full details of a cram session including exam scope and notes",
		parameters: z.object({ sessionId }),
		execute: async ({ sessionId }: { sessionId: string }) => apiClient.getSession(sessionId),
	},

	get_exam_scope: {
		description: "Get the exam scope and any extra notes for a session",
		parameters: z.object({ sessionId }),
		execute: async ({ sessionId }: { sessionId: string }) => {
			const session = (await apiClient.getSession(sessionId)) as Record<string, unknown>;
			return {
				scope: session.scope,
				notes: session.notes,
				examDate: session.examDate,
			};
		},
	},
};
