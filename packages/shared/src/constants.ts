import type { FileRole, ResourceType } from "./types.js";

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	PROBLEM_SHEET: "Problem Sheet",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

export const FILE_ROLE_LABELS: Record<FileRole, string> = {
	PRIMARY: "Primary",
	MARK_SCHEME: "Mark Scheme",
	SOLUTIONS: "Solutions",
	SUPPLEMENT: "Supplement",
};

export const PROCESSING_STATUS_LABELS: Record<string, string> = {
	uploading: "Uploading",
	converting: "Converting",
	indexing: "Indexing",
	ready: "Ready",
	error: "Error",
};
