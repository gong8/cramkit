import { createLogger, getDb } from "@cramkit/shared";
import { chatCompletion } from "./llm-client.js";

const log = createLogger("api");

interface ExtractedConcept {
	name: string;
	description?: string;
	aliases?: string;
}

interface ConceptLink {
	conceptName: string;
	relationship: string;
	confidence?: number;
	chunkTitle?: string; // optional: which chunk this link applies to
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
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
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

/**
 * Build a structured content string from the chunk tree,
 * providing hierarchy info and node types to the LLM.
 */
function buildStructuredContent(chunks: ChunkInfo[]): string {
	// Build parent-child map
	const childMap = new Map<string | null, ChunkInfo[]>();
	for (const chunk of chunks) {
		const parentId = chunk.parentId;
		if (!childMap.has(parentId)) childMap.set(parentId, []);
		childMap.get(parentId)!.push(chunk);
	}

	const lines: string[] = [];

	function renderNode(chunk: ChunkInfo, indent: number): void {
		const prefix = "  ".repeat(indent);
		const nodeLabel = chunk.nodeType !== "section" ? `[${chunk.nodeType}] ` : "";
		lines.push(`${prefix}${nodeLabel}${chunk.title || "(untitled)"} (depth=${chunk.depth})`);
		if (chunk.content) {
			// Include first 500 chars of content for context
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

	// Start from root nodes (parentId = null)
	const roots = childMap.get(null) || [];
	for (const root of roots) {
		renderNode(root, 0);
	}

	return lines.join("\n");
}

function buildPrompt(
	file: { filename: string; type: string; label: string | null },
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

	return [
		{
			role: "system",
			content: `You are a knowledge graph extraction system. Analyze the provided academic material and extract structured knowledge.
${structuredNote}
Extract the following:
1. **concepts**: Key topics, theorems, definitions, methods, and important ideas. Each concept has: name (Title Case), description (brief), aliases (comma-separated alternative names, optional).
2. **file_concept_links**: How this file relates to each concept. relationship can be: "covers", "introduces", "applies", "references", "proves". Include confidence (0-1).${hasTree ? " Optionally include chunkTitle to specify which section." : ""}
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
			content: `File: ${file.filename}
Type: ${file.type}${file.label ? `\nLabel: ${file.label}` : ""}

Content:
${contentStr.slice(0, 30000)}`,
		},
	];
}

export async function indexFileGraph(fileId: string): Promise<void> {
	const db = getDb();

	const file = await db.file.findUnique({
		where: { id: fileId },
		include: {
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

	if (!file) {
		log.error(`indexFileGraph — file ${fileId} not found`);
		return;
	}

	if (!file.isIndexed) {
		log.warn(`indexFileGraph — file ${fileId} not content-indexed yet, skipping`);
		return;
	}

	log.info(`indexFileGraph — starting "${file.filename}" (${fileId})`);

	const startTime = Date.now();

	const existingConcepts = await db.concept.findMany({
		where: { sessionId: file.sessionId },
		select: { name: true, description: true },
	});

	const messages = buildPrompt(
		{ filename: file.filename, type: file.type, label: file.label },
		file.chunks,
		existingConcepts,
	);

	let result: ExtractionResult;
	try {
		const response = await chatCompletion(messages);
		// Extract JSON from response (handle markdown code blocks)
		const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
		result = JSON.parse(jsonMatch[1]!.trim()) as ExtractionResult;
	} catch (error) {
		log.error(`indexFileGraph — LLM call/parse failed for "${file.filename}"`, error);
		return;
	}

	// Delete existing system-created relationships for this file before re-indexing
	const chunkIds = file.chunks.map((c) => c.id);
	const sourceIds = [fileId, ...chunkIds];
	await db.relationship.deleteMany({
		where: {
			sessionId: file.sessionId,
			createdBy: "system",
			OR: [
				{ sourceId: { in: sourceIds } },
				{ sourceType: "file", sourceId: fileId },
			],
		},
	});

	// Upsert concepts
	for (const concept of result.concepts) {
		const name = toTitleCase(concept.name);
		await db.concept.upsert({
			where: {
				sessionId_name: { sessionId: file.sessionId, name },
			},
			update: {
				description: concept.description || undefined,
				aliases: concept.aliases || undefined,
			},
			create: {
				sessionId: file.sessionId,
				name,
				description: concept.description || null,
				aliases: concept.aliases || null,
				createdBy: "system",
			},
		});
	}

	// Reload concepts to get IDs
	const allConcepts = await db.concept.findMany({
		where: { sessionId: file.sessionId },
		select: { id: true, name: true },
	});
	const conceptMap = new Map(allConcepts.map((c) => [c.name, c.id]));

	// Build chunk lookup by title for targeted relationships
	const chunkByTitle = new Map<string, string>();
	for (const chunk of file.chunks) {
		if (chunk.title) {
			chunkByTitle.set(chunk.title.toLowerCase(), chunk.id);
		}
	}

	// Create file-concept relationships (point to specific chunks when possible)
	for (const link of result.file_concept_links) {
		const conceptName = toTitleCase(link.conceptName);
		const conceptId = conceptMap.get(conceptName);
		if (!conceptId) continue;

		// Try to find the specific chunk this concept is in
		let sourceType = "file";
		let sourceId = fileId;
		let sourceLabel = file.filename;

		if (link.chunkTitle) {
			const chunkId = chunkByTitle.get(link.chunkTitle.toLowerCase());
			if (chunkId) {
				sourceType = "chunk";
				sourceId = chunkId;
				sourceLabel = link.chunkTitle;
			}
		}

		await db.relationship.create({
			data: {
				sessionId: file.sessionId,
				sourceType,
				sourceId,
				sourceLabel,
				targetType: "concept",
				targetId: conceptId,
				targetLabel: conceptName,
				relationship: link.relationship,
				confidence: link.confidence ?? 0.8,
				createdBy: "system",
			},
		});
	}

	// Create concept-concept relationships
	for (const link of result.concept_concept_links) {
		const sourceId = conceptMap.get(toTitleCase(link.sourceConcept));
		const targetId = conceptMap.get(toTitleCase(link.targetConcept));
		if (!sourceId || !targetId) continue;

		await db.relationship.create({
			data: {
				sessionId: file.sessionId,
				sourceType: "concept",
				sourceId,
				sourceLabel: toTitleCase(link.sourceConcept),
				targetType: "concept",
				targetId,
				targetLabel: toTitleCase(link.targetConcept),
				relationship: link.relationship,
				confidence: link.confidence ?? 0.7,
				createdBy: "system",
			},
		});
	}

	// Create question-concept relationships
	for (const link of result.question_concept_links) {
		const conceptName = toTitleCase(link.conceptName);
		const conceptId = conceptMap.get(conceptName);
		if (!conceptId) continue;

		// Find the chunk most relevant to this question
		const matchingChunk = file.chunks.find(
			(c) => c.title?.includes(link.questionLabel) || c.content.includes(link.questionLabel),
		);

		await db.relationship.create({
			data: {
				sessionId: file.sessionId,
				sourceType: matchingChunk ? "chunk" : "file",
				sourceId: matchingChunk?.id || fileId,
				sourceLabel: link.questionLabel,
				targetType: "concept",
				targetId: conceptId,
				targetLabel: conceptName,
				relationship: link.relationship,
				confidence: link.confidence ?? 0.8,
				createdBy: "system",
			},
		});
	}

	// Mark file as graph-indexed with duration
	const graphIndexDurationMs = Date.now() - startTime;
	await db.file.update({
		where: { id: fileId },
		data: { isGraphIndexed: true, graphIndexDurationMs },
	});

	log.info(
		`indexFileGraph — completed "${file.filename}": ${result.concepts.length} concepts, ${result.file_concept_links.length + result.concept_concept_links.length + result.question_concept_links.length} relationships`,
	);
}
