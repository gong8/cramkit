import {
	createLogger,
	getDb,
	indexAllRequestSchema,
	indexResourceRequestSchema,
} from "@cramkit/shared";
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

type Thoroughness = "quick" | "standard" | "thorough";

async function resolveSessionThoroughness(
	sessionId: string,
	override?: string,
): Promise<Thoroughness> {
	if (override) return override as Thoroughness;
	const session = await getDb().session.findUnique({
		where: { id: sessionId },
		select: { graphThoroughness: true },
	});
	return (session?.graphThoroughness ?? "standard") as Thoroughness;
}

function conceptRelationshipWhere(sessionId: string, conceptId: string) {
	return {
		sessionId,
		OR: [
			{ sourceType: "concept" as const, sourceId: conceptId },
			{ targetType: "concept" as const, targetId: conceptId },
		],
	};
}

async function findConcept(id: string) {
	return getDb().concept.findUnique({ where: { id } });
}

graphRoutes.get("/sessions/:sessionId/concepts", async (c) => {
	const sessionId = c.req.param("sessionId");
	const concepts = await getDb().concept.findMany({
		where: { sessionId },
		orderBy: { name: "asc" },
	});
	log.info(`GET /graph/sessions/${sessionId}/concepts — found ${concepts.length}`);
	return c.json(concepts);
});

graphRoutes.get("/concepts/:id", async (c) => {
	const id = c.req.param("id");
	const concept = await findConcept(id);
	if (!concept) return c.json({ error: "Concept not found" }, 404);

	const relationships = await getDb().relationship.findMany({
		where: conceptRelationshipWhere(concept.sessionId, id),
	});
	log.info(`GET /graph/concepts/${id} — "${concept.name}", ${relationships.length} relationships`);
	return c.json({ ...concept, relationships });
});

graphRoutes.delete("/concepts/:id", async (c) => {
	const db = getDb();
	const id = c.req.param("id");
	const concept = await findConcept(id);
	if (!concept) return c.json({ error: "Concept not found" }, 404);

	await db.relationship.deleteMany({
		where: conceptRelationshipWhere(concept.sessionId, id),
	});
	await db.concept.delete({ where: { id } });
	log.info(`DELETE /graph/concepts/${id} — deleted "${concept.name}"`);
	return c.json({ ok: true });
});

graphRoutes.get("/related", async (c) => {
	const db = getDb();
	const type = c.req.query("type");
	const id = c.req.query("id");
	if (!type || !id) return c.json({ error: "type and id query params required" }, 400);

	const relationship = c.req.query("relationship");

	let where: Record<string, unknown>;

	if (type === "resource") {
		const resource = await db.resource.findUnique({
			where: { id },
			select: { sessionId: true },
		});
		if (!resource) return c.json({ error: "Resource not found" }, 404);

		const chunkIds = (
			await db.chunk.findMany({ where: { resourceId: id }, select: { id: true } })
		).map((ch) => ch.id);

		const orConditions: Record<string, unknown>[] = [
			{ sourceType: "resource", sourceId: id },
			{ targetType: "resource", targetId: id },
		];
		if (chunkIds.length > 0) {
			orConditions.push(
				{ sourceType: "chunk", sourceId: { in: chunkIds } },
				{ targetType: "chunk", targetId: { in: chunkIds } },
			);
		}

		where = { sessionId: resource.sessionId, OR: orConditions };
	} else {
		where = {
			OR: [
				{ sourceType: type, sourceId: id },
				{ targetType: type, targetId: id },
			],
		};
	}

	if (relationship) where.relationship = relationship;

	const relationships = await db.relationship.findMany({ where });
	log.info(`GET /graph/related — type=${type}, id=${id}, found ${relationships.length}`);
	return c.json(relationships);
});

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

	const thoroughness = await resolveSessionThoroughness(sessionId, parsed.data.thoroughness);
	await enqueueSessionGraphIndexing(sessionId, [parsed.data.resourceId], thoroughness);
	log.info(
		`POST /graph/sessions/${sessionId}/index-resource — queued ${parsed.data.resourceId} [thoroughness=${thoroughness}]`,
	);
	return c.json({ ok: true, resourceId: parsed.data.resourceId, thoroughness });
});

