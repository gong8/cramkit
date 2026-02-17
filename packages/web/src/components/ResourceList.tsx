import {
	type BatchResource,
	type Resource,
	deleteResource,
	fetchResourceContent,
	removeFileFromResource,
	updateResource,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	BrainCircuit,
	ChevronDown,
	ChevronRight,
	FileText,
	Pencil,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

function ResourceContent({ resourceId }: { resourceId: string }) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["resource-content", resourceId],
		queryFn: () => fetchResourceContent(resourceId),
		enabled: !!resourceId,
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<p className="text-sm text-muted-foreground">Loading content...</p>
			</div>
		);
	}

	if (error || !data) {
		return (
			<div className="flex items-center justify-center py-8">
				<p className="text-sm text-muted-foreground">
					{error ? "Failed to load content" : "Content not found"}
				</p>
			</div>
		);
	}

	return (
		<div className="prose prose-sm max-w-none p-4">
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
		</div>
	);
}

interface ResourceListProps {
	resources: Resource[];
	sessionId: string;
	batchResources: BatchResource[] | null;
	onIndexResource: (resourceId: string) => void;
}

export function ResourceList({
	resources,
	sessionId,
	batchResources,
	onIndexResource,
}: ResourceListProps) {
	const queryClient = useQueryClient();
	const [expandedResourceId, setExpandedResourceId] = useState<string | null>(null);
	const [editingResourceId, setEditingResourceId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	const batchStatusMap = new Map<string, BatchResource["status"]>();
	if (batchResources) {
		for (const br of batchResources) {
			batchStatusMap.set(br.id, br.status);
		}
	}

	const handleDeleteResource = async (resourceId: string) => {
		log.info(`handleDeleteResource — ${resourceId}`);
		try {
			await deleteResource(resourceId);
			log.info(`handleDeleteResource — deleted ${resourceId}`);
			if (expandedResourceId === resourceId) setExpandedResourceId(null);
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error("handleDeleteResource — failed", err);
		}
	};

	const handleRemoveFile = async (resourceId: string, fileId: string) => {
		log.info(`handleRemoveFile — resource=${resourceId}, file=${fileId}`);
		try {
			await removeFileFromResource(resourceId, fileId);
			log.info(`handleRemoveFile — removed file ${fileId}`);
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error("handleRemoveFile — failed", err);
		}
	};

	const startRename = (resource: Resource) => {
		setEditingResourceId(resource.id);
		setEditName(resource.name);
		setTimeout(() => editInputRef.current?.select(), 0);
	};

	const commitRename = async (resourceId: string) => {
		const trimmed = editName.trim();
		setEditingResourceId(null);
		if (!trimmed) return;
		const resource = resources.find((r) => r.id === resourceId);
		if (!resource || resource.name === trimmed) return;
		try {
			await updateResource(resourceId, { name: trimmed });
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error("commitRename — failed", err);
		}
	};

	const toggleExpand = (resourceId: string) => {
		setExpandedResourceId((prev) => (prev === resourceId ? null : resourceId));
	};

	return (
		<div className="space-y-3">
			{resources.map((resource) => {
				const batchStatus = batchStatusMap.get(resource.id);
				const isBusy = batchStatus === "pending" || batchStatus === "indexing";
				const isExpanded = expandedResourceId === resource.id;
				const canExpand = resource.isIndexed;

				return (
					<div key={resource.id} className="rounded-md border border-border">
						{/* Resource header */}
						<div
							className={`flex items-center justify-between px-3 py-2 ${
								canExpand ? "cursor-pointer hover:bg-accent/50" : ""
							}`}
							role={canExpand ? "button" : undefined}
							tabIndex={canExpand ? 0 : undefined}
							onClick={canExpand ? () => toggleExpand(resource.id) : undefined}
							onKeyDown={
								canExpand
									? (e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												toggleExpand(resource.id);
											}
										}
									: undefined
							}
						>
							<div className="flex items-center gap-3">
								{canExpand &&
									(isExpanded ? (
										<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
									) : (
										<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
									))}
								<span
									className={`rounded-full px-2 py-0.5 text-xs font-medium ${
										TYPE_COLORS[resource.type] || TYPE_COLORS.OTHER
									}`}
								>
									{TYPE_LABELS[resource.type] || resource.type}
								</span>
								{editingResourceId === resource.id ? (
									<input
										ref={editInputRef}
										type="text"
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										onBlur={() => commitRename(resource.id)}
										onKeyDown={(e) => {
											if (e.key === "Enter") commitRename(resource.id);
											if (e.key === "Escape") setEditingResourceId(null);
										}}
										onClick={(e) => e.stopPropagation()}
										className="rounded border border-input bg-background px-1.5 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
									/>
								) : (
									<span
										className="text-sm font-medium"
										onDoubleClick={(e) => {
											e.stopPropagation();
											startRename(resource);
										}}
									>
										{resource.name}
									</span>
								)}
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
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only, not interactive */}
							<div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
								<span
									className={`text-xs ${resource.isIndexed ? "text-green-600" : "text-muted-foreground"}`}
								>
									{resource.isIndexed ? "Ready" : "Processing"}
								</span>
								{batchStatus === "indexing" && (
									<span className="text-xs text-amber-600">Indexing...</span>
								)}
								{batchStatus === "pending" && (
									<span className="text-xs text-muted-foreground">Queued</span>
								)}
								{resource.isIndexed && !resource.isGraphIndexed && !isBusy && (
									<button
										type="button"
										onClick={() => onIndexResource(resource.id)}
										className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
										title="Index for knowledge graph"
									>
										<BrainCircuit className="h-3.5 w-3.5" />
										Index
									</button>
								)}
								{resource.isGraphIndexed && !isBusy && (
									<>
										<span className="text-xs text-violet-600">Indexed</span>
										<button
											type="button"
											onClick={() => onIndexResource(resource.id)}
											className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-violet-500/10 hover:text-violet-600"
											title="Reindex for knowledge graph"
										>
											<RefreshCw className="h-3 w-3" />
											Reindex
										</button>
									</>
								)}
								<button
									type="button"
									onClick={() => startRename(resource)}
									className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
									title="Rename resource"
								>
									<Pencil className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									onClick={() => handleDeleteResource(resource.id)}
									className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</div>
						</div>

						{/* Files within resource */}
						{resource.files.length > 0 && !isExpanded && (
							<div className="border-t border-border/50 bg-muted/20">
								{resource.files.map((file) => (
									<div
										key={file.id}
										className="flex items-center justify-between px-3 py-1.5 text-sm"
									>
										<div className="flex items-center gap-2">
											<FileText className="h-3.5 w-3.5 text-muted-foreground" />
											<a
												href={`/api/resources/${resource.id}/files/${file.id}/raw`}
												target="_blank"
												rel="noopener noreferrer"
												className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
											>
												{file.filename}
											</a>
											{file.role !== "PRIMARY" && (
												<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
													{ROLE_LABELS[file.role] || file.role}
												</span>
											)}
										</div>
										{resource.files.length > 1 && (
											<button
												type="button"
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

						{/* Expanded content view */}
						{isExpanded && (
							<div className="max-h-96 overflow-y-auto border-t border-border">
								<ResourceContent resourceId={resource.id} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
