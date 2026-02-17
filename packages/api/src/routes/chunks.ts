import { getDb } from "@cramkit/shared";
import { Hono } from "hono";

export const chunksRoutes = new Hono();

chunksRoutes.get("/resources/:resourceId/chunks", async (c) => {
	const db = getDb();
	const chunks = await db.chunk.findMany({
		where: { resourceId: c.req.param("resourceId") },
		orderBy: { index: "asc" },
	});
	return c.json(chunks);
});

chunksRoutes.get("/:id", async (c) => {
	const db = getDb();
	const chunk = await db.chunk.findUnique({
		where: { id: c.req.param("id") },
		include: { resource: { select: { name: true, type: true } } },
	});

	if (!chunk) {
		return c.json({ error: "Chunk not found" }, 404);
	}
	return c.json(chunk);
});
