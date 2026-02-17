import { deleteResource, indexResource, removeFileFromResource, type Resource } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, FileText, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

const log = createLogger("web");

const TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-800",
	PAST_PAPER: "bg-amber-100 text-amber-800",
	PROBLEM_SHEET: "bg-purple-100 text-purple-800",
	SPECIFICATION: "bg-gray-100 text-gray-800",
	OTHER: "bg-gray-100 text-gray-800",
};

const TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	PROBLEM_SHEET: "Problem Sheet",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

const ROLE_LABELS: Record<string, string> = {
	PRIMARY: "Primary",
	MARK_SCHEME: "Mark Scheme",
	SOLUTIONS: "Solutions",
	SUPPLEMENT: "Supplement",
};

interface ResourceListProps {
	resources: Resource[];
	sessionId: string;
}

export function ResourceList({ resources, sessionId }: ResourceListProps) {
	const queryClient = useQueryClient();
	const [indexingResources, setIndexingResources] = useState<Set<string>>(new Set());

	const handleDeleteResource = async (resourceId: string) => {
		log.info(`handleDeleteResource — ${resourceId}`);
		try {
			await deleteResource(resourceId);
			log.info(`handleDeleteResource — deleted ${resourceId}`);
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error(`handleDeleteResource — failed`, err);
		}
	};

	const handleRemoveFile = async (resourceId: string, fileId: string) => {
		log.info(`handleRemoveFile — resource=${resourceId}, file=${fileId}`);
		try {
			await removeFileFromResource(resourceId, fileId);
			log.info(`handleRemoveFile — removed file ${fileId}`);
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error(`handleRemoveFile — failed`, err);
		}
	};

	const handleIndex = async (resourceId: string) => {
		log.info(`handleIndex — indexing resource ${resourceId}`);
		setIndexingResources((prev) => new Set(prev).add(resourceId));
		try {
			await indexResource(sessionId, resourceId);
			log.info(`handleIndex — queued resource ${resourceId}`);
			// Poll for completion
			const poll = setInterval(async () => {
				const session = await queryClient.fetchQuery({
					queryKey: ["session", sessionId],
					staleTime: 0,
				}) as { resources?: Resource[] };
				const resource = session.resources?.find((r) => r.id === resourceId);
				if (resource?.isGraphIndexed) {
					clearInterval(poll);
					setIndexingResources((prev) => {
						const next = new Set(prev);
						next.delete(resourceId);
						return next;
					});
					queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
				}
			}, 2000);
		} catch (err) {
			log.error(`handleIndex — failed`, err);
			setIndexingResources((prev) => {
				const next = new Set(prev);
				next.delete(resourceId);
				return next;
			});
		}
	};

	if (resources.length === 0) {
		return <p className="text-sm text-muted-foreground">No resources uploaded yet.</p>;
	}

	return (
		<div className="space-y-3">
			{resources.map((resource) => (
				<div key={resource.id} className="rounded-md border border-border">
					{/* Resource header */}
					<div className="flex items-center justify-between px-3 py-2">
						<div className="flex items-center gap-3">
							<span
								className={`rounded-full px-2 py-0.5 text-xs font-medium ${
									TYPE_COLORS[resource.type] || TYPE_COLORS.OTHER
								}`}
							>
								{TYPE_LABELS[resource.type] || resource.type}
							</span>
							<span className="text-sm font-medium">{resource.name}</span>
							{resource.label === "includes_mark_scheme" && (
								<span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
									+ Mark Scheme
								</span>
							)}
							{resource.label === "includes_solutions" && (
								<span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
									+ Solutions
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							<span
								className={`text-xs ${resource.isIndexed ? "text-green-600" : "text-muted-foreground"}`}
							>
								{resource.isIndexed ? "Ready" : "Processing"}
							</span>
							{resource.isIndexed && !resource.isGraphIndexed && !indexingResources.has(resource.id) && (
								<button
									onClick={() => handleIndex(resource.id)}
									className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
									title="Index for knowledge graph"
								>
									<BrainCircuit className="h-3.5 w-3.5" />
									Index
								</button>
							)}
							{indexingResources.has(resource.id) && (
								<span className="text-xs text-amber-600">Indexing...</span>
							)}
							{resource.isGraphIndexed && !indexingResources.has(resource.id) && (
								<>
									<span className="text-xs text-violet-600">Indexed</span>
									<button
										onClick={() => handleIndex(resource.id)}
										className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-violet-500/10 hover:text-violet-600"
										title="Reindex for knowledge graph"
									>
										<RefreshCw className="h-3 w-3" />
										Reindex
									</button>
								</>
							)}
							<button
								onClick={() => handleDeleteResource(resource.id)}
								className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
							>
								<Trash2 className="h-4 w-4" />
							</button>
						</div>
					</div>

					{/* Files within resource */}
					{resource.files.length > 0 && (
						<div className="border-t border-border/50 bg-muted/20">
							{resource.files.map((file) => (
								<div
									key={file.id}
									className="flex items-center justify-between px-3 py-1.5 text-sm"
								>
									<div className="flex items-center gap-2">
										<FileText className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="text-muted-foreground">{file.filename}</span>
										{file.role !== "PRIMARY" && (
											<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
												{ROLE_LABELS[file.role] || file.role}
											</span>
										)}
									</div>
									{resource.files.length > 1 && (
										<button
											onClick={() => handleRemoveFile(resource.id, file.id)}
											className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
										>
											<Trash2 className="h-3.5 w-3.5" />
										</button>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			))}
		</div>
	);
}
