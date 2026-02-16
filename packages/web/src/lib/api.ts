const BASE_URL = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const response = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
	});

	if (!response.ok) {
		throw new Error(`API error: ${response.status}`);
	}

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

export function fetchSessions(): Promise<SessionSummary[]> {
	return request("/sessions");
}

export function fetchSession(id: string): Promise<Session> {
	return request(`/sessions/${id}`);
}

export function fetchSessionFiles(sessionId: string): Promise<FileItem[]> {
	return request(`/files/sessions/${sessionId}/files`);
}

export function createSession(data: {
	name: string;
	module?: string;
	examDate?: string;
}): Promise<Session> {
	return request("/sessions", {
		method: "POST",
		body: JSON.stringify(data),
	});
}

export async function uploadFile(
	sessionId: string,
	file: File,
	type: string,
	label?: string,
): Promise<FileItem> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("type", type);
	if (label) formData.append("label", label);

	const response = await fetch(`${BASE_URL}/files/sessions/${sessionId}/files`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		throw new Error(`Upload error: ${response.status}`);
	}

	return response.json() as Promise<FileItem>;
}
