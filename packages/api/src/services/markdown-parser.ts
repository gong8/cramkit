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

// ── Regex patterns ──────────────────────────────────────────────────────────

const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/**
 * Detect numbered section lines from PDF output like:
 *   "1.1 \tOverview of the module"
 *   "1.2.1 \tDefinition"
 *   "Chapter \t1"
 * These come from MarkItDown which strips heading markup from PDFs.
 */
const SECTION_NUMBER_REGEX = /^(\d+(?:\.\d+)+)\s+(.+)$/;
const CHAPTER_LINE_REGEX = /^Chapter\s+(\d+)$/i;

/** Page separators from MarkItDown: "-- 3 of 24 --" */
const PAGE_SEPARATOR_REGEX = /^--\s*\d+\s+of\s+\d+\s*--$/;

/** Running headers repeated on every page */
const NOISE_PATTERNS: RegExp[] = [
	PAGE_SEPARATOR_REGEX,
	/^\d+\.\d+\.\s+[A-Z][A-Z\s?!]+\d*$/, // "1.2. WHAT IS A PDE?  3"
	/^\d+\s+CHAPTER\s+\d+\.\s+[A-Z]/, // "CHAPTER 1. INTRODUCTION"
];

const PAGE_MARKER_REGEX = /<!--\s*Page\s+(\d+)\s*-->/gi;

const NODE_TYPE_PATTERNS: Array<[RegExp, string]> = [
	[/^(definition|def\.)\b/i, "definition"],
	[/^(theorem|thm\.)\b/i, "theorem"],
	[/^proof\b/i, "proof"],
	[/^(example|ex\.)\b/i, "example"],
	[/^(lemma)\b/i, "lemma"],
	[/^(corollary|cor\.)\b/i, "corollary"],
	[/^(exercise|question|q\d+)\b/i, "question"],
	[/^chapter\b/i, "chapter"],
	[/^(proposition|prop\.)\b/i, "theorem"],
];

// ── Small helpers ───────────────────────────────────────────────────────────

function inferNodeType(title: string, depth: number): string {
	for (const [pattern, type] of NODE_TYPE_PATTERNS) {
		if (pattern.test(title.trim())) return type;
	}
	return depth === 1 ? "chapter" : "section";
}

function extractPageNumber(text: string, mode: "first" | "last" = "last"): number | undefined {
	const matches = [...text.matchAll(PAGE_MARKER_REGEX)];
	if (matches.length === 0) return undefined;
	const match = mode === "first" ? matches[0] : matches[matches.length - 1];
	return Number.parseInt(match[1], 10);
}

function normalizeTabs(line: string): string {
	return line.replace(/\t/g, " ").trim();
}

function isNoiseLine(trimmed: string): boolean {
	return NOISE_PATTERNS.some((rx) => rx.test(trimmed));
}

function nextNonEmptyLine(lines: string[], start: number): { text: string; index: number } | null {
	let j = start;
	while (j < lines.length && lines[j].trim() === "") j++;
	return j < lines.length ? { text: lines[j].trim(), index: j } : null;
}

// ── PDF preprocessing ───────────────────────────────────────────────────────

function tryParseChapterHeading(
	trimmed: string,
	lines: string[],
	i: number,
): { heading: string; nextIndex: number } | null {
	const chapterMatch = trimmed.match(CHAPTER_LINE_REGEX);
	if (!chapterMatch) return null;

	const next = nextNonEmptyLine(lines, i + 1);
	if (next && next.text.length < 100 && !SECTION_NUMBER_REGEX.test(next.text.replace(/\t/g, " "))) {
		return { heading: `# Chapter ${chapterMatch[1]}: ${next.text}`, nextIndex: next.index + 1 };
	}

	return { heading: `# Chapter ${chapterMatch[1]}`, nextIndex: i + 1 };
}

function tryParseSectionHeading(trimmed: string): string | null {
	const m = trimmed.match(SECTION_NUMBER_REGEX);
	if (!m) return null;
	const level = Math.min((m[1].match(/\./g) || []).length + 1, 6);
	return `${"#".repeat(level)} ${m[1]} ${m[2].trim()}`;
}

function hasSectionNumbers(lines: string[]): boolean {
	return lines.some((line) => SECTION_NUMBER_REGEX.test(normalizeTabs(line)));
}

/**
 * Pre-process MarkItDown PDF output to inject markdown headings.
 *
 * MarkItDown strips heading markup from PDFs, producing flat text with
 * patterns like "1.1 \tOverview" and "Chapter \t1". This function detects
 * those patterns and converts them to proper markdown headings.
 *
 * Also strips page separators ("-- 3 of 24 --") and running headers
 * repeated on each page.
 */
