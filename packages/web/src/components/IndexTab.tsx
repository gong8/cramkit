import type { BatchResource, IndexStatus, Resource } from "@/lib/api";
import {
	AlertTriangle,
	BrainCircuit,
	Check,
	Circle,
	Loader2,
	Network,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

const QUEUE_TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Notes",
	PAST_PAPER: "Paper",
	PROBLEM_SHEET: "Sheet",
	SPECIFICATION: "Spec",
	OTHER: "Other",
};

const QUEUE_TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-700",
	PAST_PAPER: "bg-amber-100 text-amber-700",
	PROBLEM_SHEET: "bg-purple-100 text-purple-700",
	SPECIFICATION: "bg-gray-100 text-gray-700",
	OTHER: "bg-gray-100 text-gray-700",
};

function formatEta(seconds: number): string {
	if (seconds < 60) return `~${Math.ceil(seconds)}s remaining`;
	const mins = Math.floor(seconds / 60);
	const secs = Math.ceil(seconds % 60);
	return `~${mins}m ${secs}s remaining`;
}

function computeEta(status: IndexStatus): string | null {
	const batch = status.batch;
	if (!batch || batch.batchCompleted === 0) return null;

	const remaining = batch.batchTotal - batch.batchCompleted - (batch.batchFailed ?? 0);
	if (remaining <= 0) return null;

	if (status.avgDurationMs) {
		const etaSeconds = (remaining * status.avgDurationMs) / 1000;
		return formatEta(etaSeconds);
	}

	const elapsed = Date.now() - batch.startedAt;
	const msPerResource = elapsed / batch.batchCompleted;
	const etaSeconds = (remaining * msPerResource) / 1000;
	return formatEta(etaSeconds);
}

interface IndexTabProps {
	sessionId: string;
	resources: Resource[];
	isIndexingAll: boolean;
	indexStatus: IndexStatus | null;
	onIndexAll: () => void;
	onReindexAll: () => void;
	onCancel: () => void;
	onClearGraph: () => Promise<void>;
	onRetryFailed: () => void;
}

