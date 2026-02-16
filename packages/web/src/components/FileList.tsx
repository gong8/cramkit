import { deleteFile } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

const log = createLogger("web");

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
	sessionId: string;
}

export function FileList({ files, sessionId }: FileListProps) {
	const queryClient = useQueryClient();

	const handleDelete = async (fileId: string) => {
		log.info(`handleDelete — deleting file ${fileId}`);
		try {
			await deleteFile(fileId);
			log.info(`handleDelete — deleted file ${fileId}`);
			queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
		} catch (err) {
			log.error(`handleDelete — failed to delete file ${fileId}`, err);
		}
	};

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
					<div className="flex items-center gap-2">
						<span
							className={`text-xs ${file.isIndexed ? "text-green-600" : "text-muted-foreground"}`}
						>
							{file.isIndexed ? "Ready" : "Processing"}
						</span>
						<button
							onClick={() => handleDelete(file.id)}
							className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
						>
							<Trash2 className="h-4 w-4" />
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
