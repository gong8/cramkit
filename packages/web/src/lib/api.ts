import { createLogger } from "@/lib/logger";

const log = createLogger("web");
const BASE_URL = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const method = options?.method || "GET";
	log.debug(`${method} ${BASE_URL}${path}`);

	const response = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
	});

	if (!response.ok) {
		log.error(`${method} ${path} — ${response.status}`);
		throw new Error(`API error: ${response.status}`);
	}

	log.debug(`${method} ${path} — ${response.status} OK`);
	return response.json() as Promise<T>;
}

export interface SessionSummary {
	id: string;
	name: string;
	module: string | null;
	examDate: string | null;
	resourceCount: number;
	scope: string | null;
}

export interface ResourceFile {
	id: string;
	filename: string;
	role: string;
	fileSize: number | null;
}

export interface Resource {
	id: string;
	name: string;
	type: string;
	label: string | null;
	isIndexed: boolean;
	isGraphIndexed: boolean;
	graphIndexDurationMs: number | null;
	files: ResourceFile[];
}

export interface Session {
	id: string;
	name: string;
	module: string | null;
	examDate: string | null;
	scope: string | null;
	notes: string | null;
	resources: Resource[];
}

export interface Concept {
	id: string;
	name: string;
	description: string | null;
	aliases: string | null;
	createdBy: string;
}

export interface Relationship {
	id: string;
	sourceType: string;
	sourceId: string;
	sourceLabel: string | null;
	targetType: string;
	targetId: string;
	targetLabel: string | null;
	relationship: string;
	confidence: number;
}

export interface GraphResource {
	id: string;
	name: string;
	type: string;
	label: string | null;
}

export interface SessionGraph {
	concepts: Concept[];
	relationships: Relationship[];
	resources: GraphResource[];
}

export interface BatchResource {
	id: string;
	name: string;
	type: string;
	status: "pending" | "indexing" | "completed" | "cancelled" | "failed";
	durationMs: number | null;
	errorMessage: string | null;
	errorType: string | null;
	attempts: number;
}

export interface BatchStatus {
	batchTotal: number;
	batchCompleted: number;
	batchFailed: number;
	currentResourceId: string | null;
	startedAt: number;
	cancelled: boolean;
	resources: BatchResource[];
}

export interface IndexStatus {
	total: number;
	indexed: number;
	inProgress: number;
	avgDurationMs: number | null;
	batch: BatchStatus | null;
}

export interface ResourceContent {
	id: string;
	name: string;
	type: string;
	content: string;
}

export async function fetchSessions(): Promise<SessionSummary[]> {
	log.info("fetchSessions");
	const sessions = await request<SessionSummary[]>("/sessions");
	log.info(`fetchSessions — got ${sessions.length} sessions`);
	return sessions;
}

export function fetchSession(id: string): Promise<Session> {
	log.info(`fetchSession — ${id}`);
	return request(`/sessions/${id}`);
}

export async function createSession(data: {
	name: string;
	module?: string;
	examDate?: string;
}): Promise<Session> {
	log.info(`createSession — "${data.name}"`);
	const session = await request<Session>("/sessions", {
		method: "POST",
		body: JSON.stringify(data),
	});
	log.info(`createSession — created ${session.id}`);
	return session;
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
	log.info(`updateSession — ${id}`);
	return request(`/sessions/${id}`, {
		method: "PATCH",
		body: JSON.stringify(data),
	});
}

export function deleteSession(id: string): Promise<void> {
	log.info(`deleteSession — ${id}`);
	return request(`/sessions/${id}`, { method: "DELETE" });
}

export function clearSessionGraph(sessionId: string): Promise<{ ok: boolean }> {
	log.info(`clearSessionGraph — ${sessionId}`);
	return request(`/sessions/${sessionId}/graph`, { method: "DELETE" });
}

// Resource operations
export async function createResource(
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
	log.info(`createResource — "${data.name}" (${data.type}), ${data.files.length} files`);
	const formData = new FormData();
	formData.append("name", data.name);
	formData.append("type", data.type);
	if (data.label) formData.append("label", data.label);
	if (data.splitMode) formData.append("splitMode", data.splitMode);

	for (const file of data.files) {
		formData.append("files", file);
	}
	if (data.markScheme) formData.append("markScheme", data.markScheme);
	if (data.solutions) formData.append("solutions", data.solutions);

	const response = await fetch(`${BASE_URL}/resources/sessions/${sessionId}/resources`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		log.error(`createResource — failed: ${response.status}`);
		throw new Error(`Upload error: ${response.status}`);
	}

	log.info(`createResource — completed "${data.name}"`);
	return response.json() as Promise<Resource>;
}

export async function addFilesToResource(
	resourceId: string,
	files: File[],
	role?: string,
): Promise<Resource> {
	log.info(`addFilesToResource — ${resourceId}, ${files.length} files`);
	const formData = new FormData();
	if (role) formData.append("role", role);
	for (const file of files) {
		formData.append("files", file);
	}

	const response = await fetch(`${BASE_URL}/resources/${resourceId}/files`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		throw new Error(`Upload error: ${response.status}`);
	}

	return response.json() as Promise<Resource>;
}

