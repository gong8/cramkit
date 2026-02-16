import { createLogger, getDb, searchQuerySchema } from "@cramkit/shared";
import { Hono } from "hono";
import { amortiseSearchResults } from "../services/amortiser.js";
import { searchGraph } from "../services/graph-search.js";

const log = createLogger("api");

export const searchRoutes = new Hono();

interface ContentResult {
	chunkId: string;
	fileId: string;
	fileName: string;
	fileType: string;
	title: string | null;
	content: string;
	source: "content" | "graph" | "both";
	relatedConcepts?: Array<{ name: string; relationship: string }>;
}

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

	// Run content search and graph search in parallel
	const [contentChunks, graphResults] = await Promise.all([
		db.chunk.findMany({
			where: {
				file: { sessionId },
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
		}),
		searchGraph(sessionId, parsed.data.q, parsed.data.limit),
	]);

	// Build content results
	const contentResults: ContentResult[] = contentChunks.map((chunk) => ({
		chunkId: chunk.id,
		fileId: chunk.file.id,
		fileName: chunk.file.filename,
		fileType: chunk.file.type,
		title: chunk.title,
		content: chunk.content,
		source: "content" as const,
	}));

	// Merge: deduplicate by chunkId, content results first
	const seenChunkIds = new Set(contentResults.map((r) => r.chunkId));

	for (const result of contentResults) {
		const graphMatch = graphResults.find((g) => g.chunkId === result.chunkId);
		if (graphMatch) {
			result.source = "both";
			result.relatedConcepts = graphMatch.relatedConcepts;
		}
	}

	for (const graphResult of graphResults) {
		if (!seenChunkIds.has(graphResult.chunkId)) {
			contentResults.push(graphResult);
			seenChunkIds.add(graphResult.chunkId);
		}
	}

	// Trim to limit
	const merged = contentResults.slice(0, parsed.data.limit);

	log.info(`GET /sessions/${sessionId}/search — query="${parsed.data.q}", found ${merged.length} results (content=${contentChunks.length}, graph=${graphResults.length})`);

	// Fire amortisation async (don't await)
	amortiseSearchResults(
		sessionId,
		parsed.data.q,
		contentChunks.map((c) => ({ chunkId: c.id, fileId: c.file.id })),
	).catch((err) => log.error("amortisation failed", err));

	return c.json(merged);
});
