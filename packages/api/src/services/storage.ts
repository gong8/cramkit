import { createLogger } from "@cramkit/shared";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("api");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");

export function getSessionDir(sessionId: string): string {
	return join(DATA_DIR, "sessions", sessionId);
}

export async function ensureDir(dir: string): Promise<void> {
	log.debug(`ensureDir — ${dir}`);
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
	log.debug(`saveRawFile — ${filePath}`);
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
	log.debug(`saveProcessedFile — ${filePath}`);
	return filePath;
}

export async function readProcessedFile(filePath: string): Promise<string> {
	log.debug(`readProcessedFile — ${filePath}`);
	return readFile(filePath, "utf-8");
}

export async function deleteSessionFile(_sessionId: string, filePath: string): Promise<void> {
	try {
		await unlink(filePath);
		log.debug(`deleteSessionFile — deleted ${filePath}`);
	} catch {
		log.debug(`deleteSessionFile — already gone ${filePath}`);
	}
}
