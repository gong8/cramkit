import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";
import { MarkItDown } from "markitdown-ts";
import { type TreeNode, hasHeadings, parseMarkdownTree } from "./markdown-parser.js";
import { saveResourceProcessedFile } from "./storage.js";
import { type DiskMapping, writeResourceTreeToDisk } from "./tree-writer.js";

const log = createLogger("api");

const TEXT_EXTS = new Set(["txt", "md", "markdown"]);

const ROLE_ORDER: Record<string, number> = {
	PRIMARY: 0,
	SUPPLEMENT: 1,
	MARK_SCHEME: 2,
	SOLUTIONS: 3,
};

const ROLE_PREFIXES: Record<string, string> = {
	MARK_SCHEME: "Mark Scheme",
	SOLUTIONS: "Solutions",
	SUPPLEMENT: "Supplement",
};

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

function nodeToChunkData(
	resourceId: string,
	sourceFileId: string | null,
	parentId: string | null,
	index: number,
	node: TreeNode,
	mapping?: DiskMapping,
) {
	return {
		resourceId,
		sourceFileId,
		parentId,
		index,
		depth: node.depth,
		nodeType: node.nodeType,
		slug: mapping?.slug ?? null,
		diskPath: mapping?.diskPath ?? null,
		title: node.title,
		content: node.content,
		startPage: node.startPage ?? null,
		endPage: node.endPage ?? null,
	};
}

function buildMappingLookup(mappings: DiskMapping[]): Map<TreeNode, DiskMapping> {
	const lookup = new Map<TreeNode, DiskMapping>();
	for (const m of mappings) lookup.set(m.node, m);
	return lookup;
}

async function createChunkTree(
	tx: Prisma.TransactionClient,
	resourceId: string,
	sourceFileId: string | null,
	parentId: string | null,
	node: TreeNode,
	mappingLookup: Map<TreeNode, DiskMapping>,
	counter: { value: number },
): Promise<string> {
	const chunk = await tx.chunk.create({
		data: nodeToChunkData(
			resourceId,
			sourceFileId,
			parentId,
			counter.value++,
			node,
			mappingLookup.get(node),
		),
	});

	for (const child of node.children) {
		await createChunkTree(tx, resourceId, sourceFileId, chunk.id, child, mappingLookup, counter);
	}

	return chunk.id;
}

interface FileTree {
	fileId: string;
	tree: TreeNode;
	rawContent: string;
}

type ChunkPlan =
	| {
			type: "split-single";
			fileId: string;
			tree: TreeNode;
			mappingLookup: Map<TreeNode, DiskMapping>;
	  }
	| {
			type: "flat";
			fileId: string;
			title: string;
			content: string;
	  }
	| {
			type: "split-multi";
			combinedRoot: TreeNode;
			fileTrees: Array<{ fileId: string; tree: TreeNode }>;
			mappingLookup: Map<TreeNode, DiskMapping>;
	  };

async function convertFileToMarkdown(rawPath: string, filename: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";

	if (TEXT_EXTS.has(ext)) {
		return readFile(rawPath, "utf-8");
	}

	const result = await new MarkItDown().convert(rawPath);
	return (
		result?.markdown ??
		(await readFile(rawPath, "utf-8").catch(() => `[Could not convert: ${filename}]`))
	);
}

async function convertAndSaveFiles(
	db: ReturnType<typeof getDb>,
	resource: { sessionId: string; files: Array<{ id: string; filename: string; rawPath: string }> },
	resourceId: string,
): Promise<FileTree[]> {
	const fileTrees: FileTree[] = [];

	for (const file of resource.files) {
		const rawContent = await convertFileToMarkdown(file.rawPath, file.filename);
		log.debug(`processResource — converted "${file.filename}" (${rawContent.length} chars)`);

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

		const tree = parseMarkdownTree(rawContent, file.filename);
		fileTrees.push({ fileId: file.id, tree, rawContent });
	}

	return fileTrees;
}

function shouldSplit(splitMode: string, resourceType: string, rawContent?: string): boolean {
	if (splitMode === "split") return true;
	return (
		splitMode === "auto" &&
		resourceType === "LECTURE_NOTES" &&
		(!rawContent || hasHeadings(rawContent))
	);
}

