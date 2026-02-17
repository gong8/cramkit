import type { Prisma } from "@prisma/client";
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
 * Accepts a transaction client to ensure atomicity with the preceding deleteMany.
 */
async function createChunkRecords(
	tx: Prisma.TransactionClient,
	resourceId: string,
	sourceFileId: string | null,
	mappings: DiskMapping[],
	parentId: string | null,
	nodes: TreeNode[],
	mappingLookup: Map<TreeNode, DiskMapping>,
	counter: { value: number },
): Promise<void> {
	for (const node of nodes) {
		const mapping = mappingLookup.get(node);
		const chunk = await tx.chunk.create({
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
				tx,
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
	const ROLE_ORDER: Record<string, number> = { PRIMARY: 0, SUPPLEMENT: 1, MARK_SCHEME: 2, SOLUTIONS: 3 };
	const resource = await db.resource.findUnique({
		where: { id: resourceId },
		include: {
			files: { orderBy: { createdAt: "asc" } },
		},
	});
	if (resource) {
		resource.files.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
	}

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

		// Step 2: Prepare tree data before transaction (file I/O stays outside)
		const splitMode = resource.splitMode || "auto";

		// Pre-compute trees and disk mappings before entering the transaction
		type ChunkPlan = {
			type: "split-single";
			fileId: string;
			tree: TreeNode;
			mappings: DiskMapping[];
			mappingLookup: Map<TreeNode, DiskMapping>;
		} | {
			type: "single-chunk";
			fileId: string;
			title: string;
			content: string;
		} | {
			type: "split-multi";
			combinedRoot: TreeNode;
			fileTrees: Array<{ fileId: string; tree: TreeNode }>;
			mappings: DiskMapping[];
			mappingLookup: Map<TreeNode, DiskMapping>;
		} | {
			type: "concat-multi";
			fileId: string;
			title: string;
			content: string;
		};

		let plan: ChunkPlan;

		if (fileTrees.length === 1) {
			const { fileId, tree, rawContent } = fileTrees[0];
			const shouldSplit =
				splitMode === "split" ||
				(splitMode === "auto" && resource.type === "LECTURE_NOTES" && hasHeadings(rawContent));

			if (shouldSplit) {
				const resourceSlug = slugify(resource.name);
				const mappings = await writeResourceTreeToDisk(resource.sessionId, resourceId, resourceSlug, tree);
				const mappingLookup = new Map<TreeNode, DiskMapping>();
				for (const m of mappings) mappingLookup.set(m.node, m);
				plan = { type: "split-single", fileId, tree, mappings, mappingLookup };
			} else {
				plan = { type: "single-chunk", fileId, title: resource.name, content: rawContent };
			}
		} else {
			const shouldSplitMulti =
				splitMode === "split" ||
				(splitMode === "auto" && resource.type === "LECTURE_NOTES");

			if (shouldSplitMulti) {
				const combinedRoot: TreeNode = {
					title: resource.name,
					content: "",
					depth: 0,
					order: 0,
					nodeType: "section",
					children: [],
				};

				for (let i = 0; i < fileTrees.length; i++) {
					const { tree } = fileTrees[i];
					tree.order = i;
					if (tree.depth === 0) tree.depth = 1;
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
				plan = {
					type: "split-multi",
					combinedRoot,
					fileTrees: fileTrees.map((ft) => ({ fileId: ft.fileId, tree: ft.tree })),
					mappings,
					mappingLookup,
				};
			} else {
				const allContent = fileTrees.map((ft) => ft.rawContent).join("\n\n---\n\n");
				plan = { type: "concat-multi", fileId: fileTrees[0].fileId, title: resource.name, content: allContent };
			}
		}

		// Step 3: Delete old chunks + create new ones atomically in a transaction
		const counter = { value: 0 };

		await db.$transaction(async (tx) => {
			await tx.chunk.deleteMany({ where: { resourceId } });

			switch (plan.type) {
				case "split-single": {
					const rootMapping = plan.mappings.find((m) => m.node === plan.tree);
					const rootChunk = await tx.chunk.create({
						data: {
							resourceId,
							sourceFileId: plan.fileId,
							parentId: null,
							index: counter.value++,
							depth: plan.tree.depth,
							nodeType: plan.tree.nodeType,
							slug: rootMapping?.slug ?? null,
							diskPath: rootMapping?.diskPath ?? null,
							title: plan.tree.title,
							content: plan.tree.content,
							startPage: plan.tree.startPage ?? null,
							endPage: plan.tree.endPage ?? null,
						},
					});

					await createChunkRecords(
						tx,
						resourceId,
						plan.fileId,
						plan.mappings,
						rootChunk.id,
						plan.tree.children,
						plan.mappingLookup,
						counter,
					);
					break;
				}

				case "single-chunk": {
					await tx.chunk.create({
						data: {
							resourceId,
							sourceFileId: plan.fileId,
							index: 0,
							title: plan.title,
							content: plan.content,
						},
					});
					break;
				}

				case "split-multi": {
					const rootMapping = plan.mappings.find((m) => m.node === plan.combinedRoot);
					const rootChunk = await tx.chunk.create({
						data: {
							resourceId,
							sourceFileId: null,
							parentId: null,
							index: counter.value++,
							depth: plan.combinedRoot.depth,
							nodeType: plan.combinedRoot.nodeType,
							slug: rootMapping?.slug ?? null,
							diskPath: rootMapping?.diskPath ?? null,
							title: plan.combinedRoot.title,
							content: plan.combinedRoot.content,
							startPage: plan.combinedRoot.startPage ?? null,
							endPage: plan.combinedRoot.endPage ?? null,
						},
					});

					for (let i = 0; i < plan.combinedRoot.children.length; i++) {
						const childTree = plan.combinedRoot.children[i];
						const fileId = plan.fileTrees[i].fileId;

						const childMapping = plan.mappingLookup.get(childTree);
						const childChunk = await tx.chunk.create({
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
								tx,
								resourceId,
								fileId,
								plan.mappings,
								childChunk.id,
								childTree.children,
								plan.mappingLookup,
								counter,
							);
						}
					}
					break;
				}

				case "concat-multi": {
					await tx.chunk.create({
						data: {
							resourceId,
							sourceFileId: plan.fileId,
							index: 0,
							title: plan.title,
							content: plan.content,
						},
					});
					break;
				}
			}

			// Mark resource as indexed inside the same transaction
			await tx.resource.update({
				where: { id: resourceId },
				data: { isIndexed: true, isGraphIndexed: false, graphIndexDurationMs: null },
			});
		}, { timeout: 30000 });

		log.info(`processResource — completed "${resource.name}" (${counter.value} chunks)`);
	} catch (error) {
		log.error(`processResource — failed "${resource.name}"`, error);
	}
}
