import type { FileType } from "./types.js";

export const FILE_TYPE_LABELS: Record<FileType, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	MARK_SCHEME: "Mark Scheme",
	PROBLEM_SHEET: "Problem Sheet",
	PROBLEM_SHEET_SOLUTIONS: "Problem Sheet Solutions",
	PAST_PAPER_WITH_MARK_SCHEME: "Past Paper + Mark Scheme",
	PROBLEM_SHEET_WITH_SOLUTIONS: "Problem Sheet + Solutions",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

export const PROCESSING_STATUS_LABELS: Record<string, string> = {
	uploading: "Uploading",
	converting: "Converting",
	indexing: "Indexing",
	ready: "Ready",
	error: "Error",
};
