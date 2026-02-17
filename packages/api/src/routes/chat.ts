import { chatStreamRequestSchema, createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamCliChat } from "../services/cli-chat.js";

const log = createLogger("api");

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
		},
	});

	log.info(`GET /chat/sessions/${sessionId}/conversations — ${conversations.length} found`);
	return c.json(conversations);
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
		select: { id: true, role: true, content: true, createdAt: true },
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

// Stream chat — persists messages to DB
chatRoutes.post("/stream", async (c) => {
	const body = await c.req.json();
	const parsed = chatStreamRequestSchema.safeParse(body);

	if (!parsed.success) {
		log.warn("POST /chat/stream — validation failed", parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { sessionId, conversationId, message } = parsed.data;
	const db = getDb();

	// Verify conversation exists and belongs to session
	const conversation = await db.conversation.findUnique({
		where: { id: conversationId },
	});

	if (!conversation || conversation.sessionId !== sessionId) {
		return c.json({ error: "Conversation not found" }, 404);
	}

	// Save user message
	await db.message.create({
		data: { conversationId, role: "user", content: message },
	});

	// Load full message history from DB
	const history = await db.message.findMany({
		where: { conversationId },
		orderBy: { createdAt: "asc" },
		select: { role: true, content: true },
	});

	// Auto-title on first user message
	if (history.length === 1) {
		const title = message.length > 50 ? message.slice(0, 50) + "…" : message;
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
			const fileList = r.files.map((f) => `    - ${f.filename} (${f.role})`).join("\n");
			return `- ${r.name} [${r.type}]\n${fileList}`;
		})
		.join("\n");

	const systemPrompt = `You are a study assistant for CramKit. You are helping a student prepare for their exam.

Session: ${session.name}
${session.module ? `Module: ${session.module}` : ""}
${session.examDate ? `Exam date: ${new Date(session.examDate).toLocaleDateString()}` : ""}
${session.scope ? `Exam scope: ${session.scope}` : ""}
${session.notes ? `Student notes: ${session.notes}` : ""}

Uploaded materials:
${resourceListStr || "No resources uploaded yet."}

Help the student study effectively. You can reference their materials by name. Be concise and focused on exam preparation. Use the MCP tools to search notes and retrieve content when the student asks about specific material.`;

	log.info(`POST /chat/stream — session=${sessionId}, conversation=${conversationId}, history=${history.length} messages`);

	// Spawn CLI with streaming
	const cliStream = streamCliChat({
		messages: history as Array<{ role: "system" | "user" | "assistant"; content: string }>,
		systemPrompt,
		signal: c.req.raw.signal,
	});

	// Forward CLI SSE stream to client, accumulate for persistence
	return streamSSE(c, async (stream) => {
		const reader = cliStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let fullAssistantContent = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					// Parse SSE lines from the CLI stream
					if (trimmed.startsWith("data: ")) {
						const data = trimmed.slice(6);
						if (data === "[DONE]") {
							if (fullAssistantContent) {
								await db.message.create({
									data: { conversationId, role: "assistant", content: fullAssistantContent },
								});
								await db.conversation.update({
									where: { id: conversationId },
									data: { updatedAt: new Date() },
								});
							}
							await stream.writeSSE({ data: "[DONE]", event: "done" });
							return;
						}

						try {
							const parsed = JSON.parse(data) as { content?: string; error?: string };
							if (parsed.content) {
								fullAssistantContent += parsed.content;
								await stream.writeSSE({
									data: JSON.stringify({ content: parsed.content }),
									event: "content",
								});
							}
							if (parsed.error) {
								await stream.writeSSE({
									data: JSON.stringify({ error: parsed.error }),
									event: "error",
								});
							}
						} catch {
							// Skip unparseable
						}
					}
				}
			}

			// Stream ended — persist if we got content
			if (fullAssistantContent) {
				await db.message.create({
					data: { conversationId, role: "assistant", content: fullAssistantContent },
				});
				await db.conversation.update({
					where: { id: conversationId },
					data: { updatedAt: new Date() },
				});
			}
			await stream.writeSSE({ data: "[DONE]", event: "done" });
		} catch (error) {
			log.error("POST /chat/stream — streaming error", error);
			if (fullAssistantContent) {
				await db.message.create({
					data: { conversationId, role: "assistant", content: fullAssistantContent },
				}).catch(() => {});
			}
		} finally {
			reader.releaseLock();
		}
	});
});