export function preprocessPdfMarkdown(markdown: string): string {
	const lines = markdown.split("\n");

	if (!hasSectionNumbers(lines)) {
		return lines.filter((line) => !PAGE_SEPARATOR_REGEX.test(line.trim())).join("\n");
	}

	return convertSectionLines(lines).join("\n");
}

function convertSectionLines(lines: string[]): string[] {
	const output: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const trimmed = normalizeTabs(lines[i]);

		if (isNoiseLine(trimmed)) {
			i++;
			continue;
		}

		const chapterResult = tryParseChapterHeading(trimmed, lines, i);
		if (chapterResult) {
			output.push(chapterResult.heading);
			i = chapterResult.nextIndex;
			continue;
		}

		output.push(tryParseSectionHeading(trimmed) ?? lines[i]);
		i++;
	}
	return output;
}

// ── Tree building ───────────────────────────────────────────────────────────

interface Segment {
	level: number;
	title: string;
	bodyLines: string[];
}

function parseSegments(lines: string[], root: TreeNode): Segment[] {
	const segments: Segment[] = [];
	let current: Segment | null = null;

	for (const line of lines) {
		const match = line.match(HEADING_REGEX);
		if (match) {
			if (current) segments.push(current);
			current = { level: match[1].length, title: match[2].trim(), bodyLines: [] };
		} else if (current) {
			current.bodyLines.push(line);
		} else {
			root.content += `${line}\n`;
		}
	}
	if (current) segments.push(current);

	root.content = root.content.trimEnd();
	return segments;
}

function segmentToNode(seg: Segment): TreeNode {
	const body = seg.bodyLines.join("\n");
	return {
		title: seg.title,
		content: body.trimEnd(),
		depth: seg.level,
		order: 0,
		nodeType: inferNodeType(seg.title, seg.level),
		children: [],
		startPage: extractPageNumber(body, "first"),
		endPage: extractPageNumber(body),
	};
}

function buildTreeFromSegments(root: TreeNode, segments: Segment[]): void {
	const stack: TreeNode[] = [root];

	for (const seg of segments) {
		const node = segmentToNode(seg);

		while (stack.length > 1 && stack[stack.length - 1].depth >= seg.level) {
			stack.pop();
		}

		const parent = stack[stack.length - 1];
		node.order = parent.children.length;
		parent.children.push(node);
		stack.push(node);
	}
}

// ── Short-leaf merging ──────────────────────────────────────────────────────

function formatMergedLeaf(node: TreeNode): string {
	return node.content ? `**${node.title}**: ${node.content}` : `**${node.title}**`;
}

function appendContent(existing: string, addition: string): string {
	return existing ? `${existing}\n\n${addition}` : addition;
}

function mergeShortLeaves(node: TreeNode): void {
	for (const child of node.children) {
		mergeShortLeaves(child);
	}

	const kept: TreeNode[] = [];
	for (const child of node.children) {
		if (child.children.length === 0 && child.content.length < 50) {
			node.content = appendContent(node.content, formatMergedLeaf(child));
		} else {
			child.order = kept.length;
			kept.push(child);
		}
	}
	node.children = kept;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse markdown into a tree based on heading structure.
 * Pure function, no LLM or I/O.
 */
export function parseMarkdownTree(markdown: string, filename: string): TreeNode {
	const processed = preprocessPdfMarkdown(markdown);

	const root: TreeNode = {
		title: filename.replace(/\.[^.]+$/, ""),
		content: "",
		depth: 0,
		order: 0,
		nodeType: "section",
		children: [],
		startPage: extractPageNumber(processed, "first"),
		endPage: extractPageNumber(processed),
	};

	const segments = parseSegments(processed.split("\n"), root);

	if (segments.length === 0) {
		root.nodeType = inferNodeType(root.title, 0);
		return root;
	}

	buildTreeFromSegments(root, segments);
	mergeShortLeaves(root);
	return root;
}

/** Check if a markdown document contains headings (including PDF section numbers) */
export function hasHeadings(markdown: string): boolean {
	return markdown.split("\n").some((line) => {
		if (HEADING_REGEX.test(line)) return true;
		const trimmed = normalizeTabs(line);
		return SECTION_NUMBER_REGEX.test(trimmed) || CHAPTER_LINE_REGEX.test(trimmed);
	});
}
