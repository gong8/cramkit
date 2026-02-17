import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createLogger, createResourceSchema, getDb, updateResourceSchema } from "@cramkit/shared";
import { Hono } from "hono";
import { enqueueProcessing } from "../lib/queue.js";
import {
	deleteResourceDir,
	readResourceContent,
	saveResourceRawFile,
} from "../services/storage.js";

const log = createLogger("api");

export const resourcesRoutes = new Hono();

// ── Shared helpers ──────────────────────────────────────────────────

function collectFormFiles(formData: FormData): File[] {
	const files = formData.getAll("files") as File[];
	const single = formData.get("file") as File | null;
	return single ? [single, ...files] : files;
}

async function saveFiles(sessionId: string, resourceId: string, files: File[], role: string) {
	const db = getDb();
	for (const f of files) {
		const rawPath = await saveResourceRawFile(
			sessionId,
			resourceId,
			f.name,
			Buffer.from(await f.arrayBuffer()),
		);
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
}

async function reprocessResource(resourceId: string) {
	const db = getDb();
	await db.resource.update({
		where: { id: resourceId },
		data: { isIndexed: false, isGraphIndexed: false },
	});
	enqueueProcessing(resourceId);
}

async function deleteResourceRelationships(resourceId: string) {
	const db = getDb();
	const chunkIds = (
		await db.chunk.findMany({
			where: { resourceId },
			select: { id: true },
		})
	).map((c) => c.id);

	const entityIds = [resourceId, ...chunkIds];
	await db.relationship.deleteMany({
		where: {
			OR: [{ sourceId: { in: entityIds } }, { targetId: { in: entityIds } }],
		},
	});
}

async function findResource(id: string, include?: { files?: boolean; chunks?: boolean }) {
	const db = getDb();
	return db.resource.findUnique({
		where: { id },
		include: {
			files: include?.files ?? false,
			chunks: include?.chunks ? { orderBy: { index: "asc" as const } } : false,
		},
	});
}

function buildChunkTree<T extends { id: string; parentId: string | null }>(
	chunks: T[],
): (T & { children: (T & { children: unknown[] })[] })[] {
	type TreeNode = T & { children: TreeNode[] };
	const map = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];

	for (const chunk of chunks) {
		map.set(chunk.id, { ...chunk, children: [] });
	}
	for (const chunk of chunks) {
		const node = map.get(chunk.id) as TreeNode;
		const parent = chunk.parentId ? map.get(chunk.parentId) : undefined;
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

// ── Routes ──────────────────────────────────────────────────────────

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
		log.warn(
			`POST /sessions/${sessionId}/resources — invalid metadata`,
			metaParsed.error.flatten(),
		);
		return c.json({ error: metaParsed.error.flatten() }, 400);
	}

	// For LECTURE_NOTES, check if session already has one → add to existing
	if (metaParsed.data.type === "LECTURE_NOTES") {
		const existing = await db.resource.findFirst({
			where: { sessionId, type: "LECTURE_NOTES" },
		});
		if (existing) {
			const allFiles = collectFormFiles(formData);
			if (allFiles.length === 0) return c.json({ error: "No files provided" }, 400);

			await saveFiles(sessionId, existing.id, allFiles, "PRIMARY");
			await reprocessResource(existing.id);

			log.info(
				`POST /sessions/${sessionId}/resources — added ${allFiles.length} files to existing lecture notes resource ${existing.id}`,
			);
			return c.json(await findResource(existing.id, { files: true }), 200);
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

	const allPrimaryFiles = collectFormFiles(formData);
	await saveFiles(sessionId, resource.id, allPrimaryFiles, "PRIMARY");

	const markSchemeFile = formData.get("markScheme") as File | null;
	if (markSchemeFile) await saveFiles(sessionId, resource.id, [markSchemeFile], "MARK_SCHEME");

	const solutionsFile = formData.get("solutions") as File | null;
	if (solutionsFile) await saveFiles(sessionId, resource.id, [solutionsFile], "SOLUTIONS");

	enqueueProcessing(resource.id);

	log.info(
		`POST /sessions/${sessionId}/resources — created resource ${resource.id}, queued for processing`,
	);
	return c.json(await findResource(resource.id, { files: true }), 201);
});

// List resources for session
resourcesRoutes.get("/sessions/:sessionId/resources", async (c) => {
	const db = getDb();
	const resources = await db.resource.findMany({
		where: { sessionId: c.req.param("sessionId") },
		include: { files: true },
		orderBy: { createdAt: "desc" },
	});
	log.info(
		`GET /sessions/${c.req.param("sessionId")}/resources — found ${resources.length} resources`,
	);
	return c.json(resources);
});

// Get resource detail
resourcesRoutes.get("/:id", async (c) => {
	const resource = await findResource(c.req.param("id"), { files: true, chunks: true });
	if (!resource) {
		log.warn(`GET /resources/${c.req.param("id")} — not found`);
		return c.json({ error: "Resource not found" }, 404);
	}
	log.info(`GET /resources/${resource.id} — found "${resource.name}"`);
	return c.json(resource);
});

// Get resource content (all processed markdown concatenated)
resourcesRoutes.get("/:id/content", async (c) => {
	const resource = await findResource(c.req.param("id"));
	if (!resource) return c.json({ error: "Resource not found" }, 404);
	if (!resource.isIndexed) return c.json({ error: "Resource not yet processed" }, 404);

	const content = await readResourceContent(resource.sessionId, resource.id);
	log.info(`GET /resources/${resource.id}/content — ${content.length} chars`);
	return c.json({ id: resource.id, name: resource.name, type: resource.type, content });
});

// Get resource chunk tree (for TOC rendering)
resourcesRoutes.get("/:id/tree", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");

	const resource = await findResource(resourceId);
	if (!resource) return c.json({ error: "Resource not found" }, 404);

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

	log.info(`GET /resources/${resourceId}/tree — ${chunks.length} chunks`);
	return c.json(buildChunkTree(chunks));
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
	const resource = await findResource(c.req.param("id"));
	if (!resource) {
		log.warn(`DELETE /resources/${c.req.param("id")} — not found`);
		return c.json({ error: "Resource not found" }, 404);
	}

	await deleteResourceRelationships(resource.id);
	await deleteResourceDir(resource.sessionId, resource.id);
	await getDb().resource.delete({ where: { id: resource.id } });

	log.info(`DELETE /resources/${resource.id} — deleted "${resource.name}"`);
	return c.json({ ok: true });
});

