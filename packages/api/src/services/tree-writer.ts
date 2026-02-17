import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@cramkit/shared";
import type { TreeNode } from "./markdown-parser.js";
import { getResourceDir, getSessionDir } from "./storage.js";

const log = createLogger("api");

export interface DiskMapping {
	node: TreeNode;
	diskPath: string; // relative path from session root
	slug: string; // this node's path segment
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

function zeroPad(n: number): string {
	return String(n + 1).padStart(2, "0");
}

function buildFrontmatter(node: TreeNode): string {
	const fields: Array<[string, string | number]> = [
		["title", `"${node.title.replace(/"/g, '\\"')}"`],
		["nodeType", node.nodeType],
		["depth", node.depth],
		["order", node.order],
	];
	if (node.startPage !== undefined) fields.push(["startPage", node.startPage]);
	if (node.endPage !== undefined) fields.push(["endPage", node.endPage]);

	const body = fields.map(([k, v]) => `${k}: ${v}`).join("\n");
	return `---\n${body}\n---`;
}

async function writeMarkdownFile(filePath: string, node: TreeNode): Promise<void> {
	const content = `${buildFrontmatter(node)}\n\n${node.content}`;
	await writeFile(filePath, content, "utf-8");
}

interface NodeLayout {
	dirPath: string;
	relDir: string;
	fileName: string;
	slug: string;
	needsDir: boolean;
}

function computeNodeLayout(baseDir: string, relativeBase: string, node: TreeNode): NodeLayout {
	const isRoot = node.order === 0 && node.depth === 0;
	if (isRoot) {
		return {
			dirPath: baseDir,
			relDir: relativeBase,
			fileName: "_index.md",
			slug: "_index",
			needsDir: true,
		};
	}

	const nodeSlug = `${zeroPad(node.order)}-${slugify(node.title)}`;
	const hasChildren = node.children.length > 0;

	return {
		dirPath: hasChildren ? join(baseDir, nodeSlug) : baseDir,
		relDir: hasChildren ? join(relativeBase, nodeSlug) : relativeBase,
		fileName: hasChildren ? "_index.md" : `${nodeSlug}.md`,
		slug: nodeSlug,
		needsDir: hasChildren,
	};
}

async function writeNodeToDisk(
	baseDir: string,
	relativeBase: string,
	node: TreeNode,
	mappings: DiskMapping[],
): Promise<void> {
	const layout = computeNodeLayout(baseDir, relativeBase, node);

	if (layout.needsDir) {
		await mkdir(layout.dirPath, { recursive: true });
	}

	const filePath = join(layout.dirPath, layout.fileName);
	const diskPath = join(layout.relDir, layout.fileName);
	await writeMarkdownFile(filePath, node);
	mappings.push({ node, diskPath, slug: layout.slug });

	for (const child of node.children) {
		await writeNodeToDisk(layout.dirPath, layout.relDir, child, mappings);
	}
}

/**
 * Write a parsed tree to disk for a resource as a directory hierarchy.
 * Returns mappings from tree nodes to disk paths.
 */
async function writeTree(
	baseDir: string,
	relativeBase: string,
	tree: TreeNode,
): Promise<DiskMapping[]> {
	const mappings: DiskMapping[] = [];
	log.info(`writeTree — writing to ${baseDir}`);
	await writeNodeToDisk(baseDir, relativeBase, tree, mappings);
	log.info(`writeTree — wrote ${mappings.length} nodes`);
	return mappings;
}

export async function writeResourceTreeToDisk(
	sessionId: string,
	resourceId: string,
	resourceSlug: string,
	tree: TreeNode,
): Promise<DiskMapping[]> {
	const resourceDir = getResourceDir(sessionId, resourceId);
	return writeTree(join(resourceDir, "tree", resourceSlug), join("tree", resourceSlug), tree);
}

/**
 * @deprecated Use writeResourceTreeToDisk instead
 */
export async function writeTreeToDisk(
	sessionId: string,
	fileSlug: string,
	tree: TreeNode,
): Promise<DiskMapping[]> {
	const sessionDir = getSessionDir(sessionId);
	return writeTree(join(sessionDir, "processed", fileSlug), join("processed", fileSlug), tree);
}
