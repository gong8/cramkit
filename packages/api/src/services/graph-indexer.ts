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

function buildPrompt(
	file: { filename: string; type: string; label: string | null },
	content: string,
	existingConcepts: Array<{ name: string; description: string | null }>,
): Array<{ role: "system" | "user"; content: string }> {
	const existingConceptsList =
		existingConcepts.length > 0
			? `\n\nExisting concepts in this session (reuse exact names where applicable):\n${existingConcepts.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`).join("\n")}`
			: "";

	return [
		{
			role: "system",
			content: `You are a knowledge graph extraction system. Analyze the provided academic material and extract structured knowledge.

Extract the following:
1. **concepts**: Key topics, theorems, definitions, methods, and important ideas. Each concept has: name (Title Case), description (brief), aliases (comma-separated alternative names, optional).
2. **file_concept_links**: How this file relates to each concept. relationship can be: "covers", "introduces", "applies", "references", "proves". Include confidence (0-1).
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
  "file_concept_links": [{ "conceptName": "...", "relationship": "...", "confidence": 0.9 }],
  "concept_concept_links": [{ "sourceConcept": "...", "targetConcept": "...", "relationship": "...", "confidence": 0.8 }],
  "question_concept_links": [{ "questionLabel": "...", "conceptName": "...", "relationship": "...", "confidence": 0.9 }]
}`,
		},
		{
			role: "user",
			content: `File: ${file.filename}
Type: ${file.type}${file.label ? `\nLabel: ${file.label}` : ""}

Content:
${content.slice(0, 30000)}`,
		},
	];
}

export async function indexFileGraph(fileId: string): Promise<void> {
	const db = getDb();

	const file = await db.file.findUnique({
		where: { id: fileId },
		include: {
			chunks: { select: { id: true, content: true, title: true } },
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

	const content = file.chunks
		.map((c) => c.content)
		.join("\n\n")
		.replace(/\0/g, "");
	const messages = buildPrompt(
		{ filename: file.filename, type: file.type, label: file.label },
		content,
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

	// Create file-concept relationships
	for (const link of result.file_concept_links) {
		const conceptName = toTitleCase(link.conceptName);
		const conceptId = conceptMap.get(conceptName);
		if (!conceptId) continue;

		await db.relationship.create({
			data: {
				sessionId: file.sessionId,
				sourceType: "file",
				sourceId: fileId,
				sourceLabel: file.filename,
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
