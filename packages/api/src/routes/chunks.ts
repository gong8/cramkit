import { getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { amortiseRead } from "../services/amortiser.js";

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
		include: { resource: { select: { name: true, type: true, sessionId: true } } },
	});

	if (!chunk) {
		return c.json({ error: "Chunk not found" }, 404);
	}

	const matchText = [chunk.title, chunk.keywords, chunk.resource.name].filter(Boolean).join(" ");
	amortiseRead(
		chunk.resource.sessionId,
		[{ type: "chunk", id: chunk.id, label: chunk.title }],
		matchText,
	);

	return c.json(chunk);
});
