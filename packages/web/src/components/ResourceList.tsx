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
import { ROLE_LABELS, TypeBadge } from "./resource-utils.js";

const log = createLogger("web");

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

function IndexStatus({
	resource,
	isBusy,
	onIndex,
}: {
	resource: Resource;
	isBusy: boolean;
	onIndex: () => void;
}) {
	if (resource.isGraphIndexed && !isBusy) {
		return (
			<>
				<span className="text-xs text-violet-600">Indexed</span>
				<button
					type="button"
					onClick={onIndex}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-violet-500/10 hover:text-violet-600"
					title="Reindex for knowledge graph"
				>
					<RefreshCw className="h-3 w-3" />
					Reindex
				</button>
			</>
		);
	}

	if (resource.isIndexed && !resource.isGraphIndexed && !isBusy) {
		return (
			<button
				type="button"
				onClick={onIndex}
				className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
				title="Index for knowledge graph"
			>
				<BrainCircuit className="h-3.5 w-3.5" />
				Index
			</button>
		);
	}

	return null;
}

function BatchStatus({ status }: { status?: BatchResource["status"] }) {
	if (status === "indexing") return <span className="text-xs text-amber-600">Indexing...</span>;
	if (status === "pending") return <span className="text-xs text-muted-foreground">Queued</span>;
	return null;
}

function ResourceLabel({ label }: { label?: string | null }) {
	if (label === "includes_mark_scheme") {
		return (
			<span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
				+ Mark Scheme
			</span>
		);
	}
	if (label === "includes_solutions") {
		return (
			<span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
				+ Solutions
			</span>
		);
	}
	return null;
}

function InlineRenameInput({
	value,
	onChange,
	onCommit,
	onCancel,
	inputRef,
}: {
	value: string;
	onChange: (v: string) => void;
	onCommit: () => void;
	onCancel: () => void;
	inputRef: React.RefObject<HTMLInputElement | null>;
}) {
	return (
		<input
			ref={inputRef}
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onBlur={onCommit}
			onKeyDown={(e) => {
				if (e.key === "Enter") onCommit();
				if (e.key === "Escape") onCancel();
			}}
			onClick={(e) => e.stopPropagation()}
			className="rounded border border-input bg-background px-1.5 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
		/>
	);
}

function FileRow({
	file,
	resourceId,
	canRemove,
	onRemove,
}: {
	file: Resource["files"][number];
	resourceId: string;
	canRemove: boolean;
	onRemove: () => void;
}) {
	return (
		<div className="flex items-center justify-between px-3 py-1.5 text-sm">
			<div className="flex items-center gap-2">
				<FileText className="h-3.5 w-3.5 text-muted-foreground" />
				<a
					href={`/api/resources/${resourceId}/files/${file.id}/raw`}
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
			{canRemove && (
				<button
					type="button"
					onClick={onRemove}
					className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
			)}
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
								<TypeBadge type={resource.type} />
								{editingResourceId === resource.id ? (
									<InlineRenameInput
										value={editName}
										onChange={setEditName}
										onCommit={() => commitRename(resource.id)}
										onCancel={() => setEditingResourceId(null)}
										inputRef={editInputRef}
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
								<ResourceLabel label={resource.label} />
							</div>
							<div
								className="flex items-center gap-2"
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => e.stopPropagation()}
							>
								<span
									className={`text-xs ${resource.isIndexed ? "text-green-600" : "text-muted-foreground"}`}
								>
									{resource.isIndexed ? "Ready" : "Processing"}
								</span>
								<BatchStatus status={batchStatus} />
								<IndexStatus
									resource={resource}
									isBusy={isBusy}
									onIndex={() => onIndexResource(resource.id)}
								/>
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

						{resource.files.length > 0 && !isExpanded && (
							<div className="border-t border-border/50 bg-muted/20">
								{resource.files.map((file) => (
									<FileRow
										key={file.id}
										file={file}
										resourceId={resource.id}
										canRemove={resource.files.length > 1}
										onRemove={() => handleRemoveFile(resource.id, file.id)}
									/>
								))}
							</div>
						)}

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
