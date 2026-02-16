import { createLogger, getDb, updateFileSchema, uploadFileMetadataSchema } from "@cramkit/shared";
import { Hono } from "hono";
import { enqueueProcessing } from "../lib/queue.js";
import { deleteSessionFile, saveRawFile } from "../services/storage.js";

const log = createLogger("api");

export const filesRoutes = new Hono();

// Upload file to a session
filesRoutes.post("/sessions/:sessionId/files", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const session = await db.session.findUnique({ where: { id: sessionId } });
	if (!session) {
		log.warn(`POST /sessions/${sessionId}/files — session not found`);
		return c.json({ error: "Session not found" }, 404);
	}

	const formData = await c.req.formData();
	const file = formData.get("file") as File | null;
	const type = formData.get("type") as string;
	const label = formData.get("label") as string | null;

	if (!file) {
		log.warn(`POST /sessions/${sessionId}/files — no file provided`);
		return c.json({ error: "No file provided" }, 400);
	}

	const metaParsed = uploadFileMetadataSchema.safeParse({ type, label: label || undefined });
	if (!metaParsed.success) {
		log.warn(`POST /sessions/${sessionId}/files — invalid metadata`, metaParsed.error.flatten());
		return c.json({ error: metaParsed.error.flatten() }, 400);
	}

	log.info(`POST /sessions/${sessionId}/files — uploading "${file.name}" (${file.size} bytes, type=${type})`);

	const rawPath = await saveRawFile(sessionId, file.name, Buffer.from(await file.arrayBuffer()));

	const fileRecord = await db.file.create({
		data: {
			sessionId,
			filename: file.name,
			type: metaParsed.data.type,
			label: metaParsed.data.label ?? null,
			rawPath,
		},
	});

	enqueueProcessing(fileRecord.id);

	log.info(`POST /sessions/${sessionId}/files — created file ${fileRecord.id}, queued for processing`);
	return c.json(fileRecord, 201);
});

// List files for session
filesRoutes.get("/sessions/:sessionId/files", async (c) => {
	const db = getDb();
	const files = await db.file.findMany({
		where: { sessionId: c.req.param("sessionId") },
		orderBy: { createdAt: "desc" },
	});
	log.info(`GET /sessions/${c.req.param("sessionId")}/files — found ${files.length} files`);
	return c.json(files);
});

// Get file detail
filesRoutes.get("/:id", async (c) => {
	const db = getDb();
	const file = await db.file.findUnique({
		where: { id: c.req.param("id") },
		include: { chunks: { orderBy: { index: "asc" } } },
	});

	if (!file) {
		log.warn(`GET /files/${c.req.param("id")} — not found`);
		return c.json({ error: "File not found" }, 404);
	}
	log.info(`GET /files/${file.id} — found "${file.filename}"`);
	return c.json(file);
});

// Update file metadata
filesRoutes.patch("/:id", async (c) => {
	const db = getDb();
	const body = await c.req.json();
	const parsed = updateFileSchema.safeParse(body);

	if (!parsed.success) {
		log.warn(`PATCH /files/${c.req.param("id")} — validation failed`, parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const file = await db.file.update({
		where: { id: c.req.param("id") },
		data: parsed.data,
	});

	log.info(`PATCH /files/${file.id} — updated`);
	return c.json(file);
});

// Delete file
filesRoutes.delete("/:id", async (c) => {
	const db = getDb();
	const file = await db.file.findUnique({ where: { id: c.req.param("id") } });
	if (!file) {
		log.warn(`DELETE /files/${c.req.param("id")} — not found`);
		return c.json({ error: "File not found" }, 404);
	}

	await deleteSessionFile(file.sessionId, file.rawPath);
	if (file.processedPath) {
		await deleteSessionFile(file.sessionId, file.processedPath);
	}
	await db.file.delete({ where: { id: file.id } });

	log.info(`DELETE /files/${file.id} — deleted "${file.filename}"`);
	return c.json({ ok: true });
});

// Get file processing status
filesRoutes.get("/:id/status", async (c) => {
	const db = getDb();
	const file = await db.file.findUnique({ where: { id: c.req.param("id") } });
	if (!file) {
		log.warn(`GET /files/${c.req.param("id")}/status — not found`);
		return c.json({ error: "File not found" }, 404);
	}

	let status: string;
	if (file.isIndexed) {
		status = "ready";
	} else if (file.processedPath) {
		status = "indexing";
	} else {
		status = "converting";
	}

	log.debug(`GET /files/${c.req.param("id")}/status — ${status}`);
	return c.json({ status });
});
