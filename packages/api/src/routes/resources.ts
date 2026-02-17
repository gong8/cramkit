import { createLogger, createResourceSchema, getDb, updateResourceSchema } from "@cramkit/shared";
import { Hono } from "hono";
import { enqueueProcessing } from "../lib/queue.js";
import { deleteResourceDir, readResourceContent, saveResourceRawFile } from "../services/storage.js";

const log = createLogger("api");

export const resourcesRoutes = new Hono();

// Create resource + upload files (multipart)
resourcesRoutes.post("/sessions/:sessionId/resources", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const session = await db.session.findUnique({ where: { id: sessionId } });
	if (!session) {
		log.warn(`POST /sessions/${sessionId}/resources — session not found`);
		return c.json({ error: "Session not found" }, 404);
	}

	const formData = await c.req.formData();
	const name = formData.get("name") as string;
	const type = formData.get("type") as string;
	const label = formData.get("label") as string | null;
	const splitMode = formData.get("splitMode") as string | null;

	const metaParsed = createResourceSchema.safeParse({
		name,
		type,
		label: label || undefined,
		splitMode: splitMode || undefined,
	});
	if (!metaParsed.success) {
		log.warn(`POST /sessions/${sessionId}/resources — invalid metadata`, metaParsed.error.flatten());
		return c.json({ error: metaParsed.error.flatten() }, 400);
	}

	// For LECTURE_NOTES, check if session already has one → add to existing
	if (metaParsed.data.type === "LECTURE_NOTES") {
		const existing = await db.resource.findFirst({
			where: { sessionId, type: "LECTURE_NOTES" },
		});
		if (existing) {
			// Add files to existing lecture notes resource instead
			const files = formData.getAll("files") as File[];
			const file = formData.get("file") as File | null;
			const allFiles = file ? [file, ...files] : files;

			if (allFiles.length === 0) {
				return c.json({ error: "No files provided" }, 400);
			}

			for (const f of allFiles) {
				const rawPath = await saveResourceRawFile(sessionId, existing.id, f.name, Buffer.from(await f.arrayBuffer()));
				await db.file.create({
					data: {
						resourceId: existing.id,
						filename: f.name,
						role: "PRIMARY",
						rawPath,
						fileSize: f.size,
					},
				});
			}

			// Re-process
			await db.resource.update({
				where: { id: existing.id },
				data: { isIndexed: false, isGraphIndexed: false },
			});
			enqueueProcessing(existing.id);

			const resource = await db.resource.findUnique({
				where: { id: existing.id },
				include: { files: true },
			});

			log.info(`POST /sessions/${sessionId}/resources — added ${allFiles.length} files to existing lecture notes resource ${existing.id}`);
			return c.json(resource, 200);
		}
	}

	// Create new resource
	const resource = await db.resource.create({
		data: {
			sessionId,
			name: metaParsed.data.name,
			type: metaParsed.data.type,
			label: metaParsed.data.label ?? null,
			splitMode: metaParsed.data.splitMode,
		},
	});

	// Process files from form data
	const primaryFiles = formData.getAll("files") as File[];
	const singleFile = formData.get("file") as File | null;
	const allPrimaryFiles = singleFile ? [singleFile, ...primaryFiles] : primaryFiles;

	for (const f of allPrimaryFiles) {
		const rawPath = await saveResourceRawFile(sessionId, resource.id, f.name, Buffer.from(await f.arrayBuffer()));
		await db.file.create({
			data: {
				resourceId: resource.id,
				filename: f.name,
				role: "PRIMARY",
				rawPath,
				fileSize: f.size,
			},
		});
	}

	// Optional mark scheme / solutions file
	const markSchemeFile = formData.get("markScheme") as File | null;
	if (markSchemeFile) {
		const rawPath = await saveResourceRawFile(sessionId, resource.id, markSchemeFile.name, Buffer.from(await markSchemeFile.arrayBuffer()));
		await db.file.create({
			data: {
				resourceId: resource.id,
				filename: markSchemeFile.name,
				role: "MARK_SCHEME",
				rawPath,
				fileSize: markSchemeFile.size,
			},
		});
	}

	const solutionsFile = formData.get("solutions") as File | null;
	if (solutionsFile) {
		const rawPath = await saveResourceRawFile(sessionId, resource.id, solutionsFile.name, Buffer.from(await solutionsFile.arrayBuffer()));
		await db.file.create({
			data: {
				resourceId: resource.id,
				filename: solutionsFile.name,
				role: "SOLUTIONS",
				rawPath,
				fileSize: solutionsFile.size,
			},
		});
	}

	enqueueProcessing(resource.id);

	const result = await db.resource.findUnique({
		where: { id: resource.id },
		include: { files: true },
	});

	log.info(`POST /sessions/${sessionId}/resources — created resource ${resource.id}, queued for processing`);
	return c.json(result, 201);
});

// List resources for session
resourcesRoutes.get("/sessions/:sessionId/resources", async (c) => {
	const db = getDb();
	const resources = await db.resource.findMany({
		where: { sessionId: c.req.param("sessionId") },
		include: { files: true },
		orderBy: { createdAt: "desc" },
	});
	log.info(`GET /sessions/${c.req.param("sessionId")}/resources — found ${resources.length} resources`);
	return c.json(resources);
});

// Get resource detail
resourcesRoutes.get("/:id", async (c) => {
	const db = getDb();
	const resource = await db.resource.findUnique({
		where: { id: c.req.param("id") },
		include: { files: true, chunks: { orderBy: { index: "asc" } } },
	});

	if (!resource) {
		log.warn(`GET /resources/${c.req.param("id")} — not found`);
		return c.json({ error: "Resource not found" }, 404);
	}
	log.info(`GET /resources/${resource.id} — found "${resource.name}"`);
	return c.json(resource);
});

