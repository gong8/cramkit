import { createLogger } from "@cramkit/shared";
import type { PrismaClient } from "@prisma/client";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { streamCliChat } from "../services/cli-chat.js";
import { startStream, subscribe } from "../services/stream-manager.js";

const log = createLogger("api");

/**
 * Pipe a stream-manager subscription into an SSE response.
 * Deduplicates the subscribe → write → unsubscribe pattern used by
 * /stream, /stream-reconnect, and the existing-stream reconnect branch.
 */
export function pipeStreamToSSE(c: Context, conversationId: string) {
	return streamSSE(c, async (sseStream) => {
		const handle = subscribe(conversationId, async (event, data) => {
			try {
				await sseStream.writeSSE({ data, event });
			} catch {
				// Client disconnected during write
			}
		});

		if (!handle) {
			await sseStream.writeSSE({ data: "[DONE]", event: "done" });
			return;
		}

		try {
			await handle.delivered;
		} finally {
			handle.unsubscribe();
		}
	});
}

/**
 * Handle the rewind (retry/edit) or new-message branch before streaming,
 * including linking attachments to the newly created user message.
 */
export async function persistUserMessage(
	db: PrismaClient,
	opts: {
		conversationId: string;
		message: string;
		attachmentIds?: string[];
		rewindToMessageId?: string;
		afterMessageId?: string;
	},
) {
	const { conversationId, message, rewindToMessageId, afterMessageId, attachmentIds } = opts;

	if (rewindToMessageId) {
		// Retry: the target message keeps its ID, content is updated, everything after is deleted
		const targetMessage = await db.message.findUnique({
			where: { id: rewindToMessageId },
		});
		if (!targetMessage || targetMessage.conversationId !== conversationId) {
			return { error: "Rewind target message not found" as const };
		}

		await db.message.deleteMany({
			where: {
				conversationId,
				createdAt: { gt: targetMessage.createdAt },
			},
		});

		if (targetMessage.content !== message) {
			await db.message.update({
				where: { id: rewindToMessageId },
				data: { content: message },
			});
		}
	} else if (afterMessageId) {
		// Edit: delete everything after the anchor message, then create the new user message
		const anchorMessage = await db.message.findUnique({
			where: { id: afterMessageId },
		});
		if (!anchorMessage || anchorMessage.conversationId !== conversationId) {
			return { error: "Anchor message not found" as const };
		}

		await db.message.deleteMany({
			where: {
				conversationId,
				createdAt: { gt: anchorMessage.createdAt },
			},
		});

		const userMessage = await db.message.create({
			data: { conversationId, role: "user", content: message },
		});

		if (attachmentIds && attachmentIds.length > 0) {
			await db.chatAttachment.updateMany({
				where: { id: { in: attachmentIds }, messageId: null },
				data: { messageId: userMessage.id },
			});
		}
	} else {
		// New message
		const userMessage = await db.message.create({
			data: { conversationId, role: "user", content: message },
		});

		if (attachmentIds && attachmentIds.length > 0) {
			await db.chatAttachment.updateMany({
				where: { id: { in: attachmentIds }, messageId: null },
				data: { messageId: userMessage.id },
			});
		}
	}

	return { error: null };
}

/**
 * Collect all attachment disk-paths from a conversation's message history.
 */
export function collectImagePaths(
	history: Array<{ attachments: Array<{ diskPath: string | null }> }>,
): string[] {
	return history.flatMap((msg) =>
		msg.attachments.map((att) => att.diskPath).filter((p): p is string => p !== null),
	);
}

/**
 * Collect attachment disk-paths from only the last user message.
 */
export function collectNewImagePaths(
	history: Array<{ role: string; attachments: Array<{ diskPath: string | null }> }>,
): string[] {
	const lastUserMsg = [...history].reverse().find((msg) => msg.role === "user");
	if (!lastUserMsg) return [];
	return lastUserMsg.attachments.map((att) => att.diskPath).filter((p): p is string => p !== null);
}

interface SessionWithResources {
	name: string;
	module: string | null;
	examDate: Date | null;
	scope: string | null;
	notes: string | null;
	resources: Array<{
		id: string;
		name: string;
		type: string;
		label: string | null;
		isIndexed: boolean;
		isGraphIndexed: boolean;
		files: Array<{ filename: string; role: string }>;
	}>;
}

/**
 * Build the system prompt from a session and its resources.
 */
