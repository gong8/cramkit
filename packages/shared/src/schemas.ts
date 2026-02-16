import { z } from "zod";

export const FileTypeEnum = z.enum([
	"LECTURE_NOTES",
	"PAST_PAPER",
	"MARK_SCHEME",
	"PROBLEM_SHEET",
	"PROBLEM_SHEET_SOLUTIONS",
	"SPECIFICATION",
	"OTHER",
]);

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

export const uploadFileMetadataSchema = z.object({
	type: FileTypeEnum,
	label: z.string().optional(),
});

export const updateFileSchema = z.object({
	label: z.string().nullable().optional(),
	type: FileTypeEnum.optional(),
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
	fileTypes: z.array(FileTypeEnum).optional(),
	limit: z.coerce.number().int().positive().max(50).optional().default(10),
});

export const createConceptSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	aliases: z.string().optional(),
	createdBy: z.enum(["system", "claude", "amortised"]).optional(),
});

export const indexFileRequestSchema = z.object({
	fileId: z.string(),
});
