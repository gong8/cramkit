import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chatStreamRequestSchema, createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { streamCliChat } from "../services/cli-chat.js";
import { getStream, startStream } from "../services/stream-manager.js";
import {
	autoTitleConversation,
	collectImagePaths,
	loadConversationHistory,
	loadSessionWithPrompt,
	persistUserMessage,
	pipeStreamToSSE,
} from "./chat-helpers.js";

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

	const { sessionId, conversationId, message, attachmentIds, rewindToMessageId } = parsed.data;
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

	const persistResult = await persistUserMessage(db, {
		conversationId,
		message,
		attachmentIds,
		rewindToMessageId,
	});
	if (persistResult.error) {
		return c.json({ error: persistResult.error }, 404);
	}

	const history = await loadConversationHistory(db, conversationId);
	const imagePaths = collectImagePaths(history);
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
		images: imagePaths.length > 0 ? imagePaths : undefined,
	});
	startStream(conversationId, cliStream, db);

	return pipeStreamToSSE(c, conversationId);
});
