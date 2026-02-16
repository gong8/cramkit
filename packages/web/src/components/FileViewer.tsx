import { fetchFileDetail, type FileDetail, type FileItem } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileText, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

const TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-800",
	PAST_PAPER: "bg-amber-100 text-amber-800",
	MARK_SCHEME: "bg-green-100 text-green-800",
	PROBLEM_SHEET: "bg-purple-100 text-purple-800",
	PROBLEM_SHEET_SOLUTIONS: "bg-indigo-100 text-indigo-800",
	PAST_PAPER_WITH_MARK_SCHEME: "bg-amber-100 text-amber-800",
	PROBLEM_SHEET_WITH_SOLUTIONS: "bg-purple-100 text-purple-800",
	SPECIFICATION: "bg-gray-100 text-gray-800",
	OTHER: "bg-gray-100 text-gray-800",
};

const TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Notes",
	PAST_PAPER: "Paper",
	MARK_SCHEME: "MS",
	PROBLEM_SHEET: "Sheet",
	PROBLEM_SHEET_SOLUTIONS: "Solutions",
	PAST_PAPER_WITH_MARK_SCHEME: "Paper+MS",
	PROBLEM_SHEET_WITH_SOLUTIONS: "Sheet+Sol",
	SPECIFICATION: "Spec",
	OTHER: "Other",
};

function FileContent({ fileId }: { fileId: string }) {
	const { data: file, isLoading } = useQuery({
		queryKey: ["file-detail", fileId],
		queryFn: () => fetchFileDetail(fileId),
		enabled: !!fileId,
	});

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<p className="text-sm text-muted-foreground">Loading file...</p>
			</div>
		);
	}

	if (!file) {
		return (
			<div className="flex h-full items-center justify-center">
				<p className="text-sm text-muted-foreground">File not found</p>
			</div>
		);
	}

	// Use processedContent if available, otherwise concatenate chunks
	const content =
		file.processedContent ||
		file.chunks.map((c) => c.content).join("\n\n") ||
		"No content available.";

	return (
		<div className="prose prose-sm max-w-none p-4">
			<ReactMarkdown>{content}</ReactMarkdown>
		</div>
	);
}

interface FileViewerProps {
	files: FileItem[];
	selectedFileId: string | null;
	onSelectFile: (fileId: string | null) => void;
}

export function FileViewer({ files, selectedFileId, onSelectFile }: FileViewerProps) {
	const indexedFiles = files.filter((f) => f.isIndexed);

	if (selectedFileId) {
		const file = files.find((f) => f.id === selectedFileId);
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2">
					<button
						onClick={() => onSelectFile(null)}
						className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronLeft className="h-4 w-4" />
					</button>
					<span className="truncate text-sm font-medium">
						{file?.label || file?.filename || "File"}
					</span>
				</div>
				<div className="flex-1 overflow-y-auto">
					<FileContent fileId={selectedFileId} />
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-border px-3 py-2">
				<h3 className="text-sm font-semibold">Files</h3>
			</div>
			<div className="flex-1 overflow-y-auto">
				{indexedFiles.length === 0 ? (
					<p className="p-3 text-sm text-muted-foreground">No files ready to view.</p>
				) : (
					<div className="divide-y divide-border">
						{indexedFiles.map((file) => (
							<button
								key={file.id}
								onClick={() => onSelectFile(file.id)}
								className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent"
							>
								<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm">{file.label || file.filename}</p>
								</div>
								<span
									className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
										TYPE_COLORS[file.type] || TYPE_COLORS.OTHER
									}`}
								>
									{TYPE_LABELS[file.type] || file.type}
								</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
