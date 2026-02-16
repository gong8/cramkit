import { MarkItDown } from "markitdown-ts";
import { createLogger, getDb } from "@cramkit/shared";
import { saveProcessedFile } from "./storage.js";

const log = createLogger("api");

const TEXT_EXTS = new Set(["txt", "md", "markdown"]);

export async function processFile(fileId: string): Promise<void> {
	const db = getDb();
	const file = await db.file.findUnique({ where: { id: fileId } });

	if (!file) {
		log.error(`processFile — file ${fileId} not found`);
		return;
	}

	log.info(`processFile — starting "${file.filename}" (${fileId})`);

	try {
		const { readFile } = await import("node:fs/promises");
		const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";

		let rawContent: string;
		if (TEXT_EXTS.has(ext)) {
			rawContent = await readFile(file.rawPath, "utf-8");
		} else {
			const result = await new MarkItDown().convert(file.rawPath);
			rawContent = result?.markdown ?? await readFile(file.rawPath, "utf-8").catch(() => `[Could not convert: ${file.filename}]`);
		}

		log.debug(`processFile — raw content read (${rawContent.length} chars)`);

		const processedPath = await saveProcessedFile(file.sessionId, file.filename, rawContent);
		log.debug(`processFile — processed file saved to ${processedPath}`);

		// Create a single chunk for the entire file (Phase 0 shortcut)
		await db.chunk.create({
			data: {
				fileId: file.id,
				index: 0,
				title: file.filename,
				content: rawContent,
			},
		});

		log.debug(`processFile — chunk created for "${file.filename}"`);

		// Mark as processed and indexed
		await db.file.update({
			where: { id: file.id },
			data: {
				processedPath,
				isIndexed: true,
			},
		});

		log.info(`processFile — completed "${file.filename}"`);
	} catch (error) {
		log.error(`processFile — failed "${file.filename}"`, error);
	}
}
