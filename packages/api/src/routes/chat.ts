import { chatStreamRequestSchema, createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { getStream } from "../services/stream-manager.js";
import { attachmentRoutes } from "./chat-attachments.js";
import { launchChatStream, pipeStreamToSSE } from "./chat-helpers.js";

const log = createLogger("api");

export const chatRoutes = new Hono();

chatRoutes.route("/attachments", attachmentRoutes);

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
		data: { title: title.trim(), userRenamed: true },
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

// Check if a conversation has an active stream
chatRoutes.get("/conversations/:id/stream-status", async (c) => {
	const { id } = c.req.param();
	const existing = getStream(id);
	return c.json(
		existing ? { active: true, status: existing.status } : { active: false, status: null },
	);
});

// Reconnect to an active background stream
chatRoutes.post("/conversations/:id/stream-reconnect", async (c) => {
	const { id } = c.req.param();
	const existingStream = getStream(id);

	if (!existingStream) {
		return c.json({ error: "No active stream" }, 404);
	}

	log.info(`POST /chat/conversations/${id}/stream-reconnect — reconnecting`);
	return pipeStreamToSSE(c, id);
});

// Stream chat — persists messages to DB
chatRoutes.post("/stream", async (c) => {
	const body = await c.req.json();
	const parsed = chatStreamRequestSchema.safeParse(body);

	if (!parsed.success) {
		log.warn("POST /chat/stream — validation failed", parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { sessionId, conversationId } = parsed.data;
	const db = getDb();

	const conversation = await db.conversation.findUnique({
		where: { id: conversationId },
	});
	if (!conversation || conversation.sessionId !== sessionId) {
		return c.json({ error: "Conversation not found" }, 404);
	}

	// Reconnect to an actively-streaming conversation (completed streams are skipped)
	const existingStream = getStream(conversationId);
	if (existingStream && existingStream.status === "streaming") {
		log.info(`POST /chat/stream — reconnecting to active stream for ${conversationId}`);
		return pipeStreamToSSE(c, conversationId);
	}

	return launchChatStream(c, db, parsed.data);
});
