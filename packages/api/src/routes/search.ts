import { createLogger, getDb, searchQuerySchema } from "@cramkit/shared";
import { Hono } from "hono";
import { amortiseSearchResults } from "../services/amortiser.js";
import { searchGraph } from "../services/graph-search.js";

const log = createLogger("api");

export const searchRoutes = new Hono();

interface ContentResult {
	chunkId: string;
	resourceId: string;
	resourceName: string;
	resourceType: string;
	title: string | null;
	content: string;
	source: "content" | "graph" | "both";
	score: number;
	keywords: string[];
	relatedConcepts?: Array<{ name: string; relationship: string }>;
}

interface ScorableChunk {
	title: string | null;
	content: string;
	keywords: string | null;
	nodeType: string;
}

function countOccurrences(haystack: string, needle: string, max: number): number {
	let count = 0;
	let pos = 0;
	while (count < max) {
		pos = haystack.indexOf(needle, pos);
		if (pos === -1) break;
		count++;
		pos += needle.length;
	}
	return count;
}

function scoreChunk(
	chunk: ScorableChunk,
	queryTerms: string[],
	query: string,
	isGraphResult: boolean,
): { score: number; matchedKeywords: string[] } {
	let score = 0;
	const matchedKeywords: string[] = [];
	const lowerQuery = query.toLowerCase();
	const lowerTitle = (chunk.title || "").toLowerCase();

	if (lowerTitle === lowerQuery) score += 10;
	else if (lowerTitle.includes(lowerQuery)) score += 6;

	const lowerKeywords = (chunk.keywords || "").toLowerCase();
	for (const term of queryTerms) {
		const lt = term.toLowerCase();
		if (lowerKeywords.includes(lt) || lowerTitle.includes(lt)) {
			score += 4;
			matchedKeywords.push(term);
		}
	}

	score += countOccurrences(chunk.content.toLowerCase(), lowerQuery, 5);

	if (isGraphResult) score += 3;
	if (chunk.nodeType === "definition" || chunk.nodeType === "theorem") score += 2;
	else if (chunk.nodeType === "question") score += 1;

	return { score, matchedKeywords };
}

function buildContentResults(
	contentChunks: Array<{
		id: string;
		title: string | null;
		content: string;
		keywords: string | null;
		nodeType: string;
		resource: { id: string; name: string; type: string };
	}>,
	graphResults: Awaited<ReturnType<typeof searchGraph>>,
	queryTerms: string[],
	query: string,
): ContentResult[] {
	const graphByChunkId = new Map(graphResults.map((g) => [g.chunkId, g]));

	const results: ContentResult[] = contentChunks.map((chunk) => {
		const graphMatch = graphByChunkId.get(chunk.id);
		const { score, matchedKeywords } = scoreChunk(chunk, queryTerms, query, !!graphMatch);

		return {
			chunkId: chunk.id,
			resourceId: chunk.resource.id,
			resourceName: chunk.resource.name,
			resourceType: chunk.resource.type,
			title: chunk.title,
			content: chunk.content,
			source: graphMatch ? ("both" as const) : ("content" as const),
			score,
			keywords: matchedKeywords,
			relatedConcepts: graphMatch?.relatedConcepts,
		};
	});

	// Add graph-only results (not already in content results)
	const contentChunkIds = new Set(contentChunks.map((c) => c.id));
	for (const graphResult of graphResults) {
		if (contentChunkIds.has(graphResult.chunkId)) continue;
		const { score, matchedKeywords } = scoreChunk(graphResult, queryTerms, query, true);
		results.push({ ...graphResult, score, keywords: matchedKeywords });
	}

	results.sort((a, b) => b.score - a.score);
	return results;
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

	const overFetchLimit = parsed.data.limit * 3;
	const queryTerms = parsed.data.q.split(/\s+/).filter((t) => t.length > 1);

	const [contentChunks, graphResults] = await Promise.all([
		db.chunk.findMany({
			where: {
				resource: { sessionId },
				AND: queryTerms.map((term) => ({
					OR: [
						{ content: { contains: term } },
						{ title: { contains: term } },
						{ keywords: { contains: term } },
					],
				})),
			},
			include: {
				resource: { select: { id: true, name: true, type: true } },
			},
			take: overFetchLimit,
		}),
		searchGraph(sessionId, parsed.data.q, overFetchLimit),
	]);

	const allResults = buildContentResults(contentChunks, graphResults, queryTerms, parsed.data.q);
	const merged = allResults.slice(0, parsed.data.limit);

	log.info(
		`GET /sessions/${sessionId}/search — query="${parsed.data.q}", found ${merged.length} results (content=${contentChunks.length}, graph=${graphResults.length})`,
	);

	amortiseSearchResults(
		sessionId,
		parsed.data.q,
		contentChunks.map((c) => ({ chunkId: c.id, resourceId: c.resource.id })),
	).catch((err) => log.error("amortisation failed", err));

	return c.json(merged);
});
