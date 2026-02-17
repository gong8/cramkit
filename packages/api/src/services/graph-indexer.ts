import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";
import { chatCompletion } from "./llm-client.js";

const log = createLogger("api");

export class GraphIndexError extends Error {
	constructor(
		message: string,
		public readonly errorType: "llm_error" | "parse_error" | "db_error" | "unknown",
		public readonly resourceId: string,
	) {
		super(message);
		this.name = "GraphIndexError";
	}
}

interface ExtractedConcept {
	name: string;
	description?: string;
	aliases?: string;
}

interface ConceptLink {
	conceptName: string;
	relationship: string;
	confidence?: number;
	chunkTitle?: string;
}

interface ConceptConceptLink {
	sourceConcept: string;
	targetConcept: string;
	relationship: string;
	confidence?: number;
}

interface QuestionConceptLink {
	questionLabel: string;
	conceptName: string;
	relationship: string;
	confidence?: number;
}

interface ExtractionResult {
	concepts: ExtractedConcept[];
	file_concept_links: ConceptLink[];
	concept_concept_links: ConceptConceptLink[];
	question_concept_links: QuestionConceptLink[];
}

function toTitleCase(str: string): string {
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

function fuzzyMatchTitle(
	needle: string,
	haystack: Map<string, string>,
	threshold = 0.6,
): string | null {
	const needleLower = needle.toLowerCase();
	// Try exact match first
	const exact = haystack.get(needleLower);
	if (exact) return exact;
	// Fuzzy fallback
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

interface ChunkInfo {
	id: string;
	title: string | null;
	content: string;
	depth: number;
	nodeType: string;
	parentId: string | null;
	diskPath: string | null;
}

function buildStructuredContent(chunks: ChunkInfo[]): string {
	const childMap = new Map<string | null, ChunkInfo[]>();
	for (const chunk of chunks) {
		const parentId = chunk.parentId;
		if (!childMap.has(parentId)) childMap.set(parentId, []);
		childMap.get(parentId)?.push(chunk);
	}

	const lines: string[] = [];

	function renderNode(chunk: ChunkInfo, indent: number): void {
		const prefix = "  ".repeat(indent);
		const nodeLabel = chunk.nodeType !== "section" ? `[${chunk.nodeType}] ` : "";
		lines.push(`${prefix}${nodeLabel}${chunk.title || "(untitled)"} (depth=${chunk.depth})`);
		if (chunk.content) {
			const preview = chunk.content.slice(0, 500);
			for (const line of preview.split("\n")) {
				lines.push(`${prefix}  ${line}`);
			}
			if (chunk.content.length > 500) {
				lines.push(`${prefix}  [...${chunk.content.length - 500} more chars]`);
			}
		}
		lines.push("");

		const children = childMap.get(chunk.id) || [];
		for (const child of children) {
			renderNode(child, indent + 1);
		}
	}

	const roots = childMap.get(null) || [];
	for (const root of roots) {
		renderNode(root, 0);
	}

	return lines.join("\n");
}

function buildPrompt(
	resource: { name: string; type: string; label: string | null },
	files: Array<{ filename: string; role: string }>,
	chunks: ChunkInfo[],
	existingConcepts: Array<{ name: string; description: string | null }>,
): Array<{ role: "system" | "user"; content: string }> {
	const hasTree = chunks.some((c) => c.parentId !== null);
	const existingConceptsList =
		existingConcepts.length > 0
			? `\n\nExisting concepts in this session (reuse exact names where applicable):\n${existingConcepts.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`).join("\n")}`
			: "";

	let contentStr: string;
	if (hasTree) {
		contentStr = buildStructuredContent(chunks);
	} else {
		contentStr = chunks
			.map((c) => c.content)
			.join("\n\n")
			.replace(/\0/g, "");
	}

	const structuredNote = hasTree
		? `\nThe content is organized as a hierarchical tree of sections. Each section has a type (e.g., definition, theorem, proof, example, question, chapter, section). Use this structure to better understand the material's organization. When creating file_concept_links, include the chunkTitle to specify which section the concept appears in.`
		: "";

	const fileList = files.map((f) => `  - ${f.filename} (${f.role})`).join("\n");

	const wasTruncated = contentStr.length > 30000;
	contentStr = contentStr.slice(0, 30000);
	if (wasTruncated) {
		contentStr += "\n\n[Content truncated — extract concepts only from the content shown above]";
	}

	return [
		{
			role: "system",
			content: `You are a knowledge graph extraction system. Analyze the provided academic material and extract structured knowledge.
${structuredNote}
Extract the following:
1. **concepts**: Key topics, theorems, definitions, methods, and important ideas. Each concept has: name (Title Case), description (brief), aliases (comma-separated alternative names, optional).
2. **file_concept_links**: How this resource relates to each concept. relationship can be: "covers", "introduces", "applies", "references", "proves". Include confidence (0-1).${hasTree ? " Optionally include chunkTitle to specify which section." : ""}
3. **concept_concept_links**: Relationships between concepts. relationship can be: "prerequisite", "related_to", "extends", "generalizes", "special_case_of", "contradicts". Include confidence (0-1).
4. **question_concept_links**: For past papers and problem sheets, which questions test which concepts. relationship can be: "tests", "applies", "requires". Include confidence (0-1).

Rules:
- Use Title Case for concept names
- Reuse existing concept names exactly when the same concept appears
- Be selective — extract meaningful concepts, not every noun
- Confidence should reflect how strongly the relationship holds${existingConceptsList}

Respond with ONLY valid JSON in this exact format:
{
  "concepts": [{ "name": "...", "description": "...", "aliases": "..." }],
  "file_concept_links": [{ "conceptName": "...", "relationship": "...", "confidence": 0.9${hasTree ? ', "chunkTitle": "..."' : ""} }],
  "concept_concept_links": [{ "sourceConcept": "...", "targetConcept": "...", "relationship": "...", "confidence": 0.8 }],
  "question_concept_links": [{ "questionLabel": "...", "conceptName": "...", "relationship": "...", "confidence": 0.9 }]
}`,
		},
		{
			role: "user",
			content: `Resource: ${resource.name}
Type: ${resource.type}${resource.label ? `\nLabel: ${resource.label}` : ""}
Files:
${fileList}

Content:
${contentStr}`,
		},
	];
}

