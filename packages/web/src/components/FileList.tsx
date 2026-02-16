import { deleteFile, fetchFileLinks, indexFile, type FileItem } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Link2, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

const log = createLogger("web");

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
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	MARK_SCHEME: "Mark Scheme",
	PROBLEM_SHEET: "Problem Sheet",
	PROBLEM_SHEET_SOLUTIONS: "Solutions",
	PAST_PAPER_WITH_MARK_SCHEME: "Paper + MS",
	PROBLEM_SHEET_WITH_SOLUTIONS: "Sheet + Solutions",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

interface FileListProps {
	files: FileItem[];
	sessionId: string;
}

export function FileList({ files, sessionId }: FileListProps) {
	const queryClient = useQueryClient();
	const [indexingFiles, setIndexingFiles] = useState<Set<string>>(new Set());

	const { data: fileLinks } = useQuery({
		queryKey: ["file-links", sessionId],
		queryFn: () => fetchFileLinks(sessionId),
		enabled: !!sessionId,
	});

	const handleDelete = async (fileId: string) => {
		log.info(`handleDelete — deleting file ${fileId}`);
		try {
			await deleteFile(fileId);
			log.info(`handleDelete — deleted file ${fileId}`);
			queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
			queryClient.invalidateQueries({ queryKey: ["file-links", sessionId] });
		} catch (err) {
			log.error(`handleDelete — failed to delete file ${fileId}`, err);
		}
	};

	const handleIndex = async (fileId: string) => {
		log.info(`handleIndex — indexing file ${fileId}`);
		setIndexingFiles((prev) => new Set(prev).add(fileId));
		try {
			await indexFile(sessionId, fileId);
			log.info(`handleIndex — queued file ${fileId}`);
			// Poll for completion
			const poll = setInterval(async () => {
				const files = await queryClient.fetchQuery({
					queryKey: ["session-files", sessionId],
					staleTime: 0,
				}) as FileItem[];
				const file = files.find((f) => f.id === fileId);
				if (file?.isGraphIndexed) {
					clearInterval(poll);
					setIndexingFiles((prev) => {
						const next = new Set(prev);
						next.delete(fileId);
						return next;
					});
					queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
				}
			}, 2000);
		} catch (err) {
			log.error(`handleIndex — failed to index file ${fileId}`, err);
			setIndexingFiles((prev) => {
				const next = new Set(prev);
				next.delete(fileId);
				return next;
			});
		}
	};

	if (files.length === 0) {
		return <p className="text-sm text-muted-foreground">No files uploaded yet.</p>;
	}

	// Build link map: sourceId -> target files
	const linkMap = new Map<string, Array<{ targetId: string; relationship: string }>>();
	if (fileLinks) {
		for (const link of fileLinks) {
			if (!linkMap.has(link.sourceId)) linkMap.set(link.sourceId, []);
			linkMap.get(link.sourceId)!.push({ targetId: link.targetId, relationship: link.relationship });
		}
	}

	// Track which files are linked as targets (to group them with their primary)
	const linkedTargetIds = new Set(fileLinks?.map((l) => l.targetId) || []);

	return (
		<div className="space-y-2">
			{files.map((file) => {
				// Skip files that are shown as linked targets of another file
				if (linkedTargetIds.has(file.id)) return null;

				const links = linkMap.get(file.id) || [];
				const linkedFiles = links
					.map((l) => {
						const target = files.find((f) => f.id === l.targetId);
						return target ? { ...target, relationship: l.relationship } : null;
					})
					.filter(Boolean) as Array<FileItem & { relationship: string }>;

				return (
					<div key={file.id}>
						<div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
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
								{file.isIndexed && !file.isGraphIndexed && !indexingFiles.has(file.id) && (
									<button
										onClick={() => handleIndex(file.id)}
										className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
										title="Index for knowledge graph"
									>
										<BrainCircuit className="h-3.5 w-3.5" />
										Index
									</button>
								)}
								{indexingFiles.has(file.id) && (
									<span className="text-xs text-amber-600">Indexing...</span>
								)}
								{file.isGraphIndexed && !indexingFiles.has(file.id) && (
									<>
										<span className="text-xs text-violet-600">Indexed</span>
										<button
											onClick={() => handleIndex(file.id)}
											className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-violet-500/10 hover:text-violet-600"
											title="Reindex for knowledge graph"
										>
											<RefreshCw className="h-3 w-3" />
											Reindex
										</button>
									</>
								)}
								<button
									onClick={() => handleDelete(file.id)}
									className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</div>
						</div>
						{/* Show linked files */}
						{linkedFiles.map((linked) => (
							<div
								key={linked.id}
								className="ml-6 mt-1 flex items-center justify-between rounded-md border border-border/50 bg-muted/30 px-3 py-1.5"
							>
								<div className="flex items-center gap-2">
									<Link2 className="h-3 w-3 text-muted-foreground" />
									<span
										className={`rounded-full px-2 py-0.5 text-xs font-medium ${
											TYPE_COLORS[linked.type] || TYPE_COLORS.OTHER
										}`}
									>
										{TYPE_LABELS[linked.type] || linked.type}
									</span>
									<span className="text-sm text-muted-foreground">{linked.label || linked.filename}</span>
								</div>
								<button
									onClick={() => handleDelete(linked.id)}
									className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
							</div>
						))}
					</div>
				);
			})}
		</div>
	);
}
