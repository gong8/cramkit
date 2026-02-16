export interface TreeNode {
	title: string;
	content: string; // body text under this heading (NOT including children)
	depth: number; // heading level (0 = root)
	order: number; // position among siblings
	nodeType: string; // inferred from title patterns
	children: TreeNode[];
	startPage?: number;
	endPage?: number;
}

const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

const NODE_TYPE_PATTERNS: Array<[RegExp, string]> = [
	[/^(definition|def\.)\b/i, "definition"],
	[/^(theorem|thm\.)\b/i, "theorem"],
	[/^proof\b/i, "proof"],
	[/^(example|ex\.)\b/i, "example"],
	[/^(lemma)\b/i, "lemma"],
	[/^(corollary|cor\.)\b/i, "corollary"],
	[/^(exercise|question|q\d+)\b/i, "question"],
	[/^chapter\b/i, "chapter"],
];

function inferNodeType(title: string, depth: number): string {
	for (const [pattern, type] of NODE_TYPE_PATTERNS) {
		if (pattern.test(title.trim())) return type;
	}
	if (depth === 1) return "chapter";
	return "section";
}

/** Extract page number from MarkItDown page markers like <!-- Page 3 --> */
function extractPageNumber(text: string): number | undefined {
	const matches = [...text.matchAll(/<!--\s*Page\s+(\d+)\s*-->/gi)];
	if (matches.length === 0) return undefined;
	return Number.parseInt(matches[matches.length - 1][1], 10);
}

function extractStartPage(text: string): number | undefined {
	const match = text.match(/<!--\s*Page\s+(\d+)\s*-->/i);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

/**
 * Parse markdown into a tree based on heading structure.
 * Pure function, no LLM or I/O.
 */
export function parseMarkdownTree(markdown: string, filename: string): TreeNode {
	const lines = markdown.split("\n");

	const root: TreeNode = {
		title: filename.replace(/\.[^.]+$/, ""),
		content: "",
		depth: 0,
		order: 0,
		nodeType: "section",
		children: [],
	};

	// Parse into flat segments: each segment is (headingLevel, title, bodyLines)
	interface Segment {
		level: number;
		title: string;
		bodyLines: string[];
	}

	const segments: Segment[] = [];
	let currentSegment: Segment | null = null;

	for (const line of lines) {
		const match = line.match(HEADING_REGEX);
		if (match) {
			if (currentSegment) segments.push(currentSegment);
			currentSegment = {
				level: match[1].length,
				title: match[2].trim(),
				bodyLines: [],
			};
		} else {
			if (currentSegment) {
				currentSegment.bodyLines.push(line);
			} else {
				// Content before first heading -> root body
				root.content += `${line}\n`;
			}
		}
	}
	if (currentSegment) segments.push(currentSegment);

	root.content = root.content.trimEnd();
	root.startPage = extractStartPage(markdown);
	root.endPage = extractPageNumber(markdown);

	if (segments.length === 0) {
		// No headings at all -> single root node with all content
		root.nodeType = inferNodeType(root.title, 0);
		return root;
	}

	// Build tree by nesting segments according to heading levels
	// Use a stack approach: maintain path from root to current insertion point
	const stack: TreeNode[] = [root];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const body = seg.bodyLines.join("\n").trimEnd();

		const node: TreeNode = {
			title: seg.title,
			content: body,
			depth: seg.level,
			order: 0, // will be set when added to parent
			nodeType: inferNodeType(seg.title, seg.level),
			children: [],
			startPage: extractStartPage(seg.bodyLines.join("\n")),
			endPage: extractPageNumber(seg.bodyLines.join("\n")),
		};

		// Pop stack until we find a parent with lower depth
		while (stack.length > 1 && stack[stack.length - 1].depth >= seg.level) {
			stack.pop();
		}

		const parent = stack[stack.length - 1];
		node.order = parent.children.length;
		parent.children.push(node);
		stack.push(node);
	}

	// Merge very short leaf nodes (<50 chars of content) into parent
	mergeShortLeaves(root);

	return root;
}

function mergeShortLeaves(node: TreeNode): void {
	// Process children first (bottom-up)
	for (const child of node.children) {
		mergeShortLeaves(child);
	}

	// Merge short leaf children into parent
	const kept: TreeNode[] = [];
	for (const child of node.children) {
		if (child.children.length === 0 && child.content.length < 50) {
			// Merge into parent: append content with title as header
			const merged = child.content
				? `**${child.title}**: ${child.content}`
				: `**${child.title}**`;
			node.content = node.content ? `${node.content}\n\n${merged}` : merged;
		} else {
			child.order = kept.length;
			kept.push(child);
		}
	}
	node.children = kept;
}

/** Check if a markdown document has any headings */
export function hasHeadings(markdown: string): boolean {
	return markdown.split("\n").some((line) => HEADING_REGEX.test(line));
}
