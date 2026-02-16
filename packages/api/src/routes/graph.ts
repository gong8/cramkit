import { createLogger, getDb, indexFileRequestSchema } from "@cramkit/shared";
import { Hono } from "hono";
import { cancelSessionIndexing, enqueueGraphIndexing, enqueueSessionGraphIndexing, getIndexingQueueSize, getSessionBatchStatus } from "../lib/queue.js";

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

	let reindex = false;
	try {
		const body = await c.req.json();
		reindex = body?.reindex === true;
	} catch {
		// No body or invalid JSON — default to non-reindex
	}

	let fileIds: string[];
	if (reindex) {
		// Include already-indexed files; reset their isGraphIndexed flag
		const files = await db.file.findMany({
			where: { sessionId, isIndexed: true },
			select: { id: true },
		});
		fileIds = files.map((f) => f.id);
		if (fileIds.length > 0) {
			await db.file.updateMany({
				where: { id: { in: fileIds } },
				data: { isGraphIndexed: false, graphIndexDurationMs: null },
			});
		}
	} else {
		const files = await db.file.findMany({
			where: { sessionId, isIndexed: true, isGraphIndexed: false },
			select: { id: true },
		});
		fileIds = files.map((f) => f.id);
	}

	enqueueSessionGraphIndexing(sessionId, fileIds);

	log.info(`POST /graph/sessions/${sessionId}/index-all — queued ${fileIds.length} files (reindex=${reindex})`);
	return c.json({ ok: true, queued: fileIds.length });
});

// Cancel indexing for a session
graphRoutes.post("/sessions/:sessionId/cancel-indexing", async (c) => {
	const sessionId = c.req.param("sessionId");
	const cancelled = cancelSessionIndexing(sessionId);
	log.info(`POST /graph/sessions/${sessionId}/cancel-indexing — cancelled=${cancelled}`);
	return c.json({ ok: true, cancelled });
});

// Get full graph data (concepts + relationships) for a session
graphRoutes.get("/sessions/:sessionId/full", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const [concepts, relationships, files] = await Promise.all([
		db.concept.findMany({ where: { sessionId }, orderBy: { name: "asc" } }),
		db.relationship.findMany({ where: { sessionId } }),
		db.file.findMany({
			where: { sessionId },
			select: { id: true, filename: true, type: true, label: true },
		}),
	]);

	log.info(
		`GET /graph/sessions/${sessionId}/full — ${concepts.length} concepts, ${relationships.length} relationships, ${files.length} files`,
	);
	return c.json({ concepts, relationships, files });
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
	const batch = getSessionBatchStatus(sessionId);

	// Calculate avg duration from historical data in this session
	const durationStats = await db.file.aggregate({
		where: { sessionId, graphIndexDurationMs: { not: null } },
		_avg: { graphIndexDurationMs: true },
	});
	const avgDurationMs = durationStats._avg.graphIndexDurationMs ?? null;

	log.info(`GET /graph/sessions/${sessionId}/index-status — total=${total}, indexed=${indexed}, inProgress=${inProgress}`);
	return c.json({
		total,
		indexed,
		inProgress,
		avgDurationMs,
		batch: batch
			? {
					batchTotal: batch.fileIds.length,
					batchCompleted: batch.completedFileIds.length,
					currentFileId: batch.currentFileId,
					startedAt: batch.startedAt,
					cancelled: batch.cancelled,
				}
			: null,
	});
});