export function IndexTab({
	sessionId,
	resources,
	isIndexingAll,
	indexStatus,
	onIndexAll,
	onReindexAll,
	onCancel,
	onClearGraph,
	onRetryFailed,
}: IndexTabProps) {
	const [showClearGraphModal, setShowClearGraphModal] = useState(false);
	const [isClearingGraph, setIsClearingGraph] = useState(false);

	const graphIndexedCount = resources.filter((r) => r.isGraphIndexed).length;
	const indexedCount = resources.filter((r) => r.isIndexed).length;
	const hasUnindexedResources = resources.some((r) => r.isIndexed && !r.isGraphIndexed);
	const allGraphIndexed =
		resources.length > 0 && resources.every((r) => !r.isIndexed || r.isGraphIndexed);
	const hasIndexedResources = resources.some((r) => r.isIndexed);

	const batch = indexStatus?.batch;
	const batchFailed = batch?.batchFailed ?? 0;
	const batchHasFailures = batchFailed > 0;
	const progressPercent =
		batch && batch.batchTotal > 0
			? Math.round(((batch.batchCompleted + batchFailed) / batch.batchTotal) * 100)
			: 0;
	const etaText = indexStatus ? computeEta(indexStatus) : null;

	const handleClearGraph = async () => {
		setIsClearingGraph(true);
		try {
			await onClearGraph();
			setShowClearGraphModal(false);
		} finally {
			setIsClearingGraph(false);
		}
	};

	return (
		<div className="space-y-6">
			{/* Status overview */}
			<div className="rounded-lg border border-border p-4">
				<div className="flex items-center justify-between">
					<div>
						<p className="text-sm font-medium">
							{graphIndexedCount} of {indexedCount} resources graph-indexed
						</p>
						{indexedCount === 0 && (
							<p className="mt-1 text-xs text-muted-foreground">
								Upload and process resources first
							</p>
						)}
					</div>

					{/* Status indicator */}
					{indexedCount > 0 && (
						<div
							className={`h-2.5 w-2.5 rounded-full ${
								allGraphIndexed ? "bg-green-500" : "bg-amber-400"
							}`}
						/>
					)}
				</div>

				{/* Visual bar */}
				{indexedCount > 0 && (
					<div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary transition-all duration-300"
							style={{
								width: `${Math.round((graphIndexedCount / indexedCount) * 100)}%`,
							}}
						/>
					</div>
				)}
			</div>

			{/* Action buttons */}
			<div className="flex flex-wrap gap-2">
				{isIndexingAll && (
					<button
						type="button"
						onClick={onCancel}
						className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20"
					>
						<X className="h-4 w-4" />
						Cancel
					</button>
				)}
				{!isIndexingAll && hasUnindexedResources && (
					<button
						type="button"
						onClick={onIndexAll}
						className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
					>
						<BrainCircuit className="h-4 w-4" />
						Index All
					</button>
				)}
				{!isIndexingAll && !hasUnindexedResources && allGraphIndexed && hasIndexedResources && (
					<button
						type="button"
						onClick={onReindexAll}
						className="flex items-center gap-1.5 rounded-md bg-violet-500/10 px-3 py-2 text-sm font-medium text-violet-600 hover:bg-violet-500/20"
					>
						<RefreshCw className="h-4 w-4" />
						Reindex All
					</button>
				)}
				{!isIndexingAll && batchHasFailures && (
					<button
						type="button"
						onClick={onRetryFailed}
						className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20"
					>
						<RefreshCw className="h-4 w-4" />
						Retry Failed ({batchFailed})
					</button>
				)}
			</div>

			{/* Progress section */}
			{isIndexingAll && (
				<div className="space-y-2">
					<div className="h-2 w-full overflow-hidden rounded-full bg-primary/10">
						<div
							className="h-full rounded-full bg-primary transition-all duration-500"
							style={{ width: `${progressPercent}%` }}
						/>
					</div>
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>
							{batch ? `${batch.batchCompleted}/${batch.batchTotal} resources` : "Starting..."}
						</span>
						<span>{etaText ?? "Estimating..."}</span>
					</div>

					{batch?.resources && batch.resources.length > 0 && (
						<div className="rounded-md border border-border bg-muted/30">
							{batch.resources.map((r: BatchResource) => (
								<div
									key={r.id}
									className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
										r.status === "cancelled" ? "text-muted-foreground line-through" : ""
									}`}
								>
									{r.status === "completed" && (
										<Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
									)}
									{r.status === "indexing" && (
										<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
									)}
									{r.status === "pending" && (
										<Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
									)}
									{r.status === "cancelled" && (
										<X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
									)}
									{r.status === "failed" && (
										<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
									)}
									<span className="min-w-0 flex-1 truncate">{r.name}</span>
									{r.status === "failed" && r.errorMessage && (
										<span className="max-w-[200px] truncate text-xs text-destructive">
											{r.errorMessage}
										</span>
									)}
									<span
										className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
											QUEUE_TYPE_COLORS[r.type] || QUEUE_TYPE_COLORS.OTHER
										}`}
									>
										{QUEUE_TYPE_LABELS[r.type] || r.type}
									</span>
									<span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
										{r.status === "completed" && r.durationMs != null
											? `${(r.durationMs / 1000).toFixed(1)}s`
											: r.status === "indexing"
												? "..."
												: ""}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Batch failures shown when not actively indexing */}
			{!isIndexingAll && batch?.resources && batchHasFailures && (
				<div className="space-y-2">
					<p className="text-sm font-medium text-destructive">
						{batchFailed} resource{batchFailed > 1 ? "s" : ""} failed
					</p>
					<div className="rounded-md border border-destructive/30 bg-destructive/5">
						{batch.resources
							.filter((r) => r.status === "failed")
							.map((r: BatchResource) => (
								<div key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
									<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
									<span className="min-w-0 flex-1 truncate">{r.name}</span>
									{r.errorMessage && (
										<span className="max-w-[250px] truncate text-xs text-destructive">
											{r.errorMessage}
										</span>
									)}
								</div>
							))}
					</div>
				</div>
			)}

			{/* Knowledge Graph section */}
			<div className="space-y-3">
				<h3 className="text-sm font-semibold uppercase text-muted-foreground">Knowledge Graph</h3>
				<div className="flex gap-2">
					<Link
						to={`/session/${sessionId}/graph`}
						className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
					>
						<Network className="h-4 w-4" />
						View Knowledge Graph
					</Link>
					{hasIndexedResources && (
						<button
							type="button"
							onClick={() => setShowClearGraphModal(true)}
							className="flex items-center gap-2 rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
						>
							<Trash2 className="h-4 w-4" />
							Clear Graph
						</button>
					)}
				</div>
			</div>

			{/* Clear Graph confirmation modal */}
			{showClearGraphModal && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
						<div className="mb-4 flex items-center gap-3">
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
								<AlertTriangle className="h-5 w-5 text-destructive" />
							</div>
							<h3 className="text-lg font-semibold">Clear Knowledge Graph</h3>
						</div>
						<p className="mb-1 text-sm text-muted-foreground">
							This will permanently delete all concepts and relationships for this session.
						</p>
						<p className="mb-6 text-sm text-muted-foreground">
							Resources and their content will not be affected. You can re-index afterwards.
						</p>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setShowClearGraphModal(false)}
								disabled={isClearingGraph}
								className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleClearGraph}
								disabled={isClearingGraph}
								className="flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
							>
								{isClearingGraph && <Loader2 className="h-4 w-4 animate-spin" />}
								Clear Graph
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