graphRoutes.post("/sessions/:sessionId/index-all", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const body = await c.req.json().catch(() => ({}));
	const parsed = indexAllRequestSchema.safeParse(body);
	const { reindex, thoroughness: bodyThoroughness } = parsed.success
		? parsed.data
		: { reindex: body?.reindex === true, thoroughness: undefined };

	const thoroughness = await resolveSessionThoroughness(sessionId, bodyThoroughness);

	const resources = await db.resource.findMany({
		where: {
			sessionId,
			isIndexed: true,
			...(reindex ? {} : { isGraphIndexed: false }),
		},
		select: { id: true },
	});
	const resourceIds = resources.map((r) => r.id);

	if (reindex && resourceIds.length > 0) {
		await db.resource.updateMany({
			where: { id: { in: resourceIds } },
			data: { isGraphIndexed: false, graphIndexDurationMs: null },
		});
	}

	await enqueueSessionGraphIndexing(sessionId, resourceIds, thoroughness);
	log.info(
		`POST /graph/sessions/${sessionId}/index-all — queued ${resourceIds.length} resources (reindex=${reindex}, thoroughness=${thoroughness})`,
	);
	return c.json({ ok: true, queued: resourceIds.length, thoroughness });
});

graphRoutes.post("/sessions/:sessionId/cancel-indexing", async (c) => {
	const sessionId = c.req.param("sessionId");
	const cancelled = await cancelSessionIndexing(sessionId);
	log.info(`POST /graph/sessions/${sessionId}/cancel-indexing — cancelled=${cancelled}`);
	return c.json({ ok: true, cancelled });
});

graphRoutes.post("/sessions/:sessionId/retry-failed", async (c) => {
	const sessionId = c.req.param("sessionId");
	const retried = await retryFailedJobs(sessionId);
	return c.json({ ok: true, retried });
});

graphRoutes.get("/sessions/:sessionId/full", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const [concepts, relationships, resources, chunks] = await Promise.all([
		db.concept.findMany({ where: { sessionId }, orderBy: { name: "asc" } }),
		db.relationship.findMany({ where: { sessionId } }),
		db.resource.findMany({
			where: { sessionId },
			select: { id: true, name: true, type: true, label: true },
		}),
		db.chunk.findMany({
			where: { resource: { sessionId } },
			select: { id: true, resourceId: true },
		}),
	]);

	const chunkResourceMap: Record<string, string> = {};
	for (const chunk of chunks) {
		chunkResourceMap[chunk.id] = chunk.resourceId;
	}

	log.info(
		`GET /graph/sessions/${sessionId}/full — ${concepts.length} concepts, ${relationships.length} relationships, ${resources.length} resources`,
	);
	return c.json({ concepts, relationships, resources, chunkResourceMap });
});

graphRoutes.get("/sessions/:sessionId/graph-log", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");
	const source = c.req.query("source");
	const limitParam = c.req.query("limit");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

	const where: Record<string, unknown> = { sessionId };
	if (source) where.source = source;

	const entries = await db.graphLog.findMany({
		where,
		orderBy: { createdAt: "desc" },
		take: limit,
	});

	log.info(
		`GET /graph/sessions/${sessionId}/graph-log — ${entries.length} entries (source=${source ?? "all"})`,
	);
	return c.json(entries);
});

graphRoutes.get("/sessions/:sessionId/index-status", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const [total, indexed] = await Promise.all([
		db.resource.count({ where: { sessionId, isIndexed: true } }),
		db.resource.count({ where: { sessionId, isGraphIndexed: true } }),
	]);

	const inProgress = getIndexingQueueSize();
	const batch = await getSessionBatchStatus(sessionId);

	const durationStats = await db.resource.aggregate({
		where: { sessionId, graphIndexDurationMs: { not: null } },
		_avg: { graphIndexDurationMs: true },
	});
	const avgDurationMs = durationStats._avg.graphIndexDurationMs ?? null;

	log.info(
		`GET /graph/sessions/${sessionId}/index-status — total=${total}, indexed=${indexed}, inProgress=${inProgress}`,
	);
	return c.json({ total, indexed, inProgress, avgDurationMs, batch });
});
