import { createLogger, createRelationshipSchema, getDb } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const relationshipsRoutes = new Hono();

// List relationships for session
relationshipsRoutes.get("/sessions/:sessionId/relationships", async (c) => {
	const db = getDb();
	const relationships = await db.relationship.findMany({
		where: { sessionId: c.req.param("sessionId") },
		orderBy: { createdAt: "desc" },
	});
	log.info(`GET /sessions/${c.req.param("sessionId")}/relationships — found ${relationships.length}`);
	return c.json(relationships);
});

// Create relationship
relationshipsRoutes.post("/sessions/:sessionId/relationships", async (c) => {
	const db = getDb();
	const body = await c.req.json();
	const parsed = createRelationshipSchema.safeParse(body);

	if (!parsed.success) {
		log.warn("POST /relationships — validation failed", parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const relationship = await db.relationship.create({
		data: {
			sessionId: c.req.param("sessionId"),
			...parsed.data,
		},
	});

	log.info(`POST /relationships — created ${relationship.id} (${parsed.data.sourceLabel} -> ${parsed.data.targetLabel})`);
	return c.json(relationship, 201);
});

// Delete relationship
relationshipsRoutes.delete("/:id", async (c) => {
	const db = getDb();
	const id = c.req.param("id");
	await db.relationship.delete({ where: { id } });
	log.info(`DELETE /relationships/${id} — deleted`);
	return c.json({ ok: true });
});
