import { createLogger, getDb, searchQuerySchema } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const searchRoutes = new Hono();

// Search across session materials
searchRoutes.get("/sessions/:sessionId/search", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");
	const query = c.req.query("q") || "";
	const limit = Number(c.req.query("limit")) || 10;

	const parsed = searchQuerySchema.safeParse({ q: query, limit });
	if (!parsed.success) {
		log.warn(`GET /sessions/${sessionId}/search — validation failed`, parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	// Simple keyword search — find chunks whose content, title, or keywords contain the query
	const chunks = await db.chunk.findMany({
		where: {
			file: {
				sessionId,
			},
			OR: [
				{ content: { contains: parsed.data.q } },
				{ title: { contains: parsed.data.q } },
				{ keywords: { contains: parsed.data.q } },
			],
		},
		include: {
			file: { select: { id: true, filename: true, type: true } },
		},
		take: parsed.data.limit,
	});

	log.info(`GET /sessions/${sessionId}/search — query="${parsed.data.q}", found ${chunks.length} results`);
	return c.json(
		chunks.map((chunk) => ({
			chunkId: chunk.id,
			fileId: chunk.file.id,
			fileName: chunk.file.filename,
			fileType: chunk.file.type,
			title: chunk.title,
			content: chunk.content,
		})),
	);
});
