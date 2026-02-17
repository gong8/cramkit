import { describe, it, expect } from "vitest";
import { preprocessPdfMarkdown, parseMarkdownTree, hasHeadings } from "../../packages/api/src/services/markdown-parser.js";

describe("preprocessPdfMarkdown", () => {
	it("converts section numbers to headings", () => {
		const input = [
			"Chapter \t1",
			"Introduction",
			"1.1 \tOverview of the module",
			"Some content here about the module.",
			"",
			"-- 1 of 24 --",
			"",
			"1.2 \tWhat is a PDE?",
			"More content about PDEs.",
			"1.2.1 \tDefinition",
			"A PDE is defined as...",
			"1.2.2 \tBasic properties",
			"Properties include...",
		].join("\n");

		const result = preprocessPdfMarkdown(input);
		const headings = result.split("\n").filter((l) => /^#+\s/.test(l));

		expect(headings).toContain("# Chapter 1: Introduction");
		expect(headings).toContain("## 1.1 Overview of the module");
		expect(headings).toContain("## 1.2 What is a PDE?");
		expect(headings).toContain("### 1.2.1 Definition");
		expect(headings).toContain("### 1.2.2 Basic properties");

		// Page separator should be stripped
		expect(result).not.toContain("-- 1 of 24 --");
	});

	it("passes through content without section numbers", () => {
		const input = "# My Heading\nSome content.\n## Sub heading\nMore content.";
		const result = preprocessPdfMarkdown(input);
		expect(result).toBe(input);
	});

	it("strips page separators even without section numbers", () => {
		const input = "# Heading\nContent\n\n-- 1 of 5 --\n\nMore content";
		const result = preprocessPdfMarkdown(input);
		expect(result).not.toContain("-- 1 of 5 --");
	});
});

describe("parseMarkdownTree with PDF section numbers", () => {
	it("builds deep tree from section numbers", () => {
		// Content must be >50 chars per section or mergeShortLeaves collapses them
		const filler = "This is enough content to avoid being merged into the parent node by the short-leaf merger.";
		const input = [
			"Chapter \t1",
			"Introduction",
			"1.1 \tOverview",
			filler,
			"1.2 \tWhat is a PDE?",
			filler,
			"1.2.1 \tDefinition",
			filler,
			"1.2.2 \tBasic properties",
			filler,
			"1.3 \tDimensional analysis",
			filler,
			"1.3.1 \tGoal",
			filler,
		].join("\n");

		const tree = parseMarkdownTree(input, "Chapter_1.pdf");

		// Should have Chapter 1 as child of root
		const chapter = tree.children[0];
		expect(chapter.title).toContain("Chapter 1");
		expect(chapter.depth).toBe(1);

		// Chapter should have 3 sections: 1.1, 1.2, 1.3
		expect(chapter.children.length).toBe(3);

		// Section 1.2 should have subsections 1.2.1, 1.2.2
		const section12 = chapter.children[1];
		expect(section12.title).toContain("1.2");
		expect(section12.children.length).toBe(2);
		expect(section12.children[0].title).toContain("1.2.1");
		expect(section12.children[1].title).toContain("1.2.2");

		// Section 1.3 should have subsection 1.3.1
		const section13 = chapter.children[2];
		expect(section13.title).toContain("1.3");
		expect(section13.children.length).toBe(1);
	});

	it("infers chapter node type", () => {
		const filler = "This is enough content to avoid being merged into the parent node by the short-leaf merger.";
		const input = [
			"Chapter \t2",
			"Methods",
			"2.1 \tOverview of characteristics",
			filler,
			"2.2 \tUniqueness results",
			filler,
		].join("\n");

		const tree = parseMarkdownTree(input, "Chapter_2.pdf");
		const chapter = tree.children[0];
		expect(chapter.nodeType).toBe("chapter");
		expect(chapter.children.length).toBe(2);
		// Sections with number prefix are typed as "section" (number prefix blocks pattern match)
		expect(chapter.children[0].nodeType).toBe("section");
	});
});

describe("hasHeadings", () => {
	it("detects markdown headings", () => {
		expect(hasHeadings("# Title\nContent")).toBe(true);
		expect(hasHeadings("Just plain text")).toBe(false);
	});

	it("detects PDF section number patterns", () => {
		expect(hasHeadings("1.1 \tOverview\nContent")).toBe(true);
		expect(hasHeadings("Chapter \t1\nIntroduction")).toBe(true);
	});
});
