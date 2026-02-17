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

function buildStructuredContent(chunks: ChunkInfo[]): string {
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
${contentStr.slice(0, 30000)}`,
		},
	];
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
		log.error(`indexResourceGraph — resource ${resourceId} not found`);
		return;
	}

	if (!resource.isIndexed) {
		log.warn(`indexResourceGraph — resource ${resourceId} not content-indexed yet, skipping`);
		return;
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

	let result: ExtractionResult;
	try {
		const response = await chatCompletion(messages);
		const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
		result = JSON.parse(jsonMatch[1]!.trim()) as ExtractionResult;
	} catch (error) {
		log.error(`indexResourceGraph — LLM call/parse failed for "${resource.name}"`, error);
		return;
	}

	// All DB writes happen atomically in a single transaction
	await db.$transaction(async (tx) => {
		// Delete existing system-created relationships for this resource before re-indexing
		const chunkIds = resource.chunks.map((c) => c.id);
		const sourceIds = [resourceId, ...chunkIds];
		await tx.relationship.deleteMany({
			where: {
				sessionId: resource.sessionId,
				createdBy: "system",
				OR: [
					{ sourceId: { in: sourceIds } },
					{ sourceType: "resource", sourceId: resourceId },
				],
			},
		});

		// Upsert concepts
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

		// Reload concepts to get IDs
		const allConcepts = await tx.concept.findMany({
			where: { sessionId: resource.sessionId },
			select: { id: true, name: true },
		});
		const conceptMap = new Map(allConcepts.map((c) => [c.name, c.id]));

		// Build chunk lookup by title for targeted relationships
		const chunkByTitle = new Map<string, string>();
		for (const chunk of resource.chunks) {
			if (chunk.title) {
				chunkByTitle.set(chunk.title.toLowerCase(), chunk.id);
			}
		}

		// Batch all relationship creates
		type RelData = Parameters<typeof tx.relationship.create>[0]["data"];
		const relationshipsToCreate: RelData[] = [];

		// Resource-concept relationships (point to specific chunks when possible)
		for (const link of result.file_concept_links) {
			const conceptName = toTitleCase(link.conceptName);
			const conceptId = conceptMap.get(conceptName);
			if (!conceptId) continue;

			let sourceType = "resource";
			let sourceId = resourceId;
			let sourceLabel = resource.name;

			if (link.chunkTitle) {
				const chunkId = chunkByTitle.get(link.chunkTitle.toLowerCase());
				if (chunkId) {
					sourceType = "chunk";
					sourceId = chunkId;
					sourceLabel = link.chunkTitle;
				}
			}

			relationshipsToCreate.push({
				sessionId: resource.sessionId,
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

		// Concept-concept relationships
		for (const link of result.concept_concept_links) {
			const sourceId = conceptMap.get(toTitleCase(link.sourceConcept));
			const targetId = conceptMap.get(toTitleCase(link.targetConcept));
			if (!sourceId || !targetId) continue;

			relationshipsToCreate.push({
				sessionId: resource.sessionId,
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

		// Question-concept relationships
		for (const link of result.question_concept_links) {
			const conceptName = toTitleCase(link.conceptName);
			const conceptId = conceptMap.get(conceptName);
			if (!conceptId) continue;

			const matchingChunk = resource.chunks.find(
				(c) => c.title?.includes(link.questionLabel) || c.content.includes(link.questionLabel),
			);

			relationshipsToCreate.push({
				sessionId: resource.sessionId,
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

		// Batch insert all relationships at once
		if (relationshipsToCreate.length > 0) {
			await tx.relationship.createMany({ data: relationshipsToCreate });
		}

		// Mark resource as graph-indexed with duration
		const graphIndexDurationMs = Date.now() - startTime;
		await tx.resource.update({
			where: { id: resourceId },
			data: { isGraphIndexed: true, graphIndexDurationMs },
		});
	}, { timeout: 30000 });

	log.info(
		`indexResourceGraph — completed "${resource.name}": ${result.concepts.length} concepts, ${result.file_concept_links.length + result.concept_concept_links.length + result.question_concept_links.length} relationships`,
	);
}
