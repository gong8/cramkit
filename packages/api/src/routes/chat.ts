import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chatStreamRequestSchema, createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamCliChat } from "../services/cli-chat.js";
import { getStream, startStream, subscribe } from "../services/stream-manager.js";

const log = createLogger("api");

const DATA_DIR = join(import.meta.dirname, "..", "..", "..", "..", "data");
const ATTACHMENTS_DIR = join(DATA_DIR, "chat-attachments");

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const chatRoutes = new Hono();

// List conversations for a session
chatRoutes.get("/sessions/:sessionId/conversations", async (c) => {
	const { sessionId } = c.req.param();
	const db = getDb();

	const conversations = await db.conversation.findMany({
		where: { sessionId },
		orderBy: { updatedAt: "desc" },
		select: {
			id: true,
			title: true,
			createdAt: true,
			updatedAt: true,
			_count: { select: { messages: true } },
		},
	});

	const result = conversations.map(({ _count, ...rest }) => ({
		...rest,
		messageCount: _count.messages,
	}));

	log.info(`GET /chat/sessions/${sessionId}/conversations — ${result.length} found`);
	return c.json(result);
});

// Create a new conversation
chatRoutes.post("/sessions/:sessionId/conversations", async (c) => {
	const { sessionId } = c.req.param();
	const db = getDb();

	const session = await db.session.findUnique({ where: { id: sessionId } });
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	const conversation = await db.conversation.create({
		data: { sessionId },
		select: { id: true, title: true, createdAt: true, updatedAt: true },
	});

	log.info(`POST /chat/sessions/${sessionId}/conversations — created ${conversation.id}`);
	return c.json(conversation, 201);
});

// Get messages for a conversation
chatRoutes.get("/conversations/:id/messages", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const messages = await db.message.findMany({
		where: { conversationId: id },
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			role: true,
			content: true,
			toolCalls: true,
			createdAt: true,
			attachments: {
				select: { id: true, filename: true, contentType: true },
			},
		},
	});

	log.info(`GET /chat/conversations/${id}/messages — ${messages.length} messages`);
	return c.json(messages);
});

// Rename a conversation
chatRoutes.patch("/conversations/:id", async (c) => {
	const { id } = c.req.param();
	const { title } = await c.req.json<{ title: string }>();
	const db = getDb();

	if (!title || typeof title !== "string") {
		return c.json({ error: "Title is required" }, 400);
	}

	const conversation = await db.conversation.update({
		where: { id },
		data: { title: title.trim() },
		select: { id: true, title: true, createdAt: true, updatedAt: true },
	});

	log.info(`PATCH /chat/conversations/${id} — renamed to "${conversation.title}"`);
	return c.json(conversation);
});

// Delete a conversation
chatRoutes.delete("/conversations/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	await db.conversation.delete({ where: { id } });
	log.info(`DELETE /chat/conversations/${id}`);
	return c.json({ ok: true });
});

// Upload an image attachment
chatRoutes.post("/attachments", async (c) => {
	const formData = await c.req.formData();
	const file = formData.get("file") as File | null;

	if (!file) {
		return c.json({ error: "No file provided" }, 400);
	}

	if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
		return c.json({ error: "Only JPEG, PNG, GIF, and WebP images are allowed" }, 400);
	}

	const id = randomUUID();
	const ext = extname(file.name) || ".png";
	const diskPath = join(ATTACHMENTS_DIR, `${id}${ext}`);

	await mkdir(ATTACHMENTS_DIR, { recursive: true });
	const buffer = Buffer.from(await file.arrayBuffer());
	await writeFile(diskPath, buffer);

	const db = getDb();
	const attachment = await db.chatAttachment.create({
		data: {
			id,
			filename: file.name,
			contentType: file.type,
			diskPath,
			fileSize: buffer.length,
		},
		select: { id: true, filename: true, contentType: true },
	});

	log.info(`POST /chat/attachments — uploaded ${attachment.filename} (${buffer.length} bytes)`);
	return c.json(
		{
			id: attachment.id,
			url: `/api/chat/attachments/${attachment.id}`,
			filename: attachment.filename,
			contentType: attachment.contentType,
		},
		201,
	);
});

// Serve an attachment image
chatRoutes.get("/attachments/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const attachment = await db.chatAttachment.findUnique({ where: { id } });
	if (!attachment || !existsSync(attachment.diskPath)) {
		return c.json({ error: "Attachment not found" }, 404);
	}

	const data = await readFile(attachment.diskPath);
	c.header("Content-Type", attachment.contentType);
	c.header("Cache-Control", "public, max-age=31536000, immutable");
	return c.body(data);
});

// Delete an unlinked attachment (e.g. user removed from composer before sending)
chatRoutes.delete("/attachments/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const attachment = await db.chatAttachment.findUnique({ where: { id } });
	if (!attachment) {
		return c.json({ error: "Attachment not found" }, 404);
	}

	// Only allow deleting unlinked attachments (not yet sent with a message)
	if (attachment.messageId) {
		return c.json({ error: "Cannot delete an attachment that belongs to a message" }, 400);
	}

	await db.chatAttachment.delete({ where: { id } });
	await rm(attachment.diskPath, { force: true });

	log.info(`DELETE /chat/attachments/${id}`);
	return c.json({ ok: true });
});

