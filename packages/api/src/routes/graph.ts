import { createLogger, getDb, indexFileRequestSchema } from "@cramkit/shared";
import { Hono } from "hono";
import { enqueueGraphIndexing, enqueueSessionGraphIndexing, getIndexingQueueSize } from "../lib/queue.js";

const log = createLogger("api");

export const graphRoutes = new Hono();

// List concepts for session
graphRoutes.get("/sessions/:sessionId/concepts", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const concepts = await db.concept.findMany({
		where: { sessionId },
		orderBy: { name: "asc" },
	});

	log.info(`GET /graph/sessions/${sessionId}/concepts — found ${concepts.length}`);
	return c.json(concepts);
});

// Get concept detail with relationships
graphRoutes.get("/concepts/:id", async (c) => {
	const db = getDb();
	const id = c.req.param("id");

	const concept = await db.concept.findUnique({ where: { id } });
	if (!concept) {
		return c.json({ error: "Concept not found" }, 404);
	}

	const relationships = await db.relationship.findMany({
		where: {
			sessionId: concept.sessionId,
			OR: [
				{ sourceType: "concept", sourceId: id },
				{ targetType: "concept", targetId: id },
			],
		},
	});

	log.info(`GET /graph/concepts/${id} — "${concept.name}", ${relationships.length} relationships`);
	return c.json({ ...concept, relationships });
});

// Delete concept + its relationships
graphRoutes.delete("/concepts/:id", async (c) => {
	const db = getDb();
	const id = c.req.param("id");

	const concept = await db.concept.findUnique({ where: { id } });
	if (!concept) {
		return c.json({ error: "Concept not found" }, 404);
	}

	// Delete relationships involving this concept
	await db.relationship.deleteMany({
		where: {
			sessionId: concept.sessionId,
			OR: [
				{ sourceType: "concept", sourceId: id },
				{ targetType: "concept", targetId: id },
			],
		},
	});

	await db.concept.delete({ where: { id } });

	log.info(`DELETE /graph/concepts/${id} — deleted "${concept.name}"`);
	return c.json({ ok: true });
});

// Get related items for an entity
graphRoutes.get("/related", async (c) => {
	const db = getDb();
	const type = c.req.query("type");
	const id = c.req.query("id");
	const relationship = c.req.query("relationship");

	if (!type || !id) {
		return c.json({ error: "type and id query params required" }, 400);
	}

	const where: Record<string, unknown> = {
		OR: [
			{ sourceType: type, sourceId: id },
			{ targetType: type, targetId: id },
		],
	};

	if (relationship) {
		where.relationship = relationship;
	}

	const relationships = await db.relationship.findMany({ where });

	log.info(`GET /graph/related — type=${type}, id=${id}, found ${relationships.length}`);
	return c.json(relationships);
});

// Trigger graph indexing for one file
graphRoutes.post("/sessions/:sessionId/index-file", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = await c.req.json();
	const parsed = indexFileRequestSchema.safeParse(body);

	if (!parsed.success) {
		log.warn(`POST /graph/sessions/${sessionId}/index-file — validation failed`, parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	enqueueGraphIndexing(parsed.data.fileId);
	log.info(`POST /graph/sessions/${sessionId}/index-file — queued ${parsed.data.fileId}`);
	return c.json({ ok: true, fileId: parsed.data.fileId });
});

// Trigger graph indexing for all files in session
graphRoutes.post("/sessions/:sessionId/index-all", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const files = await db.file.findMany({
		where: { sessionId, isIndexed: true, isGraphIndexed: false },
		select: { id: true },
	});

	const fileIds = files.map((f) => f.id);
	enqueueSessionGraphIndexing(sessionId, fileIds);

	log.info(`POST /graph/sessions/${sessionId}/index-all — queued ${fileIds.length} files`);
	return c.json({ ok: true, queued: fileIds.length });
});

// Get indexing progress
graphRoutes.get("/sessions/:sessionId/index-status", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const [total, indexed] = await Promise.all([
		db.file.count({ where: { sessionId, isIndexed: true } }),
		db.file.count({ where: { sessionId, isGraphIndexed: true } }),
	]);

	const inProgress = getIndexingQueueSize();

	log.info(`GET /graph/sessions/${sessionId}/index-status — total=${total}, indexed=${indexed}, inProgress=${inProgress}`);
	return c.json({ total, indexed, inProgress });
});