// Get resource content (all processed markdown concatenated)
resourcesRoutes.get("/:id/content", async (c) => {
	const db = getDb();
	const resource = await db.resource.findUnique({ where: { id: c.req.param("id") } });
	if (!resource) {
		return c.json({ error: "Resource not found" }, 404);
	}
	if (!resource.isIndexed) {
		return c.json({ error: "Resource not yet processed" }, 404);
	}

	const content = await readResourceContent(resource.sessionId, resource.id);
	log.info(`GET /resources/${resource.id}/content — ${content.length} chars`);
	return c.json({ id: resource.id, name: resource.name, type: resource.type, content });
});

// Get resource chunk tree (for TOC rendering)
resourcesRoutes.get("/:id/tree", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");

	const resource = await db.resource.findUnique({ where: { id: resourceId } });
	if (!resource) {
		return c.json({ error: "Resource not found" }, 404);
	}

	const chunks = await db.chunk.findMany({
		where: { resourceId },
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

	log.info(`GET /resources/${resourceId}/tree — ${chunks.length} chunks`);
	return c.json(roots);
});

// Update resource metadata
resourcesRoutes.patch("/:id", async (c) => {
	const db = getDb();
	const body = await c.req.json();
	const parsed = updateResourceSchema.safeParse(body);

	if (!parsed.success) {
		log.warn(`PATCH /resources/${c.req.param("id")} — validation failed`, parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const resource = await db.resource.update({
		where: { id: c.req.param("id") },
		data: parsed.data,
	});

	log.info(`PATCH /resources/${resource.id} — updated`);
	return c.json(resource);
});

// Delete resource
resourcesRoutes.delete("/:id", async (c) => {
	const db = getDb();
	const resource = await db.resource.findUnique({
		where: { id: c.req.param("id") },
		include: { files: true },
	});
	if (!resource) {
		log.warn(`DELETE /resources/${c.req.param("id")} — not found`);
		return c.json({ error: "Resource not found" }, 404);
	}

	// Clean up relationships referencing this resource or its chunks
	const chunkIds = (await db.chunk.findMany({
		where: { resourceId: resource.id },
		select: { id: true },
	})).map((c) => c.id);

	const sourceIds = [resource.id, ...chunkIds];
	await db.relationship.deleteMany({
		where: {
			OR: [
				{ sourceId: { in: sourceIds } },
				{ targetId: { in: sourceIds } },
			],
		},
	});

	// Delete resource directory from disk
	await deleteResourceDir(resource.sessionId, resource.id);

	// Delete resource (cascades to files + chunks)
	await db.resource.delete({ where: { id: resource.id } });

	log.info(`DELETE /resources/${resource.id} — deleted "${resource.name}"`);
	return c.json({ ok: true });
});

// Add file(s) to existing resource → auto re-process
resourcesRoutes.post("/:id/files", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");

	const resource = await db.resource.findUnique({ where: { id: resourceId } });
	if (!resource) {
		return c.json({ error: "Resource not found" }, 404);
	}

	const formData = await c.req.formData();
	const role = (formData.get("role") as string) || "PRIMARY";
	const files = formData.getAll("files") as File[];
	const singleFile = formData.get("file") as File | null;
	const allFiles = singleFile ? [singleFile, ...files] : files;

	if (allFiles.length === 0) {
		return c.json({ error: "No files provided" }, 400);
	}

	for (const f of allFiles) {
		const rawPath = await saveResourceRawFile(resource.sessionId, resourceId, f.name, Buffer.from(await f.arrayBuffer()));
		await db.file.create({
			data: {
				resourceId,
				filename: f.name,
				role: role as "PRIMARY" | "MARK_SCHEME" | "SOLUTIONS" | "SUPPLEMENT",
				rawPath,
				fileSize: f.size,
			},
		});
	}

	// Re-process
	await db.resource.update({
		where: { id: resourceId },
		data: { isIndexed: false, isGraphIndexed: false },
	});
	enqueueProcessing(resourceId);

	const result = await db.resource.findUnique({
		where: { id: resourceId },
		include: { files: true },
	});

	log.info(`POST /resources/${resourceId}/files — added ${allFiles.length} files, re-processing`);
	return c.json(result);
});

// Remove file from resource → auto re-process
resourcesRoutes.delete("/:id/files/:fileId", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");
	const fileId = c.req.param("fileId");

	const file = await db.file.findUnique({ where: { id: fileId } });
	if (!file || file.resourceId !== resourceId) {
		return c.json({ error: "File not found in this resource" }, 404);
	}

	await db.file.delete({ where: { id: fileId } });

	// Check if resource still has files
	const remainingFiles = await db.file.count({ where: { resourceId } });
	if (remainingFiles === 0) {
		// Delete the entire resource if no files left
		const parentResource = (await db.resource.findUnique({ where: { id: resourceId } }))!;
		await deleteResourceDir(parentResource.sessionId, resourceId);
		await db.resource.delete({ where: { id: resourceId } });
		log.info(`DELETE /resources/${resourceId}/files/${fileId} — last file removed, resource deleted`);
		return c.json({ ok: true, resourceDeleted: true });
	}

	// Re-process
	await db.resource.update({
		where: { id: resourceId },
		data: { isIndexed: false, isGraphIndexed: false },
	});
	enqueueProcessing(resourceId);

	log.info(`DELETE /resources/${resourceId}/files/${fileId} — file removed, re-processing`);
	return c.json({ ok: true });
});
