import type { BatchResource, IndexStatus } from "@/lib/api";
import { AlertTriangle, Check, Circle, Loader2, X } from "lucide-react";

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

const STATUS_ICONS: Record<string, React.ReactNode> = {
	completed: <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />,
	indexing: <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />,
	pending: <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />,
	cancelled: <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />,
	failed: <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />,
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

function BatchResourceRow({ resource }: { resource: BatchResource }) {
	return (
		<div
			className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
				resource.status === "cancelled" ? "text-muted-foreground line-through" : ""
			}`}
		>
			{STATUS_ICONS[resource.status]}
			<span className="min-w-0 flex-1 truncate">{resource.name}</span>
			{resource.status === "failed" && resource.errorMessage && (
				<span className="max-w-[200px] truncate text-xs text-destructive">
					{resource.errorMessage}
				</span>
			)}
			<span
				className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
					QUEUE_TYPE_COLORS[resource.type] || QUEUE_TYPE_COLORS.OTHER
				}`}
			>
				{QUEUE_TYPE_LABELS[resource.type] || resource.type}
			</span>
			<span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
				{resource.status === "completed" && resource.durationMs != null
					? `${(resource.durationMs / 1000).toFixed(1)}s`
					: resource.status === "indexing"
						? "..."
						: ""}
			</span>
		</div>
	);
}

interface IndexProgressProps {
	indexStatus: IndexStatus | null;
	batchFailed: number;
}

export function IndexProgressSection({ indexStatus, batchFailed }: IndexProgressProps) {
	const batch = indexStatus?.batch;
	const progressPercent =
		batch && batch.batchTotal > 0
			? Math.round(((batch.batchCompleted + batchFailed) / batch.batchTotal) * 100)
			: 0;
	const etaText = indexStatus ? computeEta(indexStatus) : null;

	return (
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
						<BatchResourceRow key={r.id} resource={r} />
					))}
				</div>
			)}
		</div>
	);
}

export function BatchFailuresSection({
	resources,
	failedCount,
}: {
	resources: BatchResource[];
	failedCount: number;
}) {
	const failed = resources.filter((r) => r.status === "failed");

	return (
		<div className="space-y-2">
			<p className="text-sm font-medium text-destructive">
				{failedCount} resource{failedCount > 1 ? "s" : ""} failed
			</p>
			<div className="rounded-md border border-destructive/30 bg-destructive/5">
				{failed.map((r: BatchResource) => (
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
	);
}