const MAX_LLM_ATTEMPTS = 3;

async function extractWithRetries(
	messages: Array<{ role: "system" | "user"; content: string }>,
	resourceName: string,
	resourceId: string,
): Promise<ExtractionResult> {
	for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
		let rawResponse = "";
		try {
			rawResponse = await chatCompletion(messages);
			const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawResponse];
			return JSON.parse(jsonMatch[1]?.trim()) as ExtractionResult;
		} catch (error) {
			if (error instanceof SyntaxError) {
				log.error(
					`indexResourceGraph — JSON parse failed for "${resourceName}" (attempt ${attempt}/${MAX_LLM_ATTEMPTS}). Response starts with: "${rawResponse.slice(0, 300)}"`,
				);
			} else {
				log.error(
					`indexResourceGraph — LLM call failed for "${resourceName}" (attempt ${attempt}/${MAX_LLM_ATTEMPTS})`,
					error,
				);
			}
			if (attempt === MAX_LLM_ATTEMPTS) {
				throw new GraphIndexError(
					`Giving up on "${resourceName}" after ${MAX_LLM_ATTEMPTS} attempts`,
					error instanceof SyntaxError ? "parse_error" : "llm_error",
					resourceId,
				);
			}
			log.info(
				`indexResourceGraph — retrying "${resourceName}" (attempt ${attempt + 1}/${MAX_LLM_ATTEMPTS})...`,
			);
		}
	}
	throw new GraphIndexError("Unreachable", "unknown", resourceId);
}

type RelData = Prisma.RelationshipCreateManyInput;

function findChunkByLabel(chunks: ChunkInfo[], label: string): ChunkInfo | undefined {
	const lower = label.toLowerCase();
	return (
		chunks.find((c) => c.title?.toLowerCase() === lower) ||
		chunks.find((c) => c.title?.toLowerCase().startsWith(lower)) ||
		chunks.find(
			(c) => c.title?.toLowerCase().includes(lower) || c.content.toLowerCase().includes(lower),
		)
	);
}

function buildRelationshipData(
	result: ExtractionResult,
	conceptMap: Map<string, string>,
	chunkByTitle: Map<string, string>,
	chunks: ChunkInfo[],
	sessionId: string,
	resourceId: string,
	resourceName: string,
): RelData[] {
	const relationships: RelData[] = [];

	for (const link of result.file_concept_links) {
		const conceptName = toTitleCase(link.conceptName);
		const conceptId = conceptMap.get(conceptName);
		if (!conceptId) continue;

		let sourceType = "resource";
		let sourceId = resourceId;
		let sourceLabel = resourceName;

		if (link.chunkTitle) {
			const chunkId = fuzzyMatchTitle(link.chunkTitle, chunkByTitle);
			if (chunkId) {
				sourceType = "chunk";
				sourceId = chunkId;
				sourceLabel = link.chunkTitle;
			}
		}

		relationships.push({
			sessionId,
			sourceType,
			sourceId,
			sourceLabel,
			targetType: "concept",
			targetId: conceptId,
			targetLabel: conceptName,
			relationship: link.relationship,
			confidence: link.confidence ?? 0.8,
			createdBy: "system",
		});
	}

	for (const link of result.concept_concept_links) {
		const sourceId = conceptMap.get(toTitleCase(link.sourceConcept));
		const targetId = conceptMap.get(toTitleCase(link.targetConcept));
		if (!sourceId || !targetId) continue;

		relationships.push({
			sessionId,
			sourceType: "concept",
			sourceId,
			sourceLabel: toTitleCase(link.sourceConcept),
			targetType: "concept",
			targetId,
			targetLabel: toTitleCase(link.targetConcept),
			relationship: link.relationship,
			confidence: link.confidence ?? 0.7,
			createdBy: "system",
		});
	}

	for (const link of result.question_concept_links) {
		const conceptName = toTitleCase(link.conceptName);
		const conceptId = conceptMap.get(conceptName);
		if (!conceptId) continue;

		const matchingChunk = findChunkByLabel(chunks, link.questionLabel);

		relationships.push({
			sessionId,
			sourceType: matchingChunk ? "chunk" : "resource",
			sourceId: matchingChunk?.id || resourceId,
			sourceLabel: link.questionLabel,
			targetType: "concept",
			targetId: conceptId,
			targetLabel: conceptName,
			relationship: link.relationship,
			confidence: link.confidence ?? 0.8,
			createdBy: "system",
		});
	}

	return relationships;
}

