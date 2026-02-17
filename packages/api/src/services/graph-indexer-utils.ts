export function toTitleCase(str: string): string {
	return str
		.split(" ")
		.map((word) => {
			// Preserve all-caps words (likely acronyms: ODE, PDE, FFT)
			if (word.length >= 2 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) {
				return word;
			}
			// Preserve words with internal capitals (pH, mRNA, d'Alembert)
			if (/[a-z][A-Z]|'[A-Z]/.test(word)) {
				return word;
			}
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		})
		.join(" ");
}

function diceCoefficient(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const bigrams = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const bigram = a.slice(i, i + 2);
		bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
	}
	let overlap = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const bigram = b.slice(i, i + 2);
		const count = bigrams.get(bigram);
		if (count && count > 0) {
			overlap++;
			bigrams.set(bigram, count - 1);
		}
	}
	return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

export function fuzzyMatchTitle(
	needle: string,
	haystack: Map<string, string>,
	threshold = 0.6,
): string | null {
	const needleLower = needle.toLowerCase();
	const exact = haystack.get(needleLower);
	if (exact) return exact;
	let bestId: string | null = null;
	let bestScore = threshold;
	for (const [title, id] of haystack) {
		const score = diceCoefficient(needleLower, title);
		if (score > bestScore) {
			bestScore = score;
			bestId = id;
		}
	}
	return bestId;
}

export function findChunkByLabel<T extends { title: string | null; content: string }>(
	chunks: T[],
	label: string,
): T | undefined {
	const lower = label.toLowerCase();
	return (
		chunks.find((c) => c.title?.toLowerCase() === lower) ||
		chunks.find((c) => c.title?.toLowerCase().startsWith(lower)) ||
		chunks.find(
			(c) => c.title?.toLowerCase().includes(lower) || c.content.toLowerCase().includes(lower),
		)
	);
}
