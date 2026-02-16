export const FileType = {
	LECTURE_NOTES: "LECTURE_NOTES",
	PAST_PAPER: "PAST_PAPER",
	MARK_SCHEME: "MARK_SCHEME",
	PROBLEM_SHEET: "PROBLEM_SHEET",
	PROBLEM_SHEET_SOLUTIONS: "PROBLEM_SHEET_SOLUTIONS",
	PAST_PAPER_WITH_MARK_SCHEME: "PAST_PAPER_WITH_MARK_SCHEME",
	PROBLEM_SHEET_WITH_SOLUTIONS: "PROBLEM_SHEET_WITH_SOLUTIONS",
	SPECIFICATION: "SPECIFICATION",
	OTHER: "OTHER",
} as const;

export type FileType = (typeof FileType)[keyof typeof FileType];

export type ProcessingStatus = "uploading" | "converting" | "indexing" | "ready" | "error";

export interface SessionSummary {
	id: string;
	name: string;
	module: string | null;
	examDate: Date | null;
	fileCount: number;
	scope: string | null;
}

export interface FileSummary {
	id: string;
	filename: string;
	type: FileType;
	label: string | null;
	isIndexed: boolean;
	processingStatus: ProcessingStatus;
}

export interface ChunkSummary {
	id: string;
	title: string | null;
	keywords: string | null;
	startPage: number | null;
	endPage: number | null;
}
