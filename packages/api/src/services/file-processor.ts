import { MarkItDown } from "markitdown-ts";
import { createLogger, getDb } from "@cramkit/shared";
import { hasHeadings, parseMarkdownTree, type TreeNode } from "./markdown-parser.js";
import { deleteProcessedTree, saveProcessedFile } from "./storage.js";
import { writeTreeToDisk, type DiskMapping } from "./tree-writer.js";

const log = createLogger("api");

const TEXT_EXTS = new Set(["txt", "md", "markdown"]);

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

/**
 * Recursively create Chunk records in the database from tree nodes + disk mappings.
 */
async function createChunkRecords(
	fileId: string,
	mappings: DiskMapping[],
	parentId: string | null,
	nodes: TreeNode[],
	mappingLookup: Map<TreeNode, DiskMapping>,
	counter: { value: number },
): Promise<void> {
	const db = getDb();

	for (const node of nodes) {
		const mapping = mappingLookup.get(node);
		const chunk = await db.chunk.create({
			data: {
				fileId,
				parentId,
				index: counter.value++,
				depth: node.depth,
				nodeType: node.nodeType,
				slug: mapping?.slug ?? null,
				diskPath: mapping?.diskPath ?? null,
				title: node.title,
				content: node.content,
				startPage: node.startPage ?? null,
				endPage: node.endPage ?? null,
			},
		});

		if (node.children.length > 0) {
			await createChunkRecords(
				fileId,
				mappings,
				chunk.id,
				node.children,
				mappingLookup,
				counter,
			);
		}
	}
}

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

		// Save the full processed markdown (flat file, unchanged from Phase 0)
		const processedPath = await saveProcessedFile(file.sessionId, file.filename, rawContent);
		log.debug(`processFile — processed file saved to ${processedPath}`);

		// Delete existing chunks for this file (for re-processing)
		await db.chunk.deleteMany({ where: { fileId: file.id } });

		// Determine split mode
		const splitMode = file.splitMode || "auto";
		const shouldSplit =
			splitMode === "split" ||
			(splitMode === "auto" && hasHeadings(rawContent));

		let indexPath: string | null = null;

		if (shouldSplit) {
			log.info(`processFile — splitting "${file.filename}" into tree`);

			const fileSlug = slugify(file.filename.replace(/\.[^.]+$/, ""));

			// Clean up any existing tree on disk
			await deleteProcessedTree(file.sessionId, fileSlug);

			// Parse markdown into tree
			const tree = parseMarkdownTree(rawContent, file.filename);

			// Write tree to disk
			const mappings = await writeTreeToDisk(file.sessionId, fileSlug, tree);

			// Build lookup from TreeNode -> DiskMapping
			const mappingLookup = new Map<TreeNode, DiskMapping>();
			for (const m of mappings) {
				mappingLookup.set(m.node, m);
			}

			// Create chunk records recursively
			const counter = { value: 0 };

			// Create root chunk
			const rootMapping = mappings.find((m) => m.node === tree);
			const rootChunk = await db.chunk.create({
				data: {
					fileId: file.id,
					parentId: null,
					index: counter.value++,
					depth: tree.depth,
					nodeType: tree.nodeType,
					slug: rootMapping?.slug ?? null,
					diskPath: rootMapping?.diskPath ?? null,
					title: tree.title,
					content: tree.content,
					startPage: tree.startPage ?? null,
					endPage: tree.endPage ?? null,
				},
			});

			// Create child chunks
			await createChunkRecords(
				file.id,
				mappings,
				rootChunk.id,
				tree.children,
				mappingLookup,
				counter,
			);

			indexPath = rootMapping?.diskPath ?? null;

			log.info(`processFile — created ${counter.value} chunks for "${file.filename}"`);
		} else {
			log.info(`processFile — single chunk for "${file.filename}" (splitMode=${splitMode})`);

			// Single chunk (Phase 0 behavior)
			await db.chunk.create({
				data: {
					fileId: file.id,
					index: 0,
					title: file.filename,
					content: rawContent,
				},
			});
		}

		// Mark as processed and indexed
		await db.file.update({
			where: { id: file.id },
			data: {
				processedPath,
				indexPath,
				isIndexed: true,
			},
		});

		log.info(`processFile — completed "${file.filename}"`);
	} catch (error) {
		log.error(`processFile — failed "${file.filename}"`, error);
	}
}
