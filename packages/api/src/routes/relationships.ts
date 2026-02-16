import { createRelationshipSchema, getDb } from "@cramkit/shared";
import { Hono } from "hono";

export const relationshipsRoutes = new Hono();

// List relationships for session
relationshipsRoutes.get("/sessions/:sessionId/relationships", async (c) => {
	const db = getDb();
	const relationships = await db.relationship.findMany({
		where: { sessionId: c.req.param("sessionId") },
		orderBy: { createdAt: "desc" },
	});
	return c.json(relationships);
});

// Create relationship
relationshipsRoutes.post("/sessions/:sessionId/relationships", async (c) => {
	const db = getDb();
	const body = await c.req.json();
	const parsed = createRelationshipSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const relationship = await db.relationship.create({
		data: {
			sessionId: c.req.param("sessionId"),
			...parsed.data,
		},
	});

	return c.json(relationship, 201);
});

// Delete relationship
relationshipsRoutes.delete("/:id", async (c) => {
	const db = getDb();
	await db.relationship.delete({ where: { id: c.req.param("id") } });
	return c.json({ ok: true });
});
