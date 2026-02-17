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

/** Running headers repeated on every page: "1.2. WHAT IS A PDE?  3" or "CHAPTER 1. INTRODUCTION" */
const RUNNING_HEADER_REGEX = /^\d+\.\d+\.\s+[A-Z][A-Z\s?!]+\d*$/;
const CHAPTER_HEADER_REGEX = /^\d+\s+CHAPTER\s+\d+\.\s+[A-Z]/;

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

function normalizeTabs(line: string): string {
	return line.replace(/\t/g, " ").trim();
}

function hasSectionNumbers(lines: string[]): boolean {
	return lines.some((line) => SECTION_NUMBER_REGEX.test(normalizeTabs(line)));
}

function isNoiseLine(trimmed: string): boolean {
	return (
		PAGE_SEPARATOR_REGEX.test(trimmed) ||
		RUNNING_HEADER_REGEX.test(trimmed) ||
		CHAPTER_HEADER_REGEX.test(trimmed)
	);
}

function tryParseChapterHeading(
	trimmed: string,
	lines: string[],
	i: number,
): { heading: string; nextIndex: number } | null {
	const chapterMatch = trimmed.match(CHAPTER_LINE_REGEX);
	if (!chapterMatch) return null;

	let j = i + 1;
	while (j < lines.length && lines[j].trim() === "") j++;

	if (j < lines.length) {
		const nextTrimmed = lines[j].trim();
		const isValidTitle =
			nextTrimmed.length > 0 &&
			nextTrimmed.length < 100 &&
			!SECTION_NUMBER_REGEX.test(nextTrimmed.replace(/\t/g, " "));
		if (isValidTitle) {
			return {
				heading: `# Chapter ${chapterMatch[1]}: ${nextTrimmed}`,
				nextIndex: j + 1,
			};
		}
	}

	return { heading: `# Chapter ${chapterMatch[1]}`, nextIndex: i + 1 };
}

function tryParseSectionHeading(trimmed: string): string | null {
	const sectionMatch = trimmed.match(SECTION_NUMBER_REGEX);
	if (!sectionMatch) return null;

	const number = sectionMatch[1];
	const title = sectionMatch[2].trim();
	const dots = (number.match(/\./g) || []).length;
	const level = Math.min(dots + 1, 6);
	return `${"#".repeat(level)} ${number} ${title}`;
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

		const sectionHeading = tryParseSectionHeading(trimmed);
		if (sectionHeading) {
			output.push(sectionHeading);
			i++;
			continue;
		}

		output.push(lines[i]);
		i++;
	}

	return output.join("\n");
}

/**
 * Parse markdown into a tree based on heading structure.
 * Pure function, no LLM or I/O.
 */
export function parseMarkdownTree(markdown: string, filename: string): TreeNode {
	const processed = preprocessPdfMarkdown(markdown);
	const lines = processed.split("\n");

	const root: TreeNode = {
		title: filename.replace(/\.[^.]+$/, ""),
		content: "",
		depth: 0,
		order: 0,
		nodeType: "section",
		children: [],
		startPage: extractStartPage(processed),
		endPage: extractPageNumber(processed),
	};

	const segments = parseSegments(lines, root);

	if (segments.length === 0) {
		root.nodeType = inferNodeType(root.title, 0);
		return root;
	}

	buildTreeFromSegments(root, segments);
	mergeShortLeaves(root);

	return root;
}

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
		startPage: extractStartPage(body),
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
			const merged = child.content ? `**${child.title}**: ${child.content}` : `**${child.title}**`;
			node.content = node.content ? `${node.content}\n\n${merged}` : merged;
		} else {
			child.order = kept.length;
			kept.push(child);
		}
	}
	node.children = kept;
}

/** Check if a markdown document contains headings (including PDF section numbers) */
export function hasHeadings(markdown: string): boolean {
	return markdown.split("\n").some((line) => {
		if (HEADING_REGEX.test(line)) return true;
		// Also detect PDF section number patterns
		const trimmed = line.replace(/\t/g, " ").trim();
		if (SECTION_NUMBER_REGEX.test(trimmed)) return true;
		if (CHAPTER_LINE_REGEX.test(trimmed)) return true;
		return false;
	});
}