// Add file(s) to existing resource → auto re-process
resourcesRoutes.post("/:id/files", async (c) => {
	const resourceId = c.req.param("id");
	const resource = await findResource(resourceId);
	if (!resource) return c.json({ error: "Resource not found" }, 404);

	const formData = await c.req.formData();
	const role = (formData.get("role") as string) || "PRIMARY";
	const allFiles = collectFormFiles(formData);
	if (allFiles.length === 0) return c.json({ error: "No files provided" }, 400);

	await saveFiles(resource.sessionId, resourceId, allFiles, role);
	await reprocessResource(resourceId);

	const result = await findResource(resourceId, { files: true });
	log.info(`POST /resources/${resourceId}/files — added ${allFiles.length} files, re-processing`);
	return c.json(result);
});

// Remove file from resource → auto re-process (or delete resource if last file)
resourcesRoutes.delete("/:id/files/:fileId", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");
	const fileId = c.req.param("fileId");

	const file = await db.file.findUnique({ where: { id: fileId } });
	if (!file || file.resourceId !== resourceId) {
		return c.json({ error: "File not found in this resource" }, 404);
	}

	await db.file.delete({ where: { id: fileId } });

	const remainingFiles = await db.file.count({ where: { resourceId } });
	if (remainingFiles > 0) {
		await reprocessResource(resourceId);
		log.info(`DELETE /resources/${resourceId}/files/${fileId} — file removed, re-processing`);
		return c.json({ ok: true });
	}

	const resource = await findResource(resourceId);
	if (!resource) return c.json({ error: "Resource not found" }, 404);

	await deleteResourceRelationships(resourceId);
	await deleteResourceDir(resource.sessionId, resourceId);
	await db.resource.delete({ where: { id: resourceId } });
	log.info(`DELETE /resources/${resourceId}/files/${fileId} — last file removed, resource deleted`);
	return c.json({ ok: true, resourceDeleted: true });
});

// Serve raw file (PDF, etc.)
const MIME_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".txt": "text/plain",
};

resourcesRoutes.get("/:id/files/:fileId/raw", async (c) => {
	const db = getDb();
	const file = await db.file.findUnique({ where: { id: c.req.param("fileId") } });
	if (!file || file.resourceId !== c.req.param("id")) {
		return c.json({ error: "File not found" }, 404);
	}

	try {
		const data = await readFile(file.rawPath);
		const ext = extname(file.filename).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		return new Response(data, {
			headers: {
				"Content-Type": contentType,
				"Content-Disposition": `inline; filename="${file.filename}"`,
			},
		});
	} catch {
		log.error(`GET /resources/${c.req.param("id")}/files/${file.id}/raw — file not found on disk`);
		return c.json({ error: "File not found on disk" }, 404);
	}
});