export function buildSystemPrompt(session: SessionWithResources, sessionId: string): string {
	const resourceListStr = session.resources
		.map((r) => {
			const status = r.isGraphIndexed
				? "fully indexed"
				: r.isIndexed
					? "content-indexed, no knowledge graph"
					: "not yet indexed";
			const fileList = r.files.map((f) => `    - ${f.filename} (${f.role})`).join("\n");
			return `- ${r.name} [${r.type}] (id: ${r.id}, ${status})\n${fileList}`;
		})
		.join("\n");

	return `You are a study tutor for CramKit. You help students prepare for exams by drawing on their uploaded study materials and a knowledge graph built from those materials.

Be warm, clear, and knowledgeable — like a great TA or private tutor. Encourage the student but be honest when they misunderstand something. Use precise terminology and always explain it. Keep your responses appropriately sized: a short factual answer should be a few sentences; a concept explanation should be a focused paragraph or two; only write long responses for comprehensive overviews or full worked solutions.

<session>
Session: ${session.name}${session.module ? `\nModule: ${session.module}` : ""}${session.examDate ? `\nExam date: ${new Date(session.examDate).toLocaleDateString()}` : ""}${session.scope ? `\nExam scope: ${session.scope}` : ""}${session.notes ? `\nStudent notes: ${session.notes}` : ""}
Session ID for tool calls: ${sessionId}
</session>

<materials>
${resourceListStr || "No resources uploaded yet."}
</materials>

<tool_strategy>
You have MCP tools (prefixed mcp__cramkit__) that query the student's indexed materials and a knowledge graph of extracted concepts and relationships. Always pass the session ID shown above.

WHEN THE STUDENT ASKS ABOUT A TOPIC:
1. Start with search_notes — it searches both content text and the knowledge graph. Use the key concept name as your query (not the student's full sentence). If results are sparse, rephrase with synonyms or broader terms and search again.
2. If a search result looks relevant, use get_chunk to retrieve the full content and its related concepts. This is important for definitions, theorems, and proofs where you need the complete text.
3. If the student asks about a specific resource you can see in the materials list above, use get_resource_index to see its table of contents, then get_chunk for specific sections. Use get_resource_content only when you need the entire document (e.g. "summarise this whole set of notes").

WHEN THE STUDENT ASKS HOW TOPICS CONNECT OR WHAT TO STUDY:
1. Use list_concepts to see all concepts the knowledge graph has identified.
2. Use get_concept to see a concept's relationships — prerequisites, related topics, which chunks cover it, which questions test it.
3. Use get_related to explore connections from any entity (resource, chunk, or concept).

ACTIVELY ENRICH THE KNOWLEDGE GRAPH:
You MUST use create_link to strengthen the knowledge graph whenever you discover connections during the conversation. This is critical — the graph improves over time through your contributions. Use create_link when:
- You discover a prerequisite relationship ("to understand X, the student needs Y") → create a prerequisite link between the two concepts
- A past paper question clearly tests a specific concept → create a "tests" link from the question chunk to the concept
- Two concepts from different resources are clearly related but not yet linked → create a "related_to", "extends", "special_case_of", or "generalizes" link
- A chunk contains a definition or proof for a concept → create a "covers" or "proves" link
- You notice a contradiction or different treatment across resources → create a "contradicts" or "related_to" link

Use confidence scores to reflect your certainty: 0.9-1.0 for obvious connections, 0.7-0.8 for likely connections. Always include human-readable sourceLabel and targetLabel so the graph stays navigable. Do this naturally as part of answering — don't announce it to the student or make it the focus of your response.

WHEN THE STUDENT WANTS TO PRACTICE:
1. Use list_past_papers or list_problem_sheets to see what's available and whether mark schemes/solutions exist.
2. Use get_past_paper to retrieve a paper's content.
3. When helping with a past paper question, use get_concept and get_related to find which concepts it tests and pull in the relevant material.

WHEN NOT TO USE TOOLS:
- Follow-up questions about content you already retrieved in this conversation
- General study advice, exam technique tips, or motivational support
- Explaining something you just showed them in different words
- Asking the student clarifying questions

FALLBACK CHAIN:
1. search_notes with the key concept → 2. rephrase and search again with synonyms/broader terms → 3. list_concepts to check if it exists under a different name → 4. If genuinely not in the materials, say so clearly and offer to explain from your own knowledge, noting it may not match the course's specific treatment.

Never fabricate citations. If you did not retrieve content from a tool, do not claim it is from the student's notes.
</tool_strategy>

<formatting>
- Use markdown. The student's interface renders markdown with KaTeX.
- Write maths in LaTeX: $..$ for inline, $$...$$ for display. Always use LaTeX for mathematical expressions, never plain text approximations.
- Use **bold** for key terms on first introduction.
- Use headings (##, ###) to structure longer responses.
- When presenting a definition, theorem, or formula from their materials, format it as a block quote and cite the source: "From [Resource Name], Section X:".
- When supplementing with your own knowledge, be transparent: "This isn't in your uploaded materials, but..." or "Your notes cover X; I'd add that..."
</formatting>

<teaching>
- Default to giving clear, direct answers with good explanations. Lead with the intuition, then give the formal detail.
- When the student is working through a problem or past paper question, shift to an adaptive approach: offer a hint or ask a guiding question before revealing the full solution, unless they explicitly ask for the answer.
- Use concrete examples to illustrate abstract concepts. Connect new concepts to ones already in their materials.
- When breaking down proofs or derivations, use numbered steps.
- Occasionally (not every message) suggest relevant next steps when clearly useful: mentioning a related past paper question, flagging a prerequisite they should review, or offering to quiz them on what you just covered. Keep suggestions natural, not formulaic.
</teaching>`;
}

