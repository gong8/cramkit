import { createLogger } from "@/lib/logger.js";

export type {
	BatchResource,
	BatchStatus,
	ChatAttachment,
	ChatMessage,
	Concept,
	ConversationSummary,
	GraphResource,
	ImportResult,
	IndexStatus,
	Relationship,
	Resource,
	ResourceContent,
	ResourceFile,
	Session,
	SessionGraph,
	SessionSummary,
	StreamStatus,
	ToolCallData,
} from "./api-types.js";

import type {
	ChatMessage,
	Concept,
	ConversationSummary,
	ImportResult,
	IndexStatus,
	Resource,
	ResourceContent,
	Session,
	SessionGraph,
	SessionSummary,
	StreamStatus,
} from "./api-types.js";

const log = createLogger("web");
const BASE_URL = "/api";

async function rawFetch(path: string, options?: RequestInit): Promise<Response> {
	const method = options?.method || "GET";
	log.debug(`${method} ${BASE_URL}${path}`);

	const response = await fetch(`${BASE_URL}${path}`, options);

	if (!response.ok) {
		log.error(`${method} ${path} — ${response.status}`);
		throw new Error(`API error: ${response.status}`);
	}

	log.debug(`${method} ${path} — ${response.status} OK`);
	return response;
}

function request<T>(path: string, options?: RequestInit): Promise<T> {
	return rawFetch(path, {
		...options,
		headers: { "Content-Type": "application/json", ...options?.headers },
	}).then((r) => r.json() as Promise<T>);
}

function post<T>(path: string, body?: unknown): Promise<T> {
	return request(path, {
		method: "POST",
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

function patch<T>(path: string, body: unknown): Promise<T> {
	return request(path, { method: "PATCH", body: JSON.stringify(body) });
}

function del<T = void>(path: string): Promise<T> {
	return request(path, { method: "DELETE" });
}

function uploadFormData<T>(path: string, formData: FormData): Promise<T> {
	return rawFetch(path, { method: "POST", body: formData }).then((r) => r.json() as Promise<T>);
}

function buildFormData(fields: Record<string, string | undefined>, files?: File[]): FormData {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) fd.append(key, value);
	}
	if (files) {
		for (const file of files) fd.append("files", file);
	}
	return fd;
}

async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
	const response = await rawFetch(path);
	const blob = await response.blob();
	const disposition = response.headers.get("Content-Disposition");
	const filenameMatch = disposition?.match(/filename="?(.+?)"?$/);
	const filename = filenameMatch?.[1] ?? fallbackFilename;

	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	log.info(`download triggered: ${filename}`);
}

// Session operations

export function fetchSessions(): Promise<SessionSummary[]> {
	return request("/sessions");
}

export function fetchSession(id: string): Promise<Session> {
	return request(`/sessions/${id}`);
}

export function createSession(data: {
	name: string;
	module?: string;
	examDate?: string;
}): Promise<Session> {
	return post("/sessions", data);
}

export function updateSession(
	id: string,
	data: {
		name?: string;
		module?: string | null;
		scope?: string | null;
		notes?: string | null;
		examDate?: string | null;
	},
): Promise<Session> {
	return patch(`/sessions/${id}`, data);
}

export function deleteSession(id: string): Promise<void> {
	return del(`/sessions/${id}`);
}

export function clearSessionGraph(sessionId: string): Promise<{ ok: boolean }> {
	return del(`/sessions/${sessionId}/graph`);
}

// Resource operations

export function createResource(
	sessionId: string,
	data: {
		name: string;
		type: string;
		label?: string;
		splitMode?: string;
		files: File[];
		markScheme?: File;
		solutions?: File;
	},
): Promise<Resource> {
	const fd = buildFormData(
		{ name: data.name, type: data.type, label: data.label, splitMode: data.splitMode },
		data.files,
	);
	if (data.markScheme) fd.append("markScheme", data.markScheme);
	if (data.solutions) fd.append("solutions", data.solutions);

	return uploadFormData(`/resources/sessions/${sessionId}/resources`, fd);
}

export function addFilesToResource(
	resourceId: string,
	files: File[],
	role?: string,
): Promise<Resource> {
	const fd = buildFormData({ role }, files);
	return uploadFormData(`/resources/${resourceId}/files`, fd);
}

export function removeFileFromResource(resourceId: string, fileId: string): Promise<void> {
	return del(`/resources/${resourceId}/files/${fileId}`);
}

export function updateResource(
	resourceId: string,
	data: { name?: string; label?: string | null },
): Promise<Resource> {
	return patch(`/resources/${resourceId}`, data);
}

export function deleteResource(resourceId: string): Promise<void> {
	return del(`/resources/${resourceId}`);
}

export function fetchResourceContent(resourceId: string): Promise<ResourceContent> {
	return request(`/resources/${resourceId}/content`);
}

// Graph / indexing operations

export function indexResource(sessionId: string, resourceId: string): Promise<void> {
	return post(`/graph/sessions/${sessionId}/index-resource`, { resourceId });
}

export function indexAllResources(sessionId: string): Promise<void> {
	return post(`/graph/sessions/${sessionId}/index-all`);
}

export function reindexAllResources(sessionId: string): Promise<void> {
	return post(`/graph/sessions/${sessionId}/index-all`, { reindex: true });
}

export function cancelIndexing(sessionId: string): Promise<void> {
	return post(`/graph/sessions/${sessionId}/cancel-indexing`);
}

export function retryFailedIndexing(sessionId: string): Promise<void> {
	return post(`/graph/sessions/${sessionId}/retry-failed`);
}

export function fetchIndexStatus(sessionId: string): Promise<IndexStatus> {
	return request(`/graph/sessions/${sessionId}/index-status`);
}

export function fetchConcepts(sessionId: string): Promise<Concept[]> {
	return request(`/graph/sessions/${sessionId}/concepts`);
}

export function fetchSessionGraph(sessionId: string): Promise<SessionGraph> {
	return request(`/graph/sessions/${sessionId}/full`);
}

// Conversation operations

export function fetchConversations(sessionId: string): Promise<ConversationSummary[]> {
	return request(`/chat/sessions/${sessionId}/conversations`);
}

export function createConversation(sessionId: string): Promise<ConversationSummary> {
	return post(`/chat/sessions/${sessionId}/conversations`);
}

export function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
	return request(`/chat/conversations/${conversationId}/messages`);
}

export function renameConversation(
	conversationId: string,
	title: string,
): Promise<ConversationSummary> {
	return patch(`/chat/conversations/${conversationId}`, { title });
}

export function deleteConversation(conversationId: string): Promise<void> {
	return del(`/chat/conversations/${conversationId}`);
}

export function fetchStreamStatus(conversationId: string): Promise<StreamStatus> {
	return request(`/chat/conversations/${conversationId}/stream-status`);
}

// Import / export

export function exportSession(sessionId: string): Promise<void> {
	return downloadFile(`/sessions/${sessionId}/export`, `session-${sessionId}.cramkit.zip`);
}

export function importSession(file: File): Promise<ImportResult> {
	const formData = new FormData();
	formData.append("file", file);
	return uploadFormData("/sessions/import", formData);
}
