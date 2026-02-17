/**
 * Remark plugin that upgrades inline math to display math when it contains
 * display-only commands like \tag, \tag*, or \label.
 *
 * This handles the common case where an AI tutor generates:
 *   $equation \tag{2.28}$
 * which should be rendered in display mode for KaTeX to support \tag.
 */

const DISPLAY_ONLY_PATTERN = /\\(?:tag\*?|label)\s*\{/;

interface MathNode {
	type: string;
	value: string;
	children?: MathNode[];
}

function visit(tree: MathNode, type: string, fn: (node: MathNode) => void) {
	if (tree.type === type) fn(tree);
	if (tree.children) {
		for (const child of tree.children) {
			visit(child, type, fn);
		}
	}
}

export function remarkMathDisplay() {
	return (tree: MathNode) => {
		visit(tree, "inlineMath", (node) => {
			if (DISPLAY_ONLY_PATTERN.test(node.value)) {
				node.type = "math";
			}
		});
	};
}
