import { createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const questionsRoutes = new Hono();

// List questions for a resource (hierarchical: parent/child structure)
questionsRoutes.get("/resources/:resourceId/questions", async (c) => {
	const db = getDb();
	const resourceId = c.req.param("resourceId");

	const questions = await db.paperQuestion.findMany({
		where: { resourceId },
		orderBy: { questionNumber: "asc" },
	});

	if (questions.length === 0) {
		log.info(`GET /questions/resources/${resourceId}/questions — no questions found`);
		return c.json([]);
	}

	// Fetch related concepts for all questions
	const questionIds = questions.map((q) => q.id);
	const relationships = await db.relationship.findMany({
		where: {
			sourceType: "question",
			sourceId: { in: questionIds },
		},
		select: {
			sourceId: true,
			targetLabel: true,
			relationship: true,
			confidence: true,
		},
	});

	const relsByQuestion = new Map<
		string,
		Array<{ name: string; relationship: string; confidence: number }>
	>();
	for (const rel of relationships) {
		if (!relsByQuestion.has(rel.sourceId)) relsByQuestion.set(rel.sourceId, []);
		relsByQuestion.get(rel.sourceId)?.push({
			name: rel.targetLabel ?? "",
			relationship: rel.relationship,
			confidence: rel.confidence,
		});
	}

	// Build hierarchical structure
	const enriched = questions.map((q) => ({
		id: q.id,
		questionNumber: q.questionNumber,
		parentNumber: q.parentNumber,
		marks: q.marks,
		questionType: q.questionType,
		commandWords: q.commandWords,
		content: q.content,
		markSchemeText: q.markSchemeText,
		solutionText: q.solutionText,
		metadata: q.metadata ? JSON.parse(q.metadata) : null,
		relatedConcepts: relsByQuestion.get(q.id) ?? [],
	}));

	// Group into parent/child tree (recursive for arbitrary nesting depth)
	const byParent = new Map<string, typeof enriched>();
	for (const q of enriched) {
		if (q.parentNumber) {
			if (!byParent.has(q.parentNumber)) byParent.set(q.parentNumber, []);
			byParent.get(q.parentNumber)?.push(q);
		}
	}

	type QuestionNode = (typeof enriched)[number] & { parts: QuestionNode[] };
	const buildSubtree = (q: (typeof enriched)[number]): QuestionNode => ({
		...q,
		parts: (byParent.get(q.questionNumber) ?? []).map(buildSubtree),
	});

	const topLevel = enriched.filter((q) => !q.parentNumber);
	const tree = topLevel.map(buildSubtree);

	log.info(`GET /questions/resources/${resourceId}/questions — ${questions.length} questions`);
	return c.json(tree);
});

// Get a single question by ID
questionsRoutes.get("/:questionId", async (c) => {
	const db = getDb();
	const questionId = c.req.param("questionId");

	const question = await db.paperQuestion.findUnique({
		where: { id: questionId },
	});

	if (!question) {
		return c.json({ error: "Question not found" }, 404);
	}

	// Fetch related concepts
	const relationships = await db.relationship.findMany({
		where: {
			sourceType: "question",
			sourceId: questionId,
		},
		select: {
			targetLabel: true,
			targetId: true,
			relationship: true,
			confidence: true,
		},
	});

	const result = {
		...question,
		metadata: question.metadata ? JSON.parse(question.metadata) : null,
		relatedConcepts: relationships.map((r) => ({
			conceptId: r.targetId,
			name: r.targetLabel ?? "",
			relationship: r.relationship,
			confidence: r.confidence,
		})),
	};

	log.info(`GET /questions/${questionId} — found Q${question.questionNumber}`);
	return c.json(result);
});

// List all questions across all papers in a session
questionsRoutes.get("/sessions/:sessionId/questions", async (c) => {
	const db = getDb();
	const sessionId = c.req.param("sessionId");

	const questions = await db.paperQuestion.findMany({
		where: { sessionId },
		include: {
			resource: { select: { id: true, name: true, type: true } },
		},
		orderBy: [{ resourceId: "asc" }, { questionNumber: "asc" }],
	});

	// Fetch related concepts for all questions
	const questionIds = questions.map((q) => q.id);
	const relationships =
		questionIds.length > 0
			? await db.relationship.findMany({
					where: {
						sourceType: "question",
						sourceId: { in: questionIds },
					},
					select: {
						sourceId: true,
						targetLabel: true,
						relationship: true,
					},
				})
			: [];

	const relsByQuestion = new Map<string, Array<{ name: string; relationship: string }>>();
	for (const rel of relationships) {
		if (!relsByQuestion.has(rel.sourceId)) relsByQuestion.set(rel.sourceId, []);
		relsByQuestion.get(rel.sourceId)?.push({
			name: rel.targetLabel ?? "",
			relationship: rel.relationship,
		});
	}

	const result = questions.map((q) => ({
		id: q.id,
		resourceId: q.resourceId,
		resourceName: q.resource.name,
		resourceType: q.resource.type,
		questionNumber: q.questionNumber,
		parentNumber: q.parentNumber,
		marks: q.marks,
		questionType: q.questionType,
		commandWords: q.commandWords,
		relatedConcepts: relsByQuestion.get(q.id) ?? [],
	}));

	log.info(`GET /questions/sessions/${sessionId}/questions — ${questions.length} questions`);
	return c.json(result);
});
