import { createLogger, getDb } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";
import { findChunkByLabel, fuzzyMatchTitle, toTitleCase } from "./graph-indexer-utils.js";
import { chatCompletion } from "./llm-client.js";

const log = createLogger("api");

export type Thoroughness = "quick" | "standard" | "thorough";

interface ThoroughnessConfig {
	contentLimit: number;
	previewLimit: number | null; // null = full content
	promptStyle: "selective" | "standard" | "comprehensive";
	multiPass: boolean;
}

const THOROUGHNESS_CONFIGS: Record<Thoroughness, ThoroughnessConfig> = {
	quick: {
		contentLimit: 20_000,
		previewLimit: 300,
		promptStyle: "selective",
		multiPass: false,
	},
	standard: {
		contentLimit: 30_000,
		previewLimit: 500,
		promptStyle: "standard",
		multiPass: false,
	},
	thorough: {
		contentLimit: 150_000,
		previewLimit: null,
		promptStyle: "comprehensive",
		multiPass: true,
	},
};

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

interface ChunkInfo {
	id: string;
	title: string | null;
	content: string;
	depth: number;
	nodeType: string;
	parentId: string | null;
	diskPath: string | null;
}

function buildStructuredContent(chunks: ChunkInfo[], previewLimit: number | null): string {
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
			const showFull = previewLimit === null || chunk.content.length <= previewLimit;
			const preview = showFull ? chunk.content : chunk.content.slice(0, previewLimit);
			for (const line of preview.split("\n")) {
				lines.push(`${prefix}  ${line}`);
			}
			if (!showFull) {
				lines.push(`${prefix}  [...${chunk.content.length - previewLimit} more chars]`);
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

function buildContentString(chunks: ChunkInfo[], config: ThoroughnessConfig): string {
	const hasTree = chunks.some((c) => c.parentId !== null);
	let content = hasTree
		? buildStructuredContent(chunks, config.previewLimit)
		: chunks
				.map((c) => c.content)
				.join("\n\n")
				.replace(/\0/g, "");

	if (content.length > config.contentLimit) {
		content = `${content.slice(0, config.contentLimit)}\n\n[Content truncated — extract concepts only from the content shown above]`;
	}
	return content;
}

const PROMPT_RULES: Record<ThoroughnessConfig["promptStyle"], string> = {
	selective:
		"- Focus on the most important concepts only — skip minor or peripheral topics\n- Be selective — extract meaningful concepts, not every noun",
	standard: "- Be selective — extract meaningful concepts, not every noun",
	comprehensive:
		"- Be thorough — extract ALL concepts, definitions, theorems, methods, examples, and named results\n- Create rich relationships between concepts — don't skip peripheral or supporting concepts\n- Actively link to existing concepts from other resources when applicable",
};

function buildPrompt(
	resource: { name: string; type: string; label: string | null },
	files: Array<{ filename: string; role: string }>,
	chunks: ChunkInfo[],
	existingConcepts: Array<{ name: string; description: string | null }>,
	config: ThoroughnessConfig,
): Array<{ role: "system" | "user"; content: string }> {
	const hasTree = chunks.some((c) => c.parentId !== null);
	const existingConceptsList =
		existingConcepts.length > 0
			? `\n\nExisting concepts in this session (reuse exact names where applicable):\n${existingConcepts.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`).join("\n")}`
			: "";

	const structuredNote = hasTree
		? `\nThe content is organized as a hierarchical tree of sections. Each section has a type (e.g., definition, theorem, proof, example, question, chapter, section). Use this structure to better understand the material's organization. When creating file_concept_links, include the chunkTitle to specify which section the concept appears in.`
		: "";

	const crossLinkNote =
		config.promptStyle === "comprehensive" && existingConcepts.length > 0
			? "\n- Actively create concept_concept_links between concepts found here and existing concepts from other resources"
			: "";

	const fileList = files.map((f) => `  - ${f.filename} (${f.role})`).join("\n");
	const contentStr = buildContentString(chunks, config);

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
${PROMPT_RULES[config.promptStyle]}
- Confidence should reflect how strongly the relationship holds${crossLinkNote}${existingConceptsList}

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

function makeRel(
	sessionId: string,
	sourceType: string,
	sourceId: string,
	sourceLabel: string,
	targetId: string,
	targetLabel: string,
	relationship: string,
	confidence: number,
): RelData {
	return {
		sessionId,
		sourceType,
		sourceId,
		sourceLabel,
		targetType: "concept",
		targetId,
		targetLabel,
		relationship,
		confidence,
		createdBy: "system",
	};
}

function resolveConcept(
	name: string,
	conceptMap: Map<string, string>,
): { id: string; name: string } | null {
	const titleCased = toTitleCase(name);
	const id = conceptMap.get(titleCased);
	return id ? { id, name: titleCased } : null;
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
		const target = resolveConcept(link.conceptName, conceptMap);
		if (!target) continue;

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

		relationships.push(
			makeRel(
				sessionId,
				sourceType,
				sourceId,
				sourceLabel,
				target.id,
				target.name,
				link.relationship,
				link.confidence ?? 0.8,
			),
		);
	}

	for (const link of result.concept_concept_links) {
		const source = resolveConcept(link.sourceConcept, conceptMap);
		const target = resolveConcept(link.targetConcept, conceptMap);
		if (!source || !target) continue;

		relationships.push(
			makeRel(
				sessionId,
				"concept",
				source.id,
				source.name,
				target.id,
				target.name,
				link.relationship,
				link.confidence ?? 0.7,
			),
		);
	}

	for (const link of result.question_concept_links) {
		const target = resolveConcept(link.conceptName, conceptMap);
		if (!target) continue;

		const matchingChunk = findChunkByLabel(chunks, link.questionLabel);
		relationships.push(
			makeRel(
				sessionId,
				matchingChunk ? "chunk" : "resource",
				matchingChunk?.id || resourceId,
				link.questionLabel,
				target.id,
				target.name,
				link.relationship,
				link.confidence ?? 0.8,
			),
		);
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

async function clearOldRelationships(
	tx: Prisma.TransactionClient,
	sessionId: string,
	resourceId: string,
	chunks: ChunkInfo[],
): Promise<void> {
	const sourceIds = [resourceId, ...chunks.map((c) => c.id)];
	await tx.relationship.deleteMany({
		where: {
			sessionId,
			createdBy: "system",
			OR: [{ sourceId: { in: sourceIds } }, { sourceType: "resource", sourceId: resourceId }],
		},
	});
}

async function upsertConcepts(
	tx: Prisma.TransactionClient,
	sessionId: string,
	concepts: ExtractedConcept[],
): Promise<void> {
	for (const concept of concepts) {
		const name = toTitleCase(concept.name);
		await tx.concept.upsert({
			where: { sessionId_name: { sessionId, name } },
			update: {
				description: concept.description || undefined,
				aliases: concept.aliases || undefined,
			},
			create: {
				sessionId,
				name,
				description: concept.description || null,
				aliases: concept.aliases || null,
				createdBy: "system",
			},
		});
	}
}

async function loadConceptMap(
	tx: Prisma.TransactionClient,
	sessionId: string,
): Promise<Map<string, string>> {
	const allConcepts = await tx.concept.findMany({
		where: { sessionId },
		select: { id: true, name: true },
	});
	return new Map(allConcepts.map((c) => [c.name, c.id]));
}

function buildChunkTitleMap(chunks: ChunkInfo[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const chunk of chunks) {
		if (chunk.title) {
			map.set(chunk.title.toLowerCase(), chunk.id);
		}
	}
	return map;
}

/** Split chunks into sections for multi-pass extraction. */
function splitIntoSections(chunks: ChunkInfo[]): ChunkInfo[][] {
	const hasTree = chunks.some((c) => c.parentId !== null);

	if (hasTree) {
		// Group by root-level parents (depth 0)
		const roots = chunks.filter((c) => c.depth === 0);
		if (roots.length <= 1) return [chunks];

		const childMap = new Map<string, ChunkInfo[]>();
		for (const root of roots) childMap.set(root.id, []);

		for (const chunk of chunks) {
			if (chunk.depth === 0) continue;
			// Walk up to find root parent
			let current = chunk;
			while (current.parentId !== null) {
				const parent = chunks.find((c) => c.id === current.parentId);
				if (!parent) break;
				if (parent.depth === 0) {
					childMap.get(parent.id)?.push(chunk);
					break;
				}
				current = parent;
			}
		}

		return roots.map((root) => [root, ...(childMap.get(root.id) || [])]);
	}

	// Flat: batch in groups of 6
	const sections: ChunkInfo[][] = [];
	for (let i = 0; i < chunks.length; i += 6) {
		sections.push(chunks.slice(i, i + 6));
	}
	return sections;
}

/** Merge multiple extraction results: keep longer descriptions, union aliases, deduplicate relationships by keeping higher confidence. */
function mergeExtractionResults(results: ExtractionResult[]): ExtractionResult {
	const conceptMap = new Map<string, ExtractedConcept>();
	for (const result of results) {
		for (const concept of result.concepts) {
			const key = toTitleCase(concept.name);
			const existing = conceptMap.get(key);
			if (!existing) {
				conceptMap.set(key, { ...concept, name: key });
			} else {
				// Keep longer description
				if (
					concept.description &&
					(!existing.description || concept.description.length > existing.description.length)
				) {
					existing.description = concept.description;
				}
				// Union aliases
				if (concept.aliases) {
					const existingAliases = new Set(
						(existing.aliases || "")
							.split(",")
							.map((a) => a.trim())
							.filter(Boolean),
					);
					for (const alias of concept.aliases
						.split(",")
						.map((a) => a.trim())
						.filter(Boolean)) {
						existingAliases.add(alias);
					}
					existing.aliases = [...existingAliases].join(", ");
				}
			}
		}
	}

	// Deduplicate relationships by key, keeping higher confidence
	const fileLinks = new Map<string, ConceptLink>();
	const conceptLinks = new Map<string, ConceptConceptLink>();
	const questionLinks = new Map<string, QuestionConceptLink>();

	for (const result of results) {
		for (const link of result.file_concept_links) {
			const key = `${link.conceptName}:${link.relationship}:${link.chunkTitle || ""}`;
			const existing = fileLinks.get(key);
			if (!existing || (link.confidence ?? 0) > (existing.confidence ?? 0)) {
				fileLinks.set(key, link);
			}
		}
		for (const link of result.concept_concept_links) {
			const key = `${link.sourceConcept}:${link.targetConcept}:${link.relationship}`;
			const existing = conceptLinks.get(key);
			if (!existing || (link.confidence ?? 0) > (existing.confidence ?? 0)) {
				conceptLinks.set(key, link);
			}
		}
		for (const link of result.question_concept_links) {
			const key = `${link.questionLabel}:${link.conceptName}:${link.relationship}`;
			const existing = questionLinks.get(key);
			if (!existing || (link.confidence ?? 0) > (existing.confidence ?? 0)) {
				questionLinks.set(key, link);
			}
		}
	}

	return {
		concepts: [...conceptMap.values()],
		file_concept_links: [...fileLinks.values()],
		concept_concept_links: [...conceptLinks.values()],
		question_concept_links: [...questionLinks.values()],
	};
}

/** Write extraction result to DB (shared by single-pass and multi-pass). */
async function writeResultToDb(
	db: ReturnType<typeof getDb>,
	result: ExtractionResult,
	resource: { id: string; sessionId: string; name: string },
	chunks: ChunkInfo[],
	startTime: number,
): Promise<void> {
	try {
		await db.$transaction(
			async (tx) => {
				await clearOldRelationships(tx, resource.sessionId, resource.id, chunks);
				await upsertConcepts(tx, resource.sessionId, result.concepts);

				const conceptMap = await loadConceptMap(tx, resource.sessionId);
				const chunkByTitle = buildChunkTitleMap(chunks);

				const relationships = deduplicateRelationships(
					buildRelationshipData(
						result,
						conceptMap,
						chunkByTitle,
						chunks,
						resource.sessionId,
						resource.id,
						resource.name,
					),
				);

				if (relationships.length > 0) {
					await tx.relationship.createMany({ data: relationships });
				}

				await tx.resource.update({
					where: { id: resource.id },
					data: { isGraphIndexed: true, graphIndexDurationMs: Date.now() - startTime },
				});
			},
			{ timeout: 30000 },
		);
	} catch (error) {
		if (error instanceof GraphIndexError) throw error;
		throw new GraphIndexError(
			error instanceof Error ? error.message : String(error),
			"db_error",
			resource.id,
		);
	}
}

/** Multi-pass extraction: process each section independently with cumulative context. */
async function indexResourceMultiPass(
	resource: { id: string; name: string; type: string; label: string | null; sessionId: string },
	files: Array<{ filename: string; role: string }>,
	chunks: ChunkInfo[],
	existingConcepts: Array<{ name: string; description: string | null }>,
	config: ThoroughnessConfig,
): Promise<ExtractionResult> {
	const sections = splitIntoSections(chunks);

	if (sections.length <= 1) {
		log.info("indexResourceMultiPass — only 1 section, falling back to single-pass");
		const messages = buildPrompt(
			{ name: resource.name, type: resource.type, label: resource.label },
			files,
			chunks,
			existingConcepts,
			config,
		);
		return extractWithRetries(messages, resource.name, resource.id);
	}

	log.info(`indexResourceMultiPass — "${resource.name}": ${sections.length} sections`);

	const allResults: ExtractionResult[] = [];
	const cumulativeConcepts = [...existingConcepts];

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		const sectionLabel = section[0]?.title || `Section ${i + 1}`;
		log.info(
			`indexResourceMultiPass — "${resource.name}" pass ${i + 1}/${sections.length}: "${sectionLabel}" (${section.length} chunks)`,
		);

		const messages = buildPrompt(
			{ name: resource.name, type: resource.type, label: resource.label },
			files,
			section,
			cumulativeConcepts,
			config,
		);

		const result = await extractWithRetries(
			messages,
			`${resource.name} [${sectionLabel}]`,
			resource.id,
		);
		allResults.push(result);

		// Feed newly discovered concepts into the cumulative list for the next pass
		for (const concept of result.concepts) {
			const name = toTitleCase(concept.name);
			if (!cumulativeConcepts.some((c) => c.name === name)) {
				cumulativeConcepts.push({ name, description: concept.description || null });
			}
		}
	}

	return mergeExtractionResults(allResults);
}

export async function indexResourceGraph(
	resourceId: string,
	thoroughness?: Thoroughness,
): Promise<void> {
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

	const config = THOROUGHNESS_CONFIGS[thoroughness ?? "standard"];
	log.info(
		`indexResourceGraph — starting "${resource.name}" (${resourceId}) [thoroughness=${thoroughness ?? "standard"}]`,
	);

	const startTime = Date.now();

	const existingConcepts = await db.concept.findMany({
		where: { sessionId: resource.sessionId },
		select: { name: true, description: true },
	});

	let result: ExtractionResult;

	if (config.multiPass && resource.chunks.length > 1) {
		result = await indexResourceMultiPass(
			{
				id: resourceId,
				name: resource.name,
				type: resource.type,
				label: resource.label,
				sessionId: resource.sessionId,
			},
			resource.files,
			resource.chunks,
			existingConcepts,
			config,
		);
	} else {
		const messages = buildPrompt(
			{ name: resource.name, type: resource.type, label: resource.label },
			resource.files,
			resource.chunks,
			existingConcepts,
			config,
		);
		result = await extractWithRetries(messages, resource.name, resourceId);
	}

	await writeResultToDb(
		db,
		result,
		{ id: resourceId, sessionId: resource.sessionId, name: resource.name },
		resource.chunks,
		startTime,
	);

	const totalRels =
		result.file_concept_links.length +
		result.concept_concept_links.length +
		result.question_concept_links.length;
	log.info(
		`indexResourceGraph — completed "${resource.name}": ${result.concepts.length} concepts, ${totalRels} relationships`,
	);
}