export function removeFileFromResource(resourceId: string, fileId: string): Promise<void> {
	log.info(`removeFileFromResource — resource=${resourceId}, file=${fileId}`);
	return request(`/resources/${resourceId}/files/${fileId}`, { method: "DELETE" });
}

export function updateResource(
	resourceId: string,
	data: { name?: string; label?: string | null },
): Promise<Resource> {
	log.info(`updateResource — ${resourceId}`, data);
	return request(`/resources/${resourceId}`, {
		method: "PATCH",
		body: JSON.stringify(data),
	});
}

export function deleteResource(resourceId: string): Promise<void> {
	log.info(`deleteResource — ${resourceId}`);
	return request(`/resources/${resourceId}`, { method: "DELETE" });
}

export function fetchResourceContent(resourceId: string): Promise<ResourceContent> {
	log.info(`fetchResourceContent — ${resourceId}`);
	return request(`/resources/${resourceId}/content`);
}

export function indexResource(sessionId: string, resourceId: string): Promise<void> {
	log.info(`indexResource — session=${sessionId}, resource=${resourceId}`);
	return request(`/graph/sessions/${sessionId}/index-resource`, {
		method: "POST",
		body: JSON.stringify({ resourceId }),
	});
}

export function indexAllResources(sessionId: string): Promise<void> {
	log.info(`indexAllResources — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/index-all`, { method: "POST" });
}

export function reindexAllResources(sessionId: string): Promise<void> {
	log.info(`reindexAllResources — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/index-all`, {
		method: "POST",
		body: JSON.stringify({ reindex: true }),
	});
}

export function cancelIndexing(sessionId: string): Promise<void> {
	log.info(`cancelIndexing — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/cancel-indexing`, { method: "POST" });
}

export function retryFailedIndexing(sessionId: string): Promise<void> {
	log.info(`retryFailedIndexing — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/retry-failed`, { method: "POST" });
}

export function fetchIndexStatus(sessionId: string): Promise<IndexStatus> {
	return request(`/graph/sessions/${sessionId}/index-status`);
}

export function fetchConcepts(sessionId: string): Promise<Concept[]> {
	log.info(`fetchConcepts — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/concepts`);
}

export function fetchSessionGraph(sessionId: string): Promise<SessionGraph> {
	log.info(`fetchSessionGraph — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/full`);
}

// Conversation operations
export interface ConversationSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface ChatAttachment {
	id: string;
	filename: string;
	contentType: string;
}

export interface ToolCallData {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	toolCalls?: string | null;
	createdAt: string;
	attachments?: ChatAttachment[];
}

export function fetchConversations(sessionId: string): Promise<ConversationSummary[]> {
	log.info(`fetchConversations — session=${sessionId}`);
	return request(`/chat/sessions/${sessionId}/conversations`);
}

export function createConversation(sessionId: string): Promise<ConversationSummary> {
	log.info(`createConversation — session=${sessionId}`);
	return request(`/chat/sessions/${sessionId}/conversations`, { method: "POST" });
}

export function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
	log.info(`fetchMessages — conversation=${conversationId}`);
	return request(`/chat/conversations/${conversationId}/messages`);
}

export function renameConversation(
	conversationId: string,
	title: string,
): Promise<ConversationSummary> {
	log.info(`renameConversation — ${conversationId}`);
	return request(`/chat/conversations/${conversationId}`, {
		method: "PATCH",
		body: JSON.stringify({ title }),
	});
}

export function deleteConversation(conversationId: string): Promise<void> {
	log.info(`deleteConversation — ${conversationId}`);
	return request(`/chat/conversations/${conversationId}`, { method: "DELETE" });
}

export interface StreamStatus {
	active: boolean;
	status: "streaming" | "complete" | "error" | null;
}

export function fetchStreamStatus(conversationId: string): Promise<StreamStatus> {
	return request(`/chat/conversations/${conversationId}/stream-status`);
}

// Import/Export operations
export async function exportSession(sessionId: string): Promise<void> {
	log.info(`exportSession — ${sessionId}`);
	const response = await fetch(`${BASE_URL}/sessions/${sessionId}/export`);

	if (!response.ok) {
		log.error(`exportSession — failed: ${response.status}`);
		throw new Error(`Export error: ${response.status}`);
	}

	const blob = await response.blob();
	const disposition = response.headers.get("Content-Disposition");
	const filenameMatch = disposition?.match(/filename="?(.+?)"?$/);
	const filename = filenameMatch?.[1] ?? `session-${sessionId}.cramkit.zip`;

	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	log.info(`exportSession — download triggered: ${filename}`);
}

export interface ImportResult {
	sessionId: string;
	stats: {
		resourceCount: number;
		fileCount: number;
		chunkCount: number;
		conceptCount: number;
		relationshipCount: number;
		conversationCount: number;
		messageCount: number;
	};
}

export async function importSession(file: File): Promise<ImportResult> {
	log.info(`importSession — file: ${file.name} (${file.size} bytes)`);
	const formData = new FormData();
	formData.append("file", file);

	const response = await fetch(`${BASE_URL}/sessions/import`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		log.error(`importSession — failed: ${response.status}`);
		throw new Error(`Import error: ${response.status}`);
	}

	const result = (await response.json()) as ImportResult;
	log.info(`importSession — created session ${result.sessionId}`);
	return result;
}
