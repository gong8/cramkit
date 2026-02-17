import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@cramkit/shared";

const log = createLogger("api");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");

export function getSessionDir(sessionId: string): string {
	return join(DATA_DIR, "sessions", sessionId);
}

export function getResourceDir(sessionId: string, resourceId: string): string {
	return join(DATA_DIR, "sessions", sessionId, "resources", resourceId);
}

export async function ensureDir(dir: string): Promise<void> {
	log.debug(`ensureDir — ${dir}`);
	await mkdir(dir, { recursive: true });
}

export async function saveResourceRawFile(
	sessionId: string,
	resourceId: string,
	filename: string,
	content: Buffer,
): Promise<string> {
	const dir = join(getResourceDir(sessionId, resourceId), "raw");
	await ensureDir(dir);
	const filePath = join(dir, filename);
	await writeFile(filePath, content);
	log.debug(`saveResourceRawFile — ${filePath}`);
	return filePath;
}

export async function saveResourceProcessedFile(
	sessionId: string,
	resourceId: string,
	filename: string,
	content: string,
): Promise<string> {
	const dir = join(getResourceDir(sessionId, resourceId), "processed");
	await ensureDir(dir);
	const filePath = join(dir, `${filename}.md`);
	await writeFile(filePath, content, "utf-8");
	log.debug(`saveResourceProcessedFile — ${filePath}`);
	return filePath;
}

export async function readResourceContent(sessionId: string, resourceId: string): Promise<string> {
	const dir = join(getResourceDir(sessionId, resourceId), "processed");
	log.debug(`readResourceContent — ${dir}`);
	try {
		const files = await readdir(dir);
		const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
		const contents: string[] = [];
		for (const f of mdFiles) {
			const content = await readFile(join(dir, f), "utf-8");
			contents.push(content);
		}
		return contents.join("\n\n---\n\n");
	} catch {
		return "";
	}
}

export async function readProcessedFile(filePath: string): Promise<string> {
	log.debug(`readProcessedFile — ${filePath}`);
	return readFile(filePath, "utf-8");
}

export async function deleteResourceDir(sessionId: string, resourceId: string): Promise<void> {
	const dir = getResourceDir(sessionId, resourceId);
	try {
		await rm(dir, { recursive: true, force: true });
		log.debug(`deleteResourceDir — deleted ${dir}`);
	} catch {
		log.debug(`deleteResourceDir — already gone ${dir}`);
	}
}

export async function deleteSessionFile(_sessionId: string, filePath: string): Promise<void> {
	try {
		await unlink(filePath);
		log.debug(`deleteSessionFile — deleted ${filePath}`);
	} catch {
		log.debug(`deleteSessionFile — already gone ${filePath}`);
	}
}

export async function deleteProcessedTree(sessionId: string, fileSlug: string): Promise<void> {
	const dir = join(getSessionDir(sessionId), "processed", fileSlug);
	try {
		await rm(dir, { recursive: true, force: true });
		log.debug(`deleteProcessedTree — deleted ${dir}`);
	} catch {
		log.debug(`deleteProcessedTree — already gone ${dir}`);
	}
}
