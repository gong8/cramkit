import { z } from "zod";

export const ResourceTypeEnum = z.enum([
	"LECTURE_NOTES",
	"PAST_PAPER",
	"PROBLEM_SHEET",
	"SPECIFICATION",
	"OTHER",
]);

export const FileRoleEnum = z.enum([
	"PRIMARY",
	"MARK_SCHEME",
	"SOLUTIONS",
	"SUPPLEMENT",
]);

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

export const chatStreamRequestSchema = z.object({
	sessionId: z.string(),
	conversationId: z.string(),
	message: z.string().min(1),
});
