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

async function writeNodeToDisk(
	baseDir: string,
	relativeBase: string,
	node: TreeNode,
	mappings: DiskMapping[],
): Promise<void> {
	const slug =
		node.order === 0 && node.depth === 0 ? "" : `${zeroPad(node.order)}-${slugify(node.title)}`;

	const isLeaf = node.children.length === 0;

	if (node.depth === 0) {
		// Root node: write _index.md at base
		await mkdir(baseDir, { recursive: true });
		const filePath = join(baseDir, "_index.md");
		const diskPath = join(relativeBase, "_index.md");
		const content = `${buildFrontmatter(node)}\n\n${node.content}`;
		await writeFile(filePath, content, "utf-8");
		mappings.push({ node, diskPath, slug: "_index" });

		for (const child of node.children) {
			await writeNodeToDisk(baseDir, relativeBase, child, mappings);
		}
	} else if (isLeaf) {
		// Leaf node: write as a single .md file
		const fileName = `${slug}.md`;
		const filePath = join(baseDir, fileName);
		const diskPath = join(relativeBase, fileName);
		const content = `${buildFrontmatter(node)}\n\n${node.content}`;
		await writeFile(filePath, content, "utf-8");
		mappings.push({ node, diskPath, slug });
	} else {
		// Non-leaf: create directory + _index.md
		const dirPath = join(baseDir, slug);
		await mkdir(dirPath, { recursive: true });

		const indexPath = join(dirPath, "_index.md");
		const diskPath = join(relativeBase, slug, "_index.md");
		const content = `${buildFrontmatter(node)}\n\n${node.content}`;
		await writeFile(indexPath, content, "utf-8");
		mappings.push({ node, diskPath, slug });

		for (const child of node.children) {
			await writeNodeToDisk(dirPath, join(relativeBase, slug), child, mappings);
		}
	}
}

/**
 * Write a parsed tree to disk for a resource as a directory hierarchy.
 * Returns mappings from tree nodes to disk paths.
 */
export async function writeResourceTreeToDisk(
	sessionId: string,
	resourceId: string,
	resourceSlug: string,
	tree: TreeNode,
): Promise<DiskMapping[]> {
	const resourceDir = getResourceDir(sessionId, resourceId);
	const baseDir = join(resourceDir, "tree", resourceSlug);
	const relativeBase = join("tree", resourceSlug);
	const mappings: DiskMapping[] = [];

	log.info(`writeResourceTreeToDisk — writing to ${baseDir}`);
	await writeNodeToDisk(baseDir, relativeBase, tree, mappings);
	log.info(`writeResourceTreeToDisk — wrote ${mappings.length} nodes`);

	return mappings;
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
	const baseDir = join(sessionDir, "processed", fileSlug);
	const relativeBase = join("processed", fileSlug);
	const mappings: DiskMapping[] = [];

	log.info(`writeTreeToDisk — writing to ${baseDir}`);
	await writeNodeToDisk(baseDir, relativeBase, tree, mappings);
	log.info(`writeTreeToDisk — wrote ${mappings.length} nodes`);

	return mappings;
}
