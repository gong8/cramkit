import type { z } from "zod";
import { FileRoleEnum, ResourceTypeEnum } from "./schemas.js";
import type { exportManifestSchema, resourceExportSchema } from "./schemas.js";

export const ResourceType = ResourceTypeEnum.enum;
export type ResourceType = z.infer<typeof ResourceTypeEnum>;

export const FileRole = FileRoleEnum.enum;
export type FileRole = z.infer<typeof FileRoleEnum>;

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
