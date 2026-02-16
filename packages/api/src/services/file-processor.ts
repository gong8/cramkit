import { getDb } from "@cramkit/shared";
import { saveProcessedFile } from "./storage.js";

export async function processFile(fileId: string): Promise<void> {
	const db = getDb();
	const file = await db.file.findUnique({ where: { id: fileId } });

	if (!file) {
		console.error(`File ${fileId} not found`);
		return;
	}

	try {
		// Phase 0: For now, just read the raw file as text and save as "processed"
		// In Phase 1, this will use markitdown-ts for PDF conversion
		const { readFile } = await import("node:fs/promises");
		const rawContent = await readFile(file.rawPath, "utf-8").catch(() => {
			return `[Binary file: ${file.filename}]`;
		});

		const processedPath = await saveProcessedFile(file.sessionId, file.filename, rawContent);

		// Create a single chunk for the entire file (Phase 0 shortcut)
		await db.chunk.create({
			data: {
				fileId: file.id,
				index: 0,
				title: file.filename,
				content: rawContent,
			},
		});

		// Mark as processed and indexed
		await db.file.update({
			where: { id: file.id },
			data: {
				processedPath,
				isIndexed: true,
			},
		});

		console.log(`Processed file: ${file.filename}`);
	} catch (error) {
		console.error(`Error processing file ${file.filename}:`, error);
	}
}
