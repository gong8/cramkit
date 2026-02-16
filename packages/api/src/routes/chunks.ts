import { createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const chunksRoutes = new Hono();

// Get chunks for a resource
chunksRoutes.get("/resources/:resourceId/chunks", async (c) => {
	const db = getDb();
	const chunks = await db.chunk.findMany({
		where: { resourceId: c.req.param("resourceId") },
		orderBy: { index: "asc" },
	});
	log.info(`GET /resources/${c.req.param("resourceId")}/chunks — found ${chunks.length} chunks`);
	return c.json(chunks);
});

// Get single chunk
chunksRoutes.get("/:id", async (c) => {
	const db = getDb();
	const chunk = await db.chunk.findUnique({
		where: { id: c.req.param("id") },
		include: { resource: { select: { name: true, type: true } } },
	});

	if (!chunk) {
		log.warn(`GET /chunks/${c.req.param("id")} — not found`);
		return c.json({ error: "Chunk not found" }, 404);
	}
	log.info(`GET /chunks/${chunk.id} — found`);
	return c.json(chunk);
});
