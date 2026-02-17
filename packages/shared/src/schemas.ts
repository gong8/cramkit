import { z } from "zod";

const nopt = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();

export const ResourceTypeEnum = z.enum([
	"LECTURE_NOTES",
	"PAST_PAPER",
	"PROBLEM_SHEET",
	"SPECIFICATION",
	"OTHER",
]);

export const FileRoleEnum = z.enum(["PRIMARY", "MARK_SCHEME", "SOLUTIONS", "SUPPLEMENT"]);

export const SplitModeEnum = z.enum(["auto", "split", "single"]);

const sessionOptionalFields = {
	module: nopt(z.string()),
	examDate: nopt(z.string().date()),
	scope: nopt(z.string()),
	notes: nopt(z.string()),
};

export const createSessionSchema = z.object({
	name: z.string().min(1),
	module: z.string().optional(),
	examDate: z.string().date().optional(),
	scope: z.string().optional(),
	notes: z.string().optional(),
});

export const updateSessionSchema = z.object({
	name: z.string().min(1).optional(),
	...sessionOptionalFields,
});

export const createResourceSchema = z.object({
	name: z.string().min(1),
	type: ResourceTypeEnum,
	label: z.string().optional(),
	splitMode: SplitModeEnum.optional().default("auto"),
});

export const updateResourceSchema = z.object({
	name: z.string().min(1).optional(),
	label: nopt(z.string()),
});

const relationshipFields = {
	sourceType: z.string(),
	sourceId: z.string(),
	sourceLabel: nopt(z.string()),
	targetType: z.string(),
	targetId: z.string(),
	targetLabel: nopt(z.string()),
	relationship: z.string(),
};

export const createRelationshipSchema = z.object({
	...relationshipFields,
	sourceLabel: z.string().optional(),
	targetLabel: z.string().optional(),
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
	processedPath: nopt(z.string()),
	pageCount: nopt(z.number().int()),
	fileSize: nopt(z.number().int()),
});

export const chunkExportSchema = z.object({
	id: z.string(),
	sourceFileId: nopt(z.string()),
	parentId: nopt(z.string()),
	index: z.number().int(),
	depth: z.number().int(),
	nodeType: z.string(),
	slug: nopt(z.string()),
	diskPath: nopt(z.string()),
	title: nopt(z.string()),
	content: z.string(),
	startPage: nopt(z.number().int()),
	endPage: nopt(z.number().int()),
	keywords: nopt(z.string()),
});

export const resourceExportSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: ResourceTypeEnum,
	label: nopt(z.string()),
	splitMode: z.string(),
	isIndexed: z.boolean(),
	isGraphIndexed: z.boolean(),
	files: z.array(fileExportSchema),
	chunks: z.array(chunkExportSchema),
});

export const conceptExportSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: nopt(z.string()),
	aliases: nopt(z.string()),
	createdBy: z.string(),
});

export const relationshipExportSchema = z.object({
	id: z.string(),
	...relationshipFields,
	confidence: z.number().min(0).max(1),
	createdBy: z.string(),
});

export const messageExportSchema = z.object({
	id: z.string(),
	role: z.string(),
	content: z.string(),
	toolCalls: nopt(z.string()),
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

const exportStatsSchema = z.object({
	resourceCount: z.number().int(),
	fileCount: z.number().int(),
	chunkCount: z.number().int(),
	conceptCount: z.number().int(),
	relationshipCount: z.number().int(),
	conversationCount: z.number().int(),
	messageCount: z.number().int(),
});

export const exportManifestSchema = z.object({
	version: z.number().int(),
	exportedAt: z.string(),
	session: z.object({
		name: z.string(),
		...sessionOptionalFields,
	}),
	resourceIds: z.array(z.string()),
	conversationIds: z.array(z.string()),
	stats: exportStatsSchema,
});
