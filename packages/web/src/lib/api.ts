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
