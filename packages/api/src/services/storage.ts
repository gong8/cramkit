import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");

export function getSessionDir(sessionId: string): string {
	return join(DATA_DIR, "sessions", sessionId);
}

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

export async function saveRawFile(
	sessionId: string,
	filename: string,
	content: Buffer,
): Promise<string> {
	const dir = join(getSessionDir(sessionId), "raw");
	await ensureDir(dir);
	const filePath = join(dir, filename);
	await writeFile(filePath, content);
	return filePath;
}

export async function saveProcessedFile(
	sessionId: string,
	filename: string,
	content: string,
): Promise<string> {
	const dir = join(getSessionDir(sessionId), "processed");
	await ensureDir(dir);
	const filePath = join(dir, `${filename}.md`);
	await writeFile(filePath, content, "utf-8");
	return filePath;
}

export async function readProcessedFile(filePath: string): Promise<string> {
	return readFile(filePath, "utf-8");
}

export async function deleteSessionFile(_sessionId: string, filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		// File may already be deleted
	}
}
