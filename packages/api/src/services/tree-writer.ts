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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function nodeSlug(node: TreeNode): string {
	return `${zeroPad(node.order)}-${slugify(node.title)}`;
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

	return `---\n${fields.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---`;
}

// ── Disk layout ─────────────────────────────────────────────────────────────

interface NodeLayout {
	dir: string;
	relDir: string;
	fileName: string;
	slug: string;
}

function computeLayout(baseDir: string, relBase: string, node: TreeNode): NodeLayout {
	const isRoot = node.order === 0 && node.depth === 0;
	if (isRoot) {
		return { dir: baseDir, relDir: relBase, fileName: "_index.md", slug: "_index" };
	}

	const slug = nodeSlug(node);
	const hasChildren = node.children.length > 0;

	return {
		dir: hasChildren ? join(baseDir, slug) : baseDir,
		relDir: hasChildren ? join(relBase, slug) : relBase,
		fileName: hasChildren ? "_index.md" : `${slug}.md`,
		slug,
	};
}

// ── Writing ─────────────────────────────────────────────────────────────────

async function writeNode(
	baseDir: string,
	relBase: string,
	node: TreeNode,
	mappings: DiskMapping[],
): Promise<void> {
	const layout = computeLayout(baseDir, relBase, node);

	if (node.children.length > 0 || (node.depth === 0 && node.order === 0)) {
		await mkdir(layout.dir, { recursive: true });
	}

	const filePath = join(layout.dir, layout.fileName);
	await writeFile(filePath, `${buildFrontmatter(node)}\n\n${node.content}`, "utf-8");
	mappings.push({ node, diskPath: join(layout.relDir, layout.fileName), slug: layout.slug });

	for (const child of node.children) {
		await writeNode(layout.dir, layout.relDir, child, mappings);
	}
}

/**
 * Write a parsed tree to disk for a resource as a directory hierarchy.
 * Returns mappings from tree nodes to disk paths.
 */
async function writeTree(baseDir: string, relBase: string, tree: TreeNode): Promise<DiskMapping[]> {
	const mappings: DiskMapping[] = [];
	log.info(`writeTree — writing to ${baseDir}`);
	await writeNode(baseDir, relBase, tree, mappings);
	log.info(`writeTree — wrote ${mappings.length} nodes`);
	return mappings;
}

// ── Public API ──────────────────────────────────────────────────────────────

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
