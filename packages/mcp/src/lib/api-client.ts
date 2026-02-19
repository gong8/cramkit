import { createLogger } from "@cramkit/shared";

const log = createLogger("mcp");
const API_URL = process.env.CRAMKIT_API_URL || "http://localhost:8787";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const method = options?.method || "GET";
	log.debug(`${method} ${API_URL}${path}`);

	const response = await fetch(`${API_URL}${path}`, {
		...options,
		headers: { "Content-Type": "application/json", ...options?.headers },
	});

	if (!response.ok) {
		const error = await response.text();
		log.error(`${method} ${path} — ${response.status}: ${error}`);
		throw new Error(`API error ${response.status}: ${error}`);
	}

	log.debug(`${method} ${path} — ${response.status} OK`);
	return response.json() as Promise<T>;
}

const get = (path: string) => request<unknown>(path);
const getAll = (path: string) => request<unknown[]>(path);
const post = (path: string, data: unknown) =>
	request<unknown>(path, { method: "POST", body: JSON.stringify(data) });

export const apiClient = {
	listSessions: () => getAll("/sessions"),
	getSession: (id: string) => get(`/sessions/${id}`),

	listResources: (sid: string) => getAll(`/resources/sessions/${sid}/resources`),
	getResource: (id: string) => get(`/resources/${id}`),
	getResourceContent: (id: string) => get(`/resources/${id}/content`),
	getResourceTree: (id: string) => get(`/resources/${id}/tree`),

	getChunk: (id: string) => get(`/chunks/${id}`),

	searchNotes: (sid: string, query: string, limit?: number) =>
		getAll(`/search/sessions/${sid}/search?q=${encodeURIComponent(query)}&limit=${limit || 10}`),

	getRelationships: (sid: string) => getAll(`/relationships/sessions/${sid}/relationships`),
	createRelationship: (sid: string, data: unknown) =>
		post(`/relationships/sessions/${sid}/relationships`, data),

	getRelated: (type: string, id: string, relationship?: string) =>
		getAll(
			`/graph/related?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}${relationship ? `&relationship=${encodeURIComponent(relationship)}` : ""}`,
		),
	listConcepts: (sid: string) => getAll(`/graph/sessions/${sid}/concepts`),
	getConcept: (id: string) => get(`/graph/concepts/${id}`),

	listPaperQuestions: (id: string) => getAll(`/questions/resources/${id}/questions`),
	getPaperQuestion: (id: string) => get(`/questions/${id}`),
	listSessionQuestions: (sid: string) => getAll(`/questions/sessions/${sid}/questions`),

	getResourceMetadata: (id: string) => get(`/resources/${id}/metadata`),

	getGraphLog: (sid: string, source?: string, limit?: number) => {
		const params = new URLSearchParams();
		if (source) params.set("source", source);
		if (limit) params.set("limit", String(limit));
		const qs = params.toString();
		return getAll(`/graph/sessions/${sid}/graph-log${qs ? `?${qs}` : ""}`);
	},
};
