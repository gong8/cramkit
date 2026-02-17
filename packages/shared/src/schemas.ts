import { z } from "zod";

export const ResourceTypeEnum = z.enum([
	"LECTURE_NOTES",
	"PAST_PAPER",
	"PROBLEM_SHEET",
	"SPECIFICATION",
	"OTHER",
]);

export const FileRoleEnum = z.enum(["PRIMARY", "MARK_SCHEME", "SOLUTIONS", "SUPPLEMENT"]);

export const SplitModeEnum = z.enum(["auto", "split", "single"]);

export const createSessionSchema = z.object({
	name: z.string().min(1),
	module: z.string().optional(),
	examDate: z.string().date().optional(),
	scope: z.string().optional(),
	notes: z.string().optional(),
});

export const updateSessionSchema = z.object({
	name: z.string().min(1).optional(),
	module: z.string().nullable().optional(),
	examDate: z.string().date().nullable().optional(),
	scope: z.string().nullable().optional(),
	notes: z.string().nullable().optional(),
});

export const createResourceSchema = z.object({
	name: z.string().min(1),
	type: ResourceTypeEnum,
	label: z.string().optional(),
	splitMode: SplitModeEnum.optional().default("auto"),
});

export const updateResourceSchema = z.object({
	name: z.string().min(1).optional(),
	label: z.string().nullable().optional(),
});

export const createRelationshipSchema = z.object({
	sourceType: z.string(),
	sourceId: z.string(),
	sourceLabel: z.string().optional(),
	targetType: z.string(),
	targetId: z.string(),
	targetLabel: z.string().optional(),
	relationship: z.string(),
	confidence: z.number().min(0).max(1).optional(),
});

export const searchQuerySchema = z.object({
	q: z.string().min(1),
	resourceTypes: z.array(ResourceTypeEnum).optional(),
	limit: z.coerce.number().int().positive().max(50).optional().default(10),
});

export const createConceptSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	aliases: z.string().optional(),
	createdBy: z.enum(["system", "claude", "amortised"]).optional(),
});

export const indexResourceRequestSchema = z.object({
	resourceId: z.string(),
});

export const chatStreamRequestSchema = z
	.object({
		sessionId: z.string(),
		conversationId: z.string(),
		message: z.string(),
		attachmentIds: z.array(z.string()).optional(),
		rewindToMessageId: z.string().optional(),
	})
	.refine(
		(data) => data.message.length >= 1 || (data.attachmentIds && data.attachmentIds.length >= 1),
		{
			message: "Either message text or at least one attachment is required",
		},
	);

// --- Import/Export schemas ---

export const fileExportSchema = z.object({
	id: z.string(),
	filename: z.string(),
	role: FileRoleEnum,
	rawPath: z.string(),
	processedPath: z.string().nullable().optional(),
	pageCount: z.number().int().nullable().optional(),
	fileSize: z.number().int().nullable().optional(),
});

export const chunkExportSchema = z.object({
	id: z.string(),
	sourceFileId: z.string().nullable().optional(),
	parentId: z.string().nullable().optional(),
	index: z.number().int(),
	depth: z.number().int(),
	nodeType: z.string(),
	slug: z.string().nullable().optional(),
	diskPath: z.string().nullable().optional(),
	title: z.string().nullable().optional(),
	content: z.string(),
	startPage: z.number().int().nullable().optional(),
	endPage: z.number().int().nullable().optional(),
	keywords: z.string().nullable().optional(),
});

export const resourceExportSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: ResourceTypeEnum,
	label: z.string().nullable().optional(),
	splitMode: z.string(),
	isIndexed: z.boolean(),
	isGraphIndexed: z.boolean(),
	files: z.array(fileExportSchema),
	chunks: z.array(chunkExportSchema),
});

export const conceptExportSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable().optional(),
	aliases: z.string().nullable().optional(),
	createdBy: z.string(),
});

export const relationshipExportSchema = z.object({
	id: z.string(),
	sourceType: z.string(),
	sourceId: z.string(),
	sourceLabel: z.string().nullable().optional(),
	targetType: z.string(),
	targetId: z.string(),
	targetLabel: z.string().nullable().optional(),
	relationship: z.string(),
	confidence: z.number().min(0).max(1),
	createdBy: z.string(),
});

export const messageExportSchema = z.object({
	id: z.string(),
	role: z.string(),
	content: z.string(),
	toolCalls: z.string().nullable().optional(),
	attachments: z
		.array(
			z.object({
				id: z.string(),
				filename: z.string(),
				contentType: z.string(),
				fileSize: z.number().int(),
			}),
		)
		.optional(),
});

export const conversationExportSchema = z.object({
	id: z.string(),
	title: z.string(),
	messages: z.array(messageExportSchema),
});

export const exportManifestSchema = z.object({
	version: z.number().int(),
	exportedAt: z.string(),
	session: z.object({
		name: z.string(),
		module: z.string().nullable().optional(),
		examDate: z.string().nullable().optional(),
		scope: z.string().nullable().optional(),
		notes: z.string().nullable().optional(),
	}),
	resourceIds: z.array(z.string()),
	conversationIds: z.array(z.string()),
	stats: z.object({
		resourceCount: z.number().int(),
		fileCount: z.number().int(),
		chunkCount: z.number().int(),
		conceptCount: z.number().int(),
		relationshipCount: z.number().int(),
		conversationCount: z.number().int(),
		messageCount: z.number().int(),
	}),
});
