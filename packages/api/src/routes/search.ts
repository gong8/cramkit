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

function scoreChunk(
	chunk: {
		title: string | null;
		content: string;
		keywords: string | null;
		nodeType: string;
	},
	queryTerms: string[],
	query: string,
	isGraphResult: boolean,
): { score: number; matchedKeywords: string[] } {
	let score = 0;
	const matchedKeywords: string[] = [];
	const lowerQuery = query.toLowerCase();
	const lowerTitle = (chunk.title || "").toLowerCase();

	// Exact title match: 10 points
	if (lowerTitle === lowerQuery) {
		score += 10;
	}
	// Partial title match: 6 points
	else if (lowerTitle.includes(lowerQuery)) {
		score += 6;
	}

	// Keyword term match: 4 points per query term
	const lowerKeywords = (chunk.keywords || "").toLowerCase();
	for (const term of queryTerms) {
		const lt = term.toLowerCase();
		if (lowerKeywords.includes(lt) || lowerTitle.includes(lt)) {
			score += 4;
			matchedKeywords.push(term);
		}
	}

	// Content occurrence: 1 point each (capped at 5)
	const lowerContent = chunk.content.toLowerCase();
	let occurrences = 0;
	let searchFrom = 0;
	while (occurrences < 5) {
		const idx = lowerContent.indexOf(lowerQuery, searchFrom);
		if (idx === -1) break;
		occurrences++;
		searchFrom = idx + lowerQuery.length;
	}
	score += occurrences;

	// Graph result bonus: +3 points
	if (isGraphResult) {
		score += 3;
	}

	// nodeType bonus
	if (chunk.nodeType === "definition") score += 2;
	else if (chunk.nodeType === "theorem") score += 2;
	else if (chunk.nodeType === "question") score += 1;

	return { score, matchedKeywords };
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

	// Run content search and graph search in parallel
	const [contentChunks, graphResults] = await Promise.all([
		db.chunk.findMany({
			where: {
				resource: { sessionId },
				OR: [
					{ content: { contains: parsed.data.q } },
					{ title: { contains: parsed.data.q } },
					{ keywords: { contains: parsed.data.q } },
				],
			},
			include: {
				resource: { select: { id: true, name: true, type: true } },
			},
			take: overFetchLimit,
		}),
		searchGraph(sessionId, parsed.data.q, overFetchLimit),
	]);

	// Build content results with scores
	const graphChunkIds = new Set(graphResults.map((g) => g.chunkId));

	const contentResults: ContentResult[] = contentChunks.map((chunk) => {
		const isGraphResult = graphChunkIds.has(chunk.id);
		const { score, matchedKeywords } = scoreChunk(
			{
				title: chunk.title,
				content: chunk.content,
				keywords: chunk.keywords,
				nodeType: chunk.nodeType,
			},
			queryTerms,
			parsed.data.q,
			isGraphResult,
		);

		const graphMatch = graphResults.find((g) => g.chunkId === chunk.id);

		return {
			chunkId: chunk.id,
			resourceId: chunk.resource.id,
			resourceName: chunk.resource.name,
			resourceType: chunk.resource.type,
			title: chunk.title,
			content: chunk.content,
			source: isGraphResult ? ("both" as const) : ("content" as const),
			score,
			keywords: matchedKeywords,
			relatedConcepts: graphMatch?.relatedConcepts,
		};
	});

	// Add graph-only results
	const seenChunkIds = new Set(contentResults.map((r) => r.chunkId));

	for (const graphResult of graphResults) {
		if (!seenChunkIds.has(graphResult.chunkId)) {
			// We need to score graph-only results too
			const { score, matchedKeywords } = scoreChunk(
				{
					title: graphResult.title,
					content: graphResult.content,
					keywords: null,
					nodeType: "section",
				},
				queryTerms,
				parsed.data.q,
				true,
			);

			contentResults.push({
				...graphResult,
				score,
				keywords: matchedKeywords,
			});
			seenChunkIds.add(graphResult.chunkId);
		}
	}

	// Sort by score descending, then trim to limit
	contentResults.sort((a, b) => b.score - a.score);
	const merged = contentResults.slice(0, parsed.data.limit);

	log.info(`GET /sessions/${sessionId}/search — query="${parsed.data.q}", found ${merged.length} results (content=${contentChunks.length}, graph=${graphResults.length})`);

	// Fire amortisation async (don't await)
	amortiseSearchResults(
		sessionId,
		parsed.data.q,
		contentChunks.map((c) => ({ chunkId: c.id, resourceId: c.resource.id })),
	).catch((err) => log.error("amortisation failed", err));

	return c.json(merged);
});
