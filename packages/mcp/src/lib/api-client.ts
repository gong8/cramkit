import { createLogger } from "@cramkit/shared";

const log = createLogger("mcp");
const API_URL = process.env.CRAMKIT_API_URL || "http://localhost:8787";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const method = options?.method || "GET";
	log.debug(`${method} ${API_URL}${path}`);

	const response = await fetch(`${API_URL}${path}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
	});

	if (!response.ok) {
		const error = await response.text();
		log.error(`${method} ${path} — ${response.status}: ${error}`);
		throw new Error(`API error ${response.status}: ${error}`);
	}

	log.debug(`${method} ${path} — ${response.status} OK`);
	return response.json() as Promise<T>;
}

export const apiClient = {
	// Sessions
	listSessions: () => request<unknown[]>("/sessions"),

	getSession: (sessionId: string) => request<unknown>(`/sessions/${sessionId}`),

	// Resources
	listResources: (sessionId: string) =>
		request<unknown[]>(`/resources/sessions/${sessionId}/resources`),

	getResource: (resourceId: string) => request<unknown>(`/resources/${resourceId}`),

	getResourceContent: (resourceId: string) => request<unknown>(`/resources/${resourceId}/content`),

	getResourceTree: (resourceId: string) => request<unknown>(`/resources/${resourceId}/tree`),

	// Chunks
	getChunk: (chunkId: string) => request<unknown>(`/chunks/${chunkId}`),

	// Search
	searchNotes: (sessionId: string, query: string, limit?: number) =>
		request<unknown[]>(
			`/search/sessions/${sessionId}/search?q=${encodeURIComponent(query)}&limit=${limit || 10}`,
		),

	// Relationships
	getRelationships: (sessionId: string) =>
		request<unknown[]>(`/relationships/sessions/${sessionId}/relationships`),

	createRelationship: (sessionId: string, data: unknown) =>
		request<unknown>(`/relationships/sessions/${sessionId}/relationships`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// Graph
	getRelated: (type: string, id: string, relationship?: string) =>
		request<unknown[]>(
			`/graph/related?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}${relationship ? `&relationship=${encodeURIComponent(relationship)}` : ""}`,
		),

	listConcepts: (sessionId: string) => request<unknown[]>(`/graph/sessions/${sessionId}/concepts`),

	getConcept: (conceptId: string) => request<unknown>(`/graph/concepts/${conceptId}`),

	getGraphLog: (sessionId: string, source?: string, limit?: number) => {
		const params = new URLSearchParams();
		if (source) params.set("source", source);
		if (limit) params.set("limit", String(limit));
		const qs = params.toString();
		return request<unknown[]>(`/graph/sessions/${sessionId}/graph-log${qs ? `?${qs}` : ""}`);
	},
};
