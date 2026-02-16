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
	fileCount: number;
	scope: string | null;
}

export interface Session {
	id: string;
	name: string;
	module: string | null;
	examDate: string | null;
	scope: string | null;
	notes: string | null;
	files: FileItem[];
}

export interface FileItem {
	id: string;
	filename: string;
	type: string;
	label: string | null;
	isIndexed: boolean;
	isGraphIndexed: boolean;
	fileSize: number | null;
	graphIndexDurationMs: number | null;
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

export interface GraphFile {
	id: string;
	filename: string;
	type: string;
	label: string | null;
}

export interface SessionGraph {
	concepts: Concept[];
	relationships: Relationship[];
	files: GraphFile[];
}

export interface BatchStatus {
	batchTotal: number;
	batchCompleted: number;
	currentFileId: string | null;
	startedAt: number;
	cancelled: boolean;
}

export interface IndexStatus {
	total: number;
	indexed: number;
	inProgress: number;
	avgDurationMs: number | null;
	batch: BatchStatus | null;
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

export async function fetchSessionFiles(sessionId: string): Promise<FileItem[]> {
	log.info(`fetchSessionFiles — ${sessionId}`);
	const files = await request<FileItem[]>(`/files/sessions/${sessionId}/files`);
	log.info(`fetchSessionFiles — got ${files.length} files`);
	return files;
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
	data: { scope?: string | null; notes?: string | null },
): Promise<Session> {
	log.info(`updateSession — ${id}`);
	return request(`/sessions/${id}`, {
		method: "PATCH",
		body: JSON.stringify(data),
	});
}

export function deleteFile(fileId: string): Promise<void> {
	log.info(`deleteFile — ${fileId}`);
	return request(`/files/${fileId}`, { method: "DELETE" });
}

export async function uploadFile(
	sessionId: string,
	file: File,
	type: string,
	label?: string,
): Promise<FileItem> {
	log.info(`uploadFile — "${file.name}" (${file.size} bytes, type=${type})`);
	const formData = new FormData();
	formData.append("file", file);
	formData.append("type", type);
	if (label) formData.append("label", label);

	const response = await fetch(`${BASE_URL}/files/sessions/${sessionId}/files`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		log.error(`uploadFile — failed "${file.name}": ${response.status}`);
		throw new Error(`Upload error: ${response.status}`);
	}

	log.info(`uploadFile — completed "${file.name}"`);
	return response.json() as Promise<FileItem>;
}

export function indexFile(sessionId: string, fileId: string): Promise<void> {
	log.info(`indexFile — session=${sessionId}, file=${fileId}`);
	return request(`/graph/sessions/${sessionId}/index-file`, {
		method: "POST",
		body: JSON.stringify({ fileId }),
	});
}

export function indexAllFiles(sessionId: string): Promise<void> {
	log.info(`indexAllFiles — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/index-all`, { method: "POST" });
}

export function reindexAllFiles(sessionId: string): Promise<void> {
	log.info(`reindexAllFiles — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/index-all`, {
		method: "POST",
		body: JSON.stringify({ reindex: true }),
	});
}

export function cancelIndexing(sessionId: string): Promise<void> {
	log.info(`cancelIndexing — session=${sessionId}`);
	return request(`/graph/sessions/${sessionId}/cancel-indexing`, { method: "POST" });
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

// File detail (with chunks/content)
export interface FileDetail {
	id: string;
	filename: string;
	type: string;
	label: string | null;
	processedContent: string | null;
	chunks: Array<{
		id: string;
		title: string | null;
		content: string;
		index: number;
		nodeType: string;
		depth: number;
	}>;
}

export function fetchFileDetail(fileId: string): Promise<FileDetail> {
	log.info(`fetchFileDetail — ${fileId}`);
	return request(`/files/${fileId}`);
}

// File linking
export interface FileLink {
	sourceId: string;
	targetId: string;
	relationship: string;
}

export function linkFile(
	sourceFileId: string,
	targetFileId: string,
	relationship: "mark_scheme_of" | "solutions_of",
): Promise<void> {
	log.info(`linkFile — ${sourceFileId} -> ${targetFileId} (${relationship})`);
	return request(`/files/${sourceFileId}/link`, {
		method: "POST",
		body: JSON.stringify({ targetFileId, relationship }),
	});
}

export function unlinkFile(sourceFileId: string, targetFileId: string): Promise<void> {
	log.info(`unlinkFile — ${sourceFileId} -x- ${targetFileId}`);
	return request(`/files/${sourceFileId}/unlink`, {
		method: "DELETE",
		body: JSON.stringify({ targetFileId }),
	});
}

export async function fetchFileLinks(sessionId: string): Promise<FileLink[]> {
	log.info(`fetchFileLinks — session=${sessionId}`);
	const relationships = await request<Array<{
		sourceType: string;
		sourceId: string;
		targetType: string;
		targetId: string;
		relationship: string;
	}>>(`/relationships/sessions/${sessionId}/relationships`);
	// Filter to file-to-file relationships only
	return relationships
		.filter((r) => r.sourceType === "file" && r.targetType === "file")
		.map((r) => ({
			sourceId: r.sourceId,
			targetId: r.targetId,
			relationship: r.relationship,
		}));
}