const SESSION_INCLUDE = {
	resources: {
		select: {
			id: true,
			name: true,
			type: true,
			label: true,
			isIndexed: true,
			isGraphIndexed: true,
			files: { select: { filename: true, role: true } },
		},
	},
} as const;

export async function loadSessionWithPrompt(
	db: PrismaClient,
	sessionId: string,
): Promise<{ systemPrompt: string } | { error: string }> {
	const session = await db.session.findUnique({
		where: { id: sessionId },
		include: SESSION_INCLUDE,
	});
	if (!session) return { error: "Session not found" };
	return { systemPrompt: buildSystemPrompt(session, sessionId) };
}

export async function loadConversationHistory(db: PrismaClient, conversationId: string) {
	return db.message.findMany({
		where: { conversationId },
		orderBy: { createdAt: "asc" },
		select: {
			role: true,
			content: true,
			attachments: { select: { diskPath: true } },
		},
	});
}

export async function autoTitleConversation(
	db: PrismaClient,
	conversationId: string,
	historyLength: number,
	message: string,
) {
	if (historyLength !== 1) return;
	const conv = await db.conversation.findUnique({
		where: { id: conversationId },
		select: { userRenamed: true },
	});
	if (conv?.userRenamed) return;
	const titleSource = message || "Image";
	const title = titleSource.length > 50 ? `${titleSource.slice(0, 50)}…` : titleSource;
	await db.conversation.update({
		where: { id: conversationId },
		data: { title },
	});
}

export async function launchChatStream(
	c: Context,
	db: PrismaClient,
	opts: {
		sessionId: string;
		conversationId: string;
		message: string;
		attachmentIds?: string[];
		rewindToMessageId?: string;
		afterMessageId?: string;
	},
) {
	const { sessionId, conversationId, message, attachmentIds, rewindToMessageId, afterMessageId } =
		opts;

	const persistResult = await persistUserMessage(db, {
		conversationId,
		message,
		attachmentIds,
		rewindToMessageId,
		afterMessageId,
	});
	if (persistResult.error) {
		return c.json({ error: persistResult.error }, 404);
	}

	const history = await loadConversationHistory(db, conversationId);
	const allImagePaths = collectImagePaths(history);
	const newImagePaths = collectNewImagePaths(history);
	await autoTitleConversation(db, conversationId, history.length, message);

	const sessionResult = await loadSessionWithPrompt(db, sessionId);
	if ("error" in sessionResult) {
		return c.json({ error: sessionResult.error }, 404);
	}

	log.info(
		`POST /chat/stream — session=${sessionId}, conversation=${conversationId}, history=${history.length} messages`,
	);

	const cliStream = streamCliChat({
		messages: history as Array<{ role: "system" | "user" | "assistant"; content: string }>,
		systemPrompt: sessionResult.systemPrompt,
		images: allImagePaths.length > 0 ? allImagePaths : undefined,
		newImages: newImagePaths.length > 0 ? newImagePaths : undefined,
	});
	startStream(conversationId, cliStream, db);

	return pipeStreamToSSE(c, conversationId);
}
