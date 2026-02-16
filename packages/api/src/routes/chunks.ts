import { getDb } from "@cramkit/shared";
import { Hono } from "hono";

export const chunksRoutes = new Hono();

// Get chunks for a file
chunksRoutes.get("/files/:fileId/chunks", async (c) => {
	const db = getDb();
	const chunks = await db.chunk.findMany({
		where: { fileId: c.req.param("fileId") },
		orderBy: { index: "asc" },
	});
	return c.json(chunks);
});

// Get single chunk
chunksRoutes.get("/:id", async (c) => {
	const db = getDb();
	const chunk = await db.chunk.findUnique({
		where: { id: c.req.param("id") },
		include: { file: { select: { filename: true, type: true } } },
	});

	if (!chunk) return c.json({ error: "Chunk not found" }, 404);
	return c.json(chunk);
});
