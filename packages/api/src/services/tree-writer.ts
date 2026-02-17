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
	const lines = ["---"];
	lines.push(`title: "${node.title.replace(/"/g, '\\"')}"`);
	lines.push(`nodeType: ${node.nodeType}`);
	lines.push(`depth: ${node.depth}`);
	lines.push(`order: ${node.order}`);
	if (node.startPage !== undefined) lines.push(`startPage: ${node.startPage}`);
	if (node.endPage !== undefined) lines.push(`endPage: ${node.endPage}`);
	lines.push("---");
	return lines.join("\n");
}

async function writeMarkdownFile(filePath: string, node: TreeNode): Promise<void> {
	const content = `${buildFrontmatter(node)}\n\n${node.content}`;
	await writeFile(filePath, content, "utf-8");
}

async function writeNodeToDisk(
	baseDir: string,
	relativeBase: string,
	node: TreeNode,
	mappings: DiskMapping[],
): Promise<void> {
	const isRoot = node.order === 0 && node.depth === 0;
	const slug = isRoot ? "" : `${zeroPad(node.order)}-${slugify(node.title)}`;
	const isLeaf = node.children.length === 0;

	const dirPath = isRoot || isLeaf ? baseDir : join(baseDir, slug);
	const relDir = isRoot || isLeaf ? relativeBase : join(relativeBase, slug);
	const fileName = isLeaf && !isRoot ? `${slug}.md` : "_index.md";

	if (!isLeaf || isRoot) {
		await mkdir(dirPath, { recursive: true });
	}

	const filePath = join(dirPath, fileName);
	const diskPath = join(relDir, fileName);
	await writeMarkdownFile(filePath, node);
	mappings.push({ node, diskPath, slug: isLeaf && !isRoot ? slug : isRoot ? "_index" : slug });

	for (const child of node.children) {
		await writeNodeToDisk(dirPath, relDir, child, mappings);
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
