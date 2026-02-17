import { createLogger, getDb, indexResourceRequestSchema } from "@cramkit/shared";
import { Hono } from "hono";
import {
	cancelSessionIndexing,
	enqueueSessionGraphIndexing,
	getIndexingQueueSize,
	getSessionBatchStatus,
	retryFailedJobs,
} from "../lib/queue.js";

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

// Trigger graph indexing for one resource
graphRoutes.post("/sessions/:sessionId/index-resource", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = await c.req.json();
	const parsed = indexResourceRequestSchema.safeParse(body);

	if (!parsed.success) {
		log.warn(
			`POST /graph/sessions/${sessionId}/index-resource — validation failed`,
			parsed.error.flatten(),
		);
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	await enqueueSessionGraphIndexing(sessionId, [parsed.data.resourceId]);
	log.info(`POST /graph/sessions/${sessionId}/index-resource — queued ${parsed.data.resourceId}`);
	return c.json({ ok: true, resourceId: parsed.data.resourceId });
});

// Trigger graph indexing for all resources in session
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

	let resourceIds: string[];
	if (reindex) {
		// Include already-indexed resources; reset their isGraphIndexed flag
		const resources = await db.resource.findMany({
			where: { sessionId, isIndexed: true },
			select: { id: true },
		});
		resourceIds = resources.map((r) => r.id);
		if (resourceIds.length > 0) {
			await db.resource.updateMany({
				where: { id: { in: resourceIds } },
				data: { isGraphIndexed: false, graphIndexDurationMs: null },
			});
		}
	} else {
		const resources = await db.resource.findMany({
			where: { sessionId, isIndexed: true, isGraphIndexed: false },
			select: { id: true },
		});
		resourceIds = resources.map((r) => r.id);
	}

	await enqueueSessionGraphIndexing(sessionId, resourceIds);

	log.info(
		`POST /graph/sessions/${sessionId}/index-all — queued ${resourceIds.length} resources (reindex=${reindex})`,
	);
	return c.json({ ok: true, queued: resourceIds.length });
});

// Cancel indexing for a session
graphRoutes.post("/sessions/:sessionId/cancel-indexing", async (c) => {
	const sessionId = c.req.param("sessionId");
	const cancelled = await cancelSessionIndexing(sessionId);
	log.info(`POST /graph/sessions/${sessionId}/cancel-indexing — cancelled=${cancelled}`);
	return c.json({ ok: true, cancelled });
});

// Retry failed indexing jobs for a session
graphRoutes.post("/sessions/:sessionId/retry-failed", async (c) => {
	const sessionId = c.req.param("sessionId");
	const retried = await retryFailedJobs(sessionId);
	return c.json({ ok: true, retried });
});

// Get full graph data (concepts + relationships) for a session
graphRoutes.get("/sessions/:sessionId/full", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const [concepts, relationships, resources] = await Promise.all([
		db.concept.findMany({ where: { sessionId }, orderBy: { name: "asc" } }),
		db.relationship.findMany({ where: { sessionId } }),
		db.resource.findMany({
			where: { sessionId },
			select: { id: true, name: true, type: true, label: true },
		}),
	]);

	log.info(
		`GET /graph/sessions/${sessionId}/full — ${concepts.length} concepts, ${relationships.length} relationships, ${resources.length} resources`,
	);
	return c.json({ concepts, relationships, resources });
});

// Get indexing progress
graphRoutes.get("/sessions/:sessionId/index-status", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const [total, indexed] = await Promise.all([
		db.resource.count({ where: { sessionId, isIndexed: true } }),
		db.resource.count({ where: { sessionId, isGraphIndexed: true } }),
	]);

	const inProgress = getIndexingQueueSize();
	const batch = await getSessionBatchStatus(sessionId);

	// Calculate avg duration from historical data in this session
	const durationStats = await db.resource.aggregate({
		where: { sessionId, graphIndexDurationMs: { not: null } },
		_avg: { graphIndexDurationMs: true },
	});
	const avgDurationMs = durationStats._avg.graphIndexDurationMs ?? null;

	log.info(
		`GET /graph/sessions/${sessionId}/index-status — total=${total}, indexed=${indexed}, inProgress=${inProgress}`,
	);
	return c.json({
		total,
		indexed,
		inProgress,
		avgDurationMs,
		batch,
	});
});
