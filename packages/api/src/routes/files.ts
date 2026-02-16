import { createLogger, getDb, fileLinkSchema, fileUnlinkSchema, updateFileSchema, uploadFileMetadataSchema } from "@cramkit/shared";
import { Hono } from "hono";
import { enqueueProcessing } from "../lib/queue.js";
import { deleteProcessedTree, deleteSessionFile, saveRawFile } from "../services/storage.js";

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
	const splitMode = formData.get("splitMode") as string | null;

	if (!file) {
		log.warn(`POST /sessions/${sessionId}/files — no file provided`);
		return c.json({ error: "No file provided" }, 400);
	}

	const metaParsed = uploadFileMetadataSchema.safeParse({
		type,
		label: label || undefined,
		splitMode: splitMode || undefined,
	});
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
			splitMode: metaParsed.data.splitMode,
			rawPath,
			fileSize: file.size,
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
	// Clean up processed tree directory if it exists
	const fileSlug = file.filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
	await deleteProcessedTree(file.sessionId, fileSlug);

	// Clean up file-to-file relationships
	await db.relationship.deleteMany({
		where: {
			OR: [
				{ sourceType: "file", sourceId: file.id, targetType: "file" },
				{ targetType: "file", targetId: file.id, sourceType: "file" },
			],
		},
	});

	await db.file.delete({ where: { id: file.id } });

	log.info(`DELETE /files/${file.id} — deleted "${file.filename}"`);
	return c.json({ ok: true });
});

// Get file chunk tree (for TOC rendering)
filesRoutes.get("/:id/tree", async (c) => {
	const db = getDb();
	const fileId = c.req.param("id");

	const file = await db.file.findUnique({ where: { id: fileId } });
	if (!file) {
		return c.json({ error: "File not found" }, 404);
	}

	// Fetch all chunks for this file
	const chunks = await db.chunk.findMany({
		where: { fileId },
		orderBy: { index: "asc" },
		select: {
			id: true,
			parentId: true,
			index: true,
			depth: true,
			nodeType: true,
			slug: true,
			diskPath: true,
			title: true,
			startPage: true,
			endPage: true,
		},
	});

	// Build tree structure
	interface TreeChunk {
		id: string;
		parentId: string | null;
		index: number;
		depth: number;
		nodeType: string;
		slug: string | null;
		diskPath: string | null;
		title: string | null;
		startPage: number | null;
		endPage: number | null;
		children: TreeChunk[];
	}

	const chunkMap = new Map<string, TreeChunk>();
	const roots: TreeChunk[] = [];

	for (const chunk of chunks) {
		chunkMap.set(chunk.id, { ...chunk, children: [] });
	}

	for (const chunk of chunks) {
		const node = chunkMap.get(chunk.id)!;
		if (chunk.parentId && chunkMap.has(chunk.parentId)) {
			chunkMap.get(chunk.parentId)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	log.info(`GET /files/${fileId}/tree — ${chunks.length} chunks`);
	return c.json(roots);
});

// Link two files (e.g., paper -> mark scheme)
filesRoutes.post("/:id/link", async (c) => {
	const db = getDb();
	const sourceFileId = c.req.param("id");
	const body = await c.req.json();
	const parsed = fileLinkSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const sourceFile = await db.file.findUnique({ where: { id: sourceFileId } });
	const targetFile = await db.file.findUnique({ where: { id: parsed.data.targetFileId } });

	if (!sourceFile || !targetFile) {
		return c.json({ error: "File not found" }, 404);
	}

	if (sourceFile.sessionId !== targetFile.sessionId) {
		return c.json({ error: "Files must be in the same session" }, 400);
	}

	const relationship = await db.relationship.create({
		data: {
			sessionId: sourceFile.sessionId,
			sourceType: "file",
			sourceId: sourceFileId,
			sourceLabel: sourceFile.label || sourceFile.filename,
			targetType: "file",
			targetId: parsed.data.targetFileId,
			targetLabel: targetFile.label || targetFile.filename,
			relationship: parsed.data.relationship,
			createdBy: "system",
		},
	});

	log.info(`POST /files/${sourceFileId}/link — linked to ${parsed.data.targetFileId} (${parsed.data.relationship})`);
	return c.json(relationship, 201);
});

// Unlink two files
filesRoutes.delete("/:id/unlink", async (c) => {
	const db = getDb();
	const sourceFileId = c.req.param("id");
	const body = await c.req.json();
	const parsed = fileUnlinkSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	await db.relationship.deleteMany({
		where: {
			sourceType: "file",
			sourceId: sourceFileId,
			targetType: "file",
			targetId: parsed.data.targetFileId,
		},
	});

	log.info(`DELETE /files/${sourceFileId}/unlink — unlinked from ${parsed.data.targetFileId}`);
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
