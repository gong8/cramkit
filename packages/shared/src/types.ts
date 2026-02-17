import type { z } from "zod";
import type { exportManifestSchema, resourceExportSchema } from "./schemas.js";

export const ResourceType = {
	LECTURE_NOTES: "LECTURE_NOTES",
	PAST_PAPER: "PAST_PAPER",
	PROBLEM_SHEET: "PROBLEM_SHEET",
	SPECIFICATION: "SPECIFICATION",
	OTHER: "OTHER",
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

export const FileRole = {
	PRIMARY: "PRIMARY",
	MARK_SCHEME: "MARK_SCHEME",
	SOLUTIONS: "SOLUTIONS",
	SUPPLEMENT: "SUPPLEMENT",
} as const;

export type FileRole = (typeof FileRole)[keyof typeof FileRole];

export type ProcessingStatus = "uploading" | "converting" | "indexing" | "ready" | "error";

export interface SessionSummary {
	id: string;
	name: string;
	module: string | null;
	examDate: Date | null;
	resourceCount: number;
	scope: string | null;
}

export interface ResourceSummary {
	id: string;
	name: string;
	type: ResourceType;
	label: string | null;
	isIndexed: boolean;
	isGraphIndexed: boolean;
	fileCount: number;
}

export interface ChunkSummary {
	id: string;
	title: string | null;
	keywords: string | null;
	startPage: number | null;
	endPage: number | null;
}

// --- Import/Export types ---

export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ResourceExport = z.infer<typeof resourceExportSchema>;

export interface ImportStats {
	sessionId: string;
	resourceCount: number;
	fileCount: number;
	chunkCount: number;
	conceptCount: number;
	relationshipCount: number;
	conversationCount: number;
	messageCount: number;
	attachmentCount: number;
}