// Check if a conversation has an active stream
chatRoutes.get("/conversations/:id/stream-status", async (c) => {
	const { id } = c.req.param();
	const existing = getStream(id);

	if (!existing) {
		return c.json({ active: false, status: null });
	}

	return c.json({ active: true, status: existing.status });
});

// Reconnect to an active background stream
chatRoutes.post("/conversations/:id/stream-reconnect", async (c) => {
	const { id } = c.req.param();
	const existingStream = getStream(id);

	if (!existingStream) {
		return c.json({ error: "No active stream" }, 404);
	}

	log.info(`POST /chat/conversations/${id}/stream-reconnect — reconnecting`);
	return streamSSE(c, async (sseStream) => {
		const handle = subscribe(id, async (event, data) => {
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
});

// Stream chat — persists messages to DB
chatRoutes.post("/stream", async (c) => {
	const body = await c.req.json();
	const parsed = chatStreamRequestSchema.safeParse(body);

	if (!parsed.success) {
		log.warn("POST /chat/stream — validation failed", parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { sessionId, conversationId, message, attachmentIds, rewindToMessageId } = parsed.data;
	const db = getDb();

	// Verify conversation exists and belongs to session
	const conversation = await db.conversation.findUnique({
		where: { id: conversationId },
	});

	if (!conversation || conversation.sessionId !== sessionId) {
		return c.json({ error: "Conversation not found" }, 404);
	}

	// Check for active stream — reconnection case
	if (getStream(conversationId)) {
		log.info(`POST /chat/stream — reconnecting to active stream for ${conversationId}`);
		return streamSSE(c, async (sseStream) => {
			const handle = subscribe(conversationId, async (event, data) => {
				try {
					await sseStream.writeSSE({ data, event });
				} catch {
					// Client disconnected during write, ignore
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

	// Handle rewind (retry/edit)
	if (rewindToMessageId) {
		const targetMessage = await db.message.findUnique({
			where: { id: rewindToMessageId },
		});
		if (!targetMessage || targetMessage.conversationId !== conversationId) {
			return c.json({ error: "Rewind target message not found" }, 404);
		}

		// Delete all messages after the target
		await db.message.deleteMany({
			where: {
				conversationId,
				createdAt: { gt: targetMessage.createdAt },
			},
		});

		// If the content differs, update the target message (edit case)
		if (targetMessage.content !== message) {
			await db.message.update({
				where: { id: rewindToMessageId },
				data: { content: message },
			});
		}
	} else {
		// Save new user message
		const userMessage = await db.message.create({
			data: { conversationId, role: "user", content: message },
		});

		// Link attachments to the user message
		if (attachmentIds && attachmentIds.length > 0) {
			await db.chatAttachment.updateMany({
				where: { id: { in: attachmentIds }, messageId: null },
				data: { messageId: userMessage.id },
			});
		}
	}

	// Resolve image paths for any attachments on the last user message
	let imagePaths: string[] = [];
	if (!rewindToMessageId && attachmentIds && attachmentIds.length > 0) {
		const attachments = await db.chatAttachment.findMany({
			where: { id: { in: attachmentIds } },
			select: { diskPath: true },
		});
		imagePaths = attachments.map((a) => a.diskPath);
	}

	// Load full message history from DB
	const history = await db.message.findMany({
		where: { conversationId },
		orderBy: { createdAt: "asc" },
		select: { role: true, content: true },
	});

	// Auto-title on first user message
	if (history.length === 1) {
		const title = message.length > 50 ? `${message.slice(0, 50)}…` : message;
		await db.conversation.update({
			where: { id: conversationId },
			data: { title },
		});
	}

	// Build system prompt from session context
	const session = await db.session.findUnique({
		where: { id: sessionId },
		include: {
			resources: {
				select: {
					id: true,
					name: true,
					type: true,
					label: true,
					isIndexed: true,
					isGraphIndexed: true,
					files: {
						select: { filename: true, role: true },
					},
				},
			},
		},
	});

	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

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

	const systemPrompt = `You are a study tutor for CramKit. You help students prepare for exams by drawing on their uploaded study materials and a knowledge graph built from those materials.

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

	log.info(
		`POST /chat/stream — session=${sessionId}, conversation=${conversationId}, history=${history.length} messages`,
	);

	// Spawn CLI without HTTP signal — stream runs independently of client connection
	const cliStream = streamCliChat({
		messages: history as Array<{ role: "system" | "user" | "assistant"; content: string }>,
		systemPrompt,
		images: imagePaths.length > 0 ? imagePaths : undefined,
	});

	// Register with stream manager — background consumer handles persistence
	startStream(conversationId, cliStream, db);

	// Subscribe this SSE connection to the stream
	return streamSSE(c, async (sseStream) => {
		const handle = subscribe(conversationId, async (event, data) => {
			try {
				await sseStream.writeSSE({ data, event });
			} catch {
				// Client disconnected during write, ignore
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
});
