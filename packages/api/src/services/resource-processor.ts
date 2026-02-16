import { MarkItDown } from "markitdown-ts";
import { createLogger, getDb } from "@cramkit/shared";
import { hasHeadings, parseMarkdownTree, type TreeNode } from "./markdown-parser.js";
import { saveResourceProcessedFile } from "./storage.js";
import { writeResourceTreeToDisk, type DiskMapping } from "./tree-writer.js";

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
	resourceId: string,
	sourceFileId: string | null,
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
				resourceId,
				sourceFileId,
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
				resourceId,
				sourceFileId,
				mappings,
				chunk.id,
				node.children,
				mappingLookup,
				counter,
			);
		}
	}
}

export async function processResource(resourceId: string): Promise<void> {
	const db = getDb();
	const resource = await db.resource.findUnique({
		where: { id: resourceId },
		include: {
			files: { orderBy: { role: "asc" } }, // PRIMARY first
		},
	});

	if (!resource) {
		log.error(`processResource — resource ${resourceId} not found`);
		return;
	}

	log.info(`processResource — starting "${resource.name}" (${resourceId}), ${resource.files.length} files`);

	try {
		const { readFile } = await import("node:fs/promises");

		// Step 1: Convert each file to markdown
		const fileTrees: Array<{ fileId: string; tree: TreeNode; rawContent: string }> = [];

		for (const file of resource.files) {
			const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";

			let rawContent: string;
			if (TEXT_EXTS.has(ext)) {
				rawContent = await readFile(file.rawPath, "utf-8");
			} else {
				const result = await new MarkItDown().convert(file.rawPath);
				rawContent = result?.markdown ?? await readFile(file.rawPath, "utf-8").catch(() => `[Could not convert: ${file.filename}]`);
			}

			log.debug(`processResource — converted "${file.filename}" (${rawContent.length} chars)`);

			// Save processed markdown for this file
			const processedPath = await saveResourceProcessedFile(
				resource.sessionId,
				resourceId,
				file.filename,
				rawContent,
			);

			await db.file.update({
				where: { id: file.id },
				data: { processedPath },
			});

			// Parse into tree
			const tree = parseMarkdownTree(rawContent, file.filename);
			fileTrees.push({ fileId: file.id, tree, rawContent });
		}

		// Step 2: Delete old chunks
		await db.chunk.deleteMany({ where: { resourceId } });

		// Step 3: Build unified tree
		const splitMode = resource.splitMode || "auto";
		const counter = { value: 0 };

		if (fileTrees.length === 1) {
			// Single file: use its tree directly
			const { fileId, tree, rawContent } = fileTrees[0];
			const shouldSplit =
				splitMode === "split" ||
				(splitMode === "auto" && hasHeadings(rawContent));

			if (shouldSplit) {
				const resourceSlug = slugify(resource.name);
				const mappings = await writeResourceTreeToDisk(resource.sessionId, resourceId, resourceSlug, tree);
				const mappingLookup = new Map<TreeNode, DiskMapping>();
				for (const m of mappings) mappingLookup.set(m.node, m);

				// Create root chunk
				const rootMapping = mappings.find((m) => m.node === tree);
				const rootChunk = await db.chunk.create({
					data: {
						resourceId,
						sourceFileId: fileId,
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

				await createChunkRecords(
					resourceId,
					fileId,
					mappings,
					rootChunk.id,
					tree.children,
					mappingLookup,
					counter,
				);

				log.info(`processResource — created ${counter.value} chunks for "${resource.name}"`);
			} else {
				// Single chunk
				await db.chunk.create({
					data: {
						resourceId,
						sourceFileId: fileId,
						index: 0,
						title: resource.name,
						content: rawContent,
					},
				});
				log.info(`processResource — single chunk for "${resource.name}"`);
			}
		} else {
			// Multiple files: combine under a root node
			const rootTitle = resource.name;
			const combinedRoot: TreeNode = {
				title: rootTitle,
				content: "",
				depth: 0,
				order: 0,
				nodeType: "section",
				children: [],
			};

			for (let i = 0; i < fileTrees.length; i++) {
				const { tree } = fileTrees[i];
				// Each file's tree becomes a child of the root
				tree.order = i;
				if (tree.depth === 0) tree.depth = 1;
				// Label by role
				const file = resource.files[i];
				if (file.role === "MARK_SCHEME") {
					tree.title = `Mark Scheme: ${tree.title}`;
				} else if (file.role === "SOLUTIONS") {
					tree.title = `Solutions: ${tree.title}`;
				} else if (file.role === "SUPPLEMENT") {
					tree.title = `Supplement: ${tree.title}`;
				}
				combinedRoot.children.push(tree);
			}

			const resourceSlug = slugify(resource.name);
			const mappings = await writeResourceTreeToDisk(resource.sessionId, resourceId, resourceSlug, combinedRoot);
			const mappingLookup = new Map<TreeNode, DiskMapping>();
			for (const m of mappings) mappingLookup.set(m.node, m);

			// Create root chunk
			const rootMapping = mappings.find((m) => m.node === combinedRoot);
			const rootChunk = await db.chunk.create({
				data: {
					resourceId,
					sourceFileId: null,
					parentId: null,
					index: counter.value++,
					depth: combinedRoot.depth,
					nodeType: combinedRoot.nodeType,
					slug: rootMapping?.slug ?? null,
					diskPath: rootMapping?.diskPath ?? null,
					title: combinedRoot.title,
					content: combinedRoot.content,
					startPage: combinedRoot.startPage ?? null,
					endPage: combinedRoot.endPage ?? null,
				},
			});

			// Create child chunks, tracking sourceFileId for each sub-tree
			for (let i = 0; i < combinedRoot.children.length; i++) {
				const childTree = combinedRoot.children[i];
				const fileId = fileTrees[i].fileId;

				const childMapping = mappingLookup.get(childTree);
				const childChunk = await db.chunk.create({
					data: {
						resourceId,
						sourceFileId: fileId,
						parentId: rootChunk.id,
						index: counter.value++,
						depth: childTree.depth,
						nodeType: childTree.nodeType,
						slug: childMapping?.slug ?? null,
						diskPath: childMapping?.diskPath ?? null,
						title: childTree.title,
						content: childTree.content,
						startPage: childTree.startPage ?? null,
						endPage: childTree.endPage ?? null,
					},
				});

				if (childTree.children.length > 0) {
					await createChunkRecords(
						resourceId,
						fileId,
						mappings,
						childChunk.id,
						childTree.children,
						mappingLookup,
						counter,
					);
				}
			}

			log.info(`processResource — created ${counter.value} chunks across ${fileTrees.length} files for "${resource.name}"`);
		}

		// Step 4: Mark resource as indexed
		await db.resource.update({
			where: { id: resourceId },
			data: { isIndexed: true },
		});

		log.info(`processResource — completed "${resource.name}"`);
	} catch (error) {
		log.error(`processResource — failed "${resource.name}"`, error);
	}
}
