import { createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const chunksRoutes = new Hono();

// Get chunks for a file
chunksRoutes.get("/files/:fileId/chunks", async (c) => {
	const db = getDb();
	const chunks = await db.chunk.findMany({
		where: { fileId: c.req.param("fileId") },
		orderBy: { index: "asc" },
	});
	log.info(`GET /files/${c.req.param("fileId")}/chunks — found ${chunks.length} chunks`);
	return c.json(chunks);
});

// Get single chunk
chunksRoutes.get("/:id", async (c) => {
	const db = getDb();
	const chunk = await db.chunk.findUnique({
		where: { id: c.req.param("id") },
		include: { file: { select: { filename: true, type: true } } },
	});

	if (!chunk) {
		log.warn(`GET /chunks/${c.req.param("id")} — not found`);
		return c.json({ error: "Chunk not found" }, 404);
	}
	log.info(`GET /chunks/${chunk.id} — found`);
	return c.json(chunk);
});