function deduplicateRelationships(relationships: RelData[]): RelData[] {
	const seen = new Set<string>();
	return relationships.filter((r) => {
		const key = `${r.sourceType}:${r.sourceId}:${r.targetType}:${r.targetId}:${r.relationship}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export async function indexResourceGraph(resourceId: string): Promise<void> {
	const db = getDb();

	const resource = await db.resource.findUnique({
		where: { id: resourceId },
		include: {
			files: {
				select: { id: true, filename: true, role: true },
			},
			chunks: {
				select: {
					id: true,
					content: true,
					title: true,
					depth: true,
					nodeType: true,
					parentId: true,
					diskPath: true,
				},
				orderBy: { index: "asc" },
			},
		},
	});

	if (!resource) {
		throw new GraphIndexError("Resource not found", "unknown", resourceId);
	}

	if (!resource.isIndexed) {
		throw new GraphIndexError("Not content-indexed yet", "unknown", resourceId);
	}

	log.info(`indexResourceGraph — starting "${resource.name}" (${resourceId})`);

	const startTime = Date.now();

	const existingConcepts = await db.concept.findMany({
		where: { sessionId: resource.sessionId },
		select: { name: true, description: true },
	});

	const messages = buildPrompt(
		{ name: resource.name, type: resource.type, label: resource.label },
		resource.files,
		resource.chunks,
		existingConcepts,
	);

	const result = await extractWithRetries(messages, resource.name, resourceId);

	try {
		await db.$transaction(
			async (tx) => {
				const chunkIds = resource.chunks.map((c) => c.id);
				const sourceIds = [resourceId, ...chunkIds];
				await tx.relationship.deleteMany({
					where: {
						sessionId: resource.sessionId,
						createdBy: "system",
						OR: [{ sourceId: { in: sourceIds } }, { sourceType: "resource", sourceId: resourceId }],
					},
				});

				for (const concept of result.concepts) {
					const name = toTitleCase(concept.name);
					await tx.concept.upsert({
						where: {
							sessionId_name: { sessionId: resource.sessionId, name },
						},
						update: {
							description: concept.description || undefined,
							aliases: concept.aliases || undefined,
						},
						create: {
							sessionId: resource.sessionId,
							name,
							description: concept.description || null,
							aliases: concept.aliases || null,
							createdBy: "system",
						},
					});
				}

				const allConcepts = await tx.concept.findMany({
					where: { sessionId: resource.sessionId },
					select: { id: true, name: true },
				});
				const conceptMap = new Map(allConcepts.map((c) => [c.name, c.id]));

				const chunkByTitle = new Map<string, string>();
				for (const chunk of resource.chunks) {
					if (chunk.title) {
						chunkByTitle.set(chunk.title.toLowerCase(), chunk.id);
					}
				}

				const relationships = deduplicateRelationships(
					buildRelationshipData(
						result,
						conceptMap,
						chunkByTitle,
						resource.chunks,
						resource.sessionId,
						resourceId,
						resource.name,
					),
				);

				if (relationships.length > 0) {
					await tx.relationship.createMany({ data: relationships });
				}

				const graphIndexDurationMs = Date.now() - startTime;
				await tx.resource.update({
					where: { id: resourceId },
					data: { isGraphIndexed: true, graphIndexDurationMs },
				});
			},
			{ timeout: 30000 },
		);
	} catch (error) {
		if (error instanceof GraphIndexError) throw error;
		throw new GraphIndexError(
			error instanceof Error ? error.message : String(error),
			"db_error",
			resourceId,
		);
	}

	log.info(
		`indexResourceGraph — completed "${resource.name}": ${result.concepts.length} concepts, ${result.file_concept_links.length + result.concept_concept_links.length + result.question_concept_links.length} relationships`,
	);
}
