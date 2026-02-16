const TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-800",
	PAST_PAPER: "bg-amber-100 text-amber-800",
	MARK_SCHEME: "bg-green-100 text-green-800",
	PROBLEM_SHEET: "bg-purple-100 text-purple-800",
	PROBLEM_SHEET_SOLUTIONS: "bg-indigo-100 text-indigo-800",
	SPECIFICATION: "bg-gray-100 text-gray-800",
	OTHER: "bg-gray-100 text-gray-800",
};

const TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	MARK_SCHEME: "Mark Scheme",
	PROBLEM_SHEET: "Problem Sheet",
	PROBLEM_SHEET_SOLUTIONS: "Solutions",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

interface FileItem {
	id: string;
	filename: string;
	type: string;
	label: string | null;
	isIndexed: boolean;
}

interface FileListProps {
	files: FileItem[];
}

export function FileList({ files }: FileListProps) {
	if (files.length === 0) {
		return <p className="text-sm text-muted-foreground">No files uploaded yet.</p>;
	}

	return (
		<div className="space-y-2">
			{files.map((file) => (
				<div
					key={file.id}
					className="flex items-center justify-between rounded-md border border-border px-3 py-2"
				>
					<div className="flex items-center gap-3">
						<span
							className={`rounded-full px-2 py-0.5 text-xs font-medium ${
								TYPE_COLORS[file.type] || TYPE_COLORS.OTHER
							}`}
						>
							{TYPE_LABELS[file.type] || file.type}
						</span>
						<span className="text-sm">{file.label || file.filename}</span>
					</div>
					<span
						className={`text-xs ${file.isIndexed ? "text-green-600" : "text-muted-foreground"}`}
					>
						{file.isIndexed ? "Ready" : "Processing"}
					</span>
				</div>
			))}
		</div>
	);
}
