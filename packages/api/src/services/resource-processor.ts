import { readFile } from "node:fs/promises";
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

async function writeTreeAndBuildLookup(
	sessionId: string,
	resourceId: string,
	name: string,
	tree: TreeNode,
): Promise<Map<TreeNode, DiskMapping>> {
	const mappings = await writeResourceTreeToDisk(sessionId, resourceId, slugify(name), tree);
	return buildMappingLookup(mappings);
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

async function convertOneFile(
	db: ReturnType<typeof getDb>,
	sessionId: string,
	resourceId: string,
	file: { id: string; filename: string; rawPath: string },
): Promise<FileTree> {
	const rawContent = await convertFileToMarkdown(file.rawPath, file.filename);
	log.debug(`processResource — converted "${file.filename}" (${rawContent.length} chars)`);

	const processedPath = await saveResourceProcessedFile(
		sessionId,
		resourceId,
		file.filename,
		rawContent,
	);
	await db.file.update({ where: { id: file.id }, data: { processedPath } });

	const tree = parseMarkdownTree(rawContent, file.filename);
	return { fileId: file.id, tree, rawContent };
}

async function convertAndSaveFiles(
	db: ReturnType<typeof getDb>,
	resource: { sessionId: string; files: Array<{ id: string; filename: string; rawPath: string }> },
	resourceId: string,
): Promise<FileTree[]> {
	const fileTrees: FileTree[] = [];
	for (const file of resource.files) {
		fileTrees.push(await convertOneFile(db, resource.sessionId, resourceId, file));
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
	const children = fileTrees.map(({ tree }, i) => {
		tree.order = i;
		if (tree.depth === 0) tree.depth = 1;
		const prefix = ROLE_PREFIXES[roles[i].role];
		if (prefix) tree.title = `${prefix}: ${tree.title}`;
		return tree;
	});

	return { title: name, content: "", depth: 0, order: 0, nodeType: "section", children };
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
	const isSingle = fileTrees.length === 1;
	const wantSplit = isSingle
		? shouldSplit(splitMode, resource.type, fileTrees[0].rawContent)
		: shouldSplit(splitMode, resource.type);

	if (!wantSplit) {
		return {
			type: "flat",
			fileId: fileTrees[0].fileId,
			title: resource.name,
			content: isSingle
				? fileTrees[0].rawContent
				: fileTrees.map((ft) => ft.rawContent).join("\n\n---\n\n"),
		};
	}

	const tree = isSingle
		? fileTrees[0].tree
		: buildCombinedRoot(resource.name, fileTrees, resource.files);

	const mappingLookup = await writeTreeAndBuildLookup(
		resource.sessionId,
		resourceId,
		resource.name,
		tree,
	);

	if (isSingle) {
		return { type: "split-single", fileId: fileTrees[0].fileId, tree, mappingLookup };
	}

	return {
		type: "split-multi",
		combinedRoot: tree,
		fileTrees: fileTrees.map((ft) => ({ fileId: ft.fileId, tree: ft.tree })),
		mappingLookup,
	};
}

async function insertChunks(
	tx: Prisma.TransactionClient,
	resourceId: string,
	plan: ChunkPlan,
): Promise<number> {
	const counter = { value: 0 };

	if (plan.type === "flat") {
		await tx.chunk.create({
			data: {
				resourceId,
				sourceFileId: plan.fileId,
				index: 0,
				title: plan.title,
				content: plan.content,
			},
		});
		return 1;
	}

	if (plan.type === "split-single") {
		await createChunkTree(
			tx,
			resourceId,
			plan.fileId,
			null,
			plan.tree,
			plan.mappingLookup,
			counter,
		);
		return counter.value;
	}

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

	for (const { fileId, tree } of plan.fileTrees) {
		await createChunkTree(tx, resourceId, fileId, rootChunk.id, tree, plan.mappingLookup, counter);
	}

	return counter.value;
}

async function executeChunkPlan(
	tx: Prisma.TransactionClient,
	resourceId: string,
	plan: ChunkPlan,
): Promise<number> {
	await tx.chunk.deleteMany({ where: { resourceId } });

	const chunkCount = await insertChunks(tx, resourceId, plan);

	await tx.resource.update({
		where: { id: resourceId },
		data: {
			isIndexed: true,
			indexErrorMessage: null,
			isGraphIndexed: false,
			graphIndexDurationMs: null,
		},
	});

	return chunkCount;
}

async function saveIndexError(
	db: ReturnType<typeof getDb>,
	resourceId: string,
	msg: string,
): Promise<void> {
	try {
		await db.resource.update({
			where: { id: resourceId },
			data: { indexErrorMessage: msg },
		});
	} catch (dbErr) {
		log.error(`processResource — failed to write indexErrorMessage for ${resourceId}`, dbErr);
	}
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
		const msg = error instanceof Error ? error.message : String(error);
		log.error(`processResource — failed "${resource.name}"`, error);
		await saveIndexError(db, resourceId, msg);
	}
}
