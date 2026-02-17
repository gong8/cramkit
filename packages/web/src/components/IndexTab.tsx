import { ConfirmModal } from "@/components/ConfirmModal";
import { BatchFailuresSection, IndexProgressSection } from "@/components/IndexTabParts";
import type { IndexStatus, Resource } from "@/lib/api";
import { BrainCircuit, Network, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

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
			<StatusOverview
				graphIndexedCount={graphIndexedCount}
				indexedCount={indexedCount}
				allGraphIndexed={allGraphIndexed}
			/>

			<ActionButtons
				isIndexingAll={isIndexingAll}
				hasUnindexedResources={hasUnindexedResources}
				allGraphIndexed={allGraphIndexed}
				hasIndexedResources={hasIndexedResources}
				batchHasFailures={batchHasFailures}
				batchFailed={batchFailed}
				onCancel={onCancel}
				onIndexAll={onIndexAll}
				onReindexAll={onReindexAll}
				onRetryFailed={onRetryFailed}
			/>

			{isIndexingAll && (
				<IndexProgressSection indexStatus={indexStatus} batchFailed={batchFailed} />
			)}

			{!isIndexingAll && batch?.resources && batchHasFailures && (
				<BatchFailuresSection resources={batch.resources} failedCount={batchFailed} />
			)}

			<KnowledgeGraphSection
				sessionId={sessionId}
				hasIndexedResources={hasIndexedResources}
				onClearGraph={() => setShowClearGraphModal(true)}
			/>

			{showClearGraphModal && (
				<ConfirmModal
					title="Clear Knowledge Graph"
					description="This will permanently delete all concepts and relationships for this session."
					secondaryDescription="Resources and their content will not be affected. You can re-index afterwards."
					confirmLabel="Clear Graph"
					isLoading={isClearingGraph}
					onConfirm={handleClearGraph}
					onCancel={() => setShowClearGraphModal(false)}
				/>
			)}
		</div>
	);
}

function StatusOverview({
	graphIndexedCount,
	indexedCount,
	allGraphIndexed,
}: {
	graphIndexedCount: number;
	indexedCount: number;
	allGraphIndexed: boolean;
}) {
	return (
		<div className="rounded-lg border border-border p-4">
			<div className="flex items-center justify-between">
				<div>
					<p className="text-sm font-medium">
						{graphIndexedCount} of {indexedCount} resources graph-indexed
					</p>
					{indexedCount === 0 && (
						<p className="mt-1 text-xs text-muted-foreground">Upload and process resources first</p>
					)}
				</div>
				{indexedCount > 0 && (
					<div
						className={`h-2.5 w-2.5 rounded-full ${
							allGraphIndexed ? "bg-green-500" : "bg-amber-400"
						}`}
					/>
				)}
			</div>
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
	);
}

function ActionButtons({
	isIndexingAll,
	hasUnindexedResources,
	allGraphIndexed,
	hasIndexedResources,
	batchHasFailures,
	batchFailed,
	onCancel,
	onIndexAll,
	onReindexAll,
	onRetryFailed,
}: {
	isIndexingAll: boolean;
	hasUnindexedResources: boolean;
	allGraphIndexed: boolean;
	hasIndexedResources: boolean;
	batchHasFailures: boolean;
	batchFailed: number;
	onCancel: () => void;
	onIndexAll: () => void;
	onReindexAll: () => void;
	onRetryFailed: () => void;
}) {
	return (
		<div className="flex flex-wrap gap-2">
			{isIndexingAll && (
				<ActionButton
					onClick={onCancel}
					className="bg-destructive/10 text-destructive hover:bg-destructive/20"
					icon={<X className="h-4 w-4" />}
					label="Cancel"
				/>
			)}
			{!isIndexingAll && hasUnindexedResources && (
				<ActionButton
					onClick={onIndexAll}
					className="bg-primary text-primary-foreground hover:bg-primary/90"
					icon={<BrainCircuit className="h-4 w-4" />}
					label="Index All"
				/>
			)}
			{!isIndexingAll && !hasUnindexedResources && allGraphIndexed && hasIndexedResources && (
				<ActionButton
					onClick={onReindexAll}
					className="bg-violet-500/10 text-violet-600 hover:bg-violet-500/20"
					icon={<RefreshCw className="h-4 w-4" />}
					label="Reindex All"
				/>
			)}
			{!isIndexingAll && batchHasFailures && (
				<ActionButton
					onClick={onRetryFailed}
					className="bg-destructive/10 text-destructive hover:bg-destructive/20"
					icon={<RefreshCw className="h-4 w-4" />}
					label={`Retry Failed (${batchFailed})`}
				/>
			)}
		</div>
	);
}

function ActionButton({
	onClick,
	className,
	icon,
	label,
}: {
	onClick: () => void;
	className: string;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium ${className}`}
		>
			{icon}
			{label}
		</button>
	);
}

function KnowledgeGraphSection({
	sessionId,
	hasIndexedResources,
	onClearGraph,
}: {
	sessionId: string;
	hasIndexedResources: boolean;
	onClearGraph: () => void;
}) {
	return (
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
						onClick={onClearGraph}
						className="flex items-center gap-2 rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
					>
						<Trash2 className="h-4 w-4" />
						Clear Graph
					</button>
				)}
			</div>
		</div>
	);
}