function buildCombinedRoot(
	name: string,
	fileTrees: FileTree[],
	roles: Array<{ role: string }>,
): TreeNode {
	const combinedRoot: TreeNode = {
		title: name,
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
		const prefix = ROLE_PREFIXES[roles[i].role];
		if (prefix) tree.title = `${prefix}: ${tree.title}`;
		combinedRoot.children.push(tree);
	}

	return combinedRoot;
}

async function buildChunkPlan(
	fileTrees: FileTree[],
	resource: {
		name: string;
		type: string;
		splitMode: string | null;
		sessionId: string;
		files: Array<{ role: string }>;
	},
	resourceId: string,
): Promise<ChunkPlan> {
	const splitMode = resource.splitMode || "auto";

	if (fileTrees.length === 1) {
		const { fileId, tree, rawContent } = fileTrees[0];

		if (shouldSplit(splitMode, resource.type, rawContent)) {
			const mappings = await writeResourceTreeToDisk(
				resource.sessionId,
				resourceId,
				slugify(resource.name),
				tree,
			);
			return { type: "split-single", fileId, tree, mappingLookup: buildMappingLookup(mappings) };
		}
		return { type: "flat", fileId, title: resource.name, content: rawContent };
	}

	if (shouldSplit(splitMode, resource.type)) {
		const combinedRoot = buildCombinedRoot(resource.name, fileTrees, resource.files);
		const mappings = await writeResourceTreeToDisk(
			resource.sessionId,
			resourceId,
			slugify(resource.name),
			combinedRoot,
		);
		return {
			type: "split-multi",
			combinedRoot,
			fileTrees: fileTrees.map((ft) => ({ fileId: ft.fileId, tree: ft.tree })),
			mappingLookup: buildMappingLookup(mappings),
		};
	}

	return {
		type: "flat",
		fileId: fileTrees[0].fileId,
		title: resource.name,
		content: fileTrees.map((ft) => ft.rawContent).join("\n\n---\n\n"),
	};
}

async function executeChunkPlan(
	tx: Prisma.TransactionClient,
	resourceId: string,
	plan: ChunkPlan,
): Promise<number> {
	const counter = { value: 0 };
	await tx.chunk.deleteMany({ where: { resourceId } });

	switch (plan.type) {
		case "split-single": {
			await createChunkTree(
				tx,
				resourceId,
				plan.fileId,
				null,
				plan.tree,
				plan.mappingLookup,
				counter,
			);
			break;
		}

		case "flat": {
			await tx.chunk.create({
				data: {
					resourceId,
					sourceFileId: plan.fileId,
					index: 0,
					title: plan.title,
					content: plan.content,
				},
			});
			counter.value = 1;
			break;
		}

		case "split-multi": {
			const rootChunk = await tx.chunk.create({
				data: nodeToChunkData(
					resourceId,
					null,
					null,
					counter.value++,
					plan.combinedRoot,
					plan.mappingLookup.get(plan.combinedRoot),
				),
			});

			for (let i = 0; i < plan.fileTrees.length; i++) {
				const { fileId, tree } = plan.fileTrees[i];
				await createChunkTree(
					tx,
					resourceId,
					fileId,
					rootChunk.id,
					tree,
					plan.mappingLookup,
					counter,
				);
			}
			break;
		}
	}

	await tx.resource.update({
		where: { id: resourceId },
		data: { isIndexed: true, isGraphIndexed: false, graphIndexDurationMs: null },
	});

	return counter.value;
}

export async function processResource(resourceId: string): Promise<void> {
	const db = getDb();
	const resource = await db.resource.findUnique({
		where: { id: resourceId },
		include: { files: { orderBy: { createdAt: "asc" } } },
	});

	if (!resource) {
		log.error(`processResource — resource ${resourceId} not found`);
		return;
	}

	resource.files.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

	log.info(
		`processResource — starting "${resource.name}" (${resourceId}), ${resource.files.length} files`,
	);

	try {
		const fileTrees = await convertAndSaveFiles(db, resource, resourceId);
		const plan = await buildChunkPlan(fileTrees, resource, resourceId);

		const chunkCount = await db.$transaction((tx) => executeChunkPlan(tx, resourceId, plan), {
			timeout: 30000,
		});

		log.info(`processResource — completed "${resource.name}" (${chunkCount} chunks)`);
	} catch (error) {
		log.error(`processResource — failed "${resource.name}"`, error);
	}
}
