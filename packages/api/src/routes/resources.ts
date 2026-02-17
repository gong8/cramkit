import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createLogger, createResourceSchema, getDb, updateResourceSchema } from "@cramkit/shared";
import type { Context } from "hono";
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

async function findResourceOr404(
	c: Context,
	id: string,
	include?: { files?: boolean; chunks?: boolean },
) {
	const resource = await findResource(id, include);
	if (!resource) return c.json({ error: "Resource not found" }, 404);
	return resource;
}

async function findFileInResource(c: Context, resourceId: string, fileId: string) {
	const file = await getDb().file.findUnique({ where: { id: fileId } });
	if (!file || file.resourceId !== resourceId) {
		return c.json({ error: "File not found in this resource" }, 404);
	}
	return file;
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

function parseFormMetadata(formData: FormData) {
	return createResourceSchema.safeParse({
		name: formData.get("name") as string,
		type: formData.get("type") as string,
		label: (formData.get("label") as string | null) || undefined,
		splitMode: (formData.get("splitMode") as string | null) || undefined,
	});
}

async function addToExistingLectureNotes(
	sessionId: string,
	existingId: string,
	formData: FormData,
) {
	const allFiles = collectFormFiles(formData);
	if (allFiles.length === 0) return { error: "No files provided" } as const;

	await saveFiles(sessionId, existingId, allFiles, "PRIMARY");
	await reprocessResource(existingId);

	log.info(
		`POST /sessions/${sessionId}/resources — added ${allFiles.length} files to existing lecture notes resource ${existingId}`,
	);
	return { resource: await findResource(existingId, { files: true }) } as const;
}

type ResourceMeta = ReturnType<typeof createResourceSchema.parse>;

async function createResourceWithFiles(sessionId: string, meta: ResourceMeta, formData: FormData) {
	const db = getDb();
	const resource = await db.resource.create({
		data: {
			sessionId,
			name: meta.name,
			type: meta.type,
			label: meta.label ?? null,
			splitMode: meta.splitMode,
		},
	});

	await saveFiles(sessionId, resource.id, collectFormFiles(formData), "PRIMARY");

	const markSchemeFile = formData.get("markScheme") as File | null;
	if (markSchemeFile) await saveFiles(sessionId, resource.id, [markSchemeFile], "MARK_SCHEME");

	const solutionsFile = formData.get("solutions") as File | null;
	if (solutionsFile) await saveFiles(sessionId, resource.id, [solutionsFile], "SOLUTIONS");

	enqueueProcessing(resource.id);

	log.info(
		`POST /sessions/${sessionId}/resources — created resource ${resource.id}, queued for processing`,
	);
	return findResource(resource.id, { files: true });
}

async function deleteFullResource(resourceId: string, sessionId: string) {
	await deleteResourceRelationships(resourceId);
	await deleteResourceDir(sessionId, resourceId);
	await getDb().resource.delete({ where: { id: resourceId } });
}

const MIME_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".txt": "text/plain",
};

// ── Routes ──────────────────────────────────────────────────────────

resourcesRoutes.post("/sessions/:sessionId/resources", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const session = await db.session.findUnique({ where: { id: sessionId } });
	if (!session) {
		log.warn(`POST /sessions/${sessionId}/resources — session not found`);
		return c.json({ error: "Session not found" }, 404);
	}

	const formData = await c.req.formData();
	const metaParsed = parseFormMetadata(formData);
	if (!metaParsed.success) {
		log.warn(
			`POST /sessions/${sessionId}/resources — invalid metadata`,
			metaParsed.error.flatten(),
		);
		return c.json({ error: metaParsed.error.flatten() }, 400);
	}

	if (metaParsed.data.type === "LECTURE_NOTES") {
		const existing = await db.resource.findFirst({
			where: { sessionId, type: "LECTURE_NOTES" },
		});
		if (existing) {
			const result = await addToExistingLectureNotes(sessionId, existing.id, formData);
			if ("error" in result) return c.json({ error: result.error }, 400);
			return c.json(result.resource, 200);
		}
	}

	return c.json(await createResourceWithFiles(sessionId, metaParsed.data, formData), 201);
});

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

resourcesRoutes.get("/:id", async (c) => {
	const result = await findResourceOr404(c, c.req.param("id"), { files: true, chunks: true });
	if (result instanceof Response) return result;
	log.info(`GET /resources/${result.id} — found "${result.name}"`);
	return c.json(result);
});

resourcesRoutes.get("/:id/content", async (c) => {
	const result = await findResourceOr404(c, c.req.param("id"));
	if (result instanceof Response) return result;
	if (!result.isIndexed) return c.json({ error: "Resource not yet processed" }, 404);

	const content = await readResourceContent(result.sessionId, result.id);
	log.info(`GET /resources/${result.id}/content — ${content.length} chars`);
	return c.json({ id: result.id, name: result.name, type: result.type, content });
});

resourcesRoutes.get("/:id/tree", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");
	const result = await findResourceOr404(c, resourceId);
	if (result instanceof Response) return result;

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

resourcesRoutes.delete("/:id", async (c) => {
	const result = await findResourceOr404(c, c.req.param("id"));
	if (result instanceof Response) return result;

	await deleteFullResource(result.id, result.sessionId);
	log.info(`DELETE /resources/${result.id} — deleted "${result.name}"`);
	return c.json({ ok: true });
});

resourcesRoutes.post("/:id/files", async (c) => {
	const resourceId = c.req.param("id");
	const result = await findResourceOr404(c, resourceId);
	if (result instanceof Response) return result;

	const formData = await c.req.formData();
	const role = (formData.get("role") as string) || "PRIMARY";
	const allFiles = collectFormFiles(formData);
	if (allFiles.length === 0) return c.json({ error: "No files provided" }, 400);

	await saveFiles(result.sessionId, resourceId, allFiles, role);
	await reprocessResource(resourceId);

	log.info(`POST /resources/${resourceId}/files — added ${allFiles.length} files, re-processing`);
	return c.json(await findResource(resourceId, { files: true }));
});

resourcesRoutes.delete("/:id/files/:fileId", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("id");
	const fileId = c.req.param("fileId");

	const fileResult = await findFileInResource(c, resourceId, fileId);
	if (fileResult instanceof Response) return fileResult;

	await db.file.delete({ where: { id: fileId } });

	const remainingFiles = await db.file.count({ where: { resourceId } });
	if (remainingFiles > 0) {
		await reprocessResource(resourceId);
		log.info(`DELETE /resources/${resourceId}/files/${fileId} — file removed, re-processing`);
		return c.json({ ok: true });
	}

	const resource = await findResourceOr404(c, resourceId);
	if (resource instanceof Response) return resource;

	await deleteFullResource(resourceId, resource.sessionId);
	log.info(`DELETE /resources/${resourceId}/files/${fileId} — last file removed, resource deleted`);
	return c.json({ ok: true, resourceDeleted: true });
});

resourcesRoutes.get("/:id/files/:fileId/raw", async (c) => {
	const fileResult = await findFileInResource(c, c.req.param("id"), c.req.param("fileId"));
	if (fileResult instanceof Response) return fileResult;

	try {
		const data = await readFile(fileResult.rawPath);
		const ext = extname(fileResult.filename).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		return new Response(data, {
			headers: {
				"Content-Type": contentType,
				"Content-Disposition": `inline; filename="${fileResult.filename}"`,
			},
		});
	} catch {
		log.error(
			`GET /resources/${c.req.param("id")}/files/${fileResult.id}/raw — file not found on disk`,
		);
		return c.json({ error: "File not found on disk" }, 404);
	}
});
