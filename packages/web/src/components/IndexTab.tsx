import { BatchFailuresSection, IndexProgressSection } from "@/components/IndexTabParts.js";
import {
	ActionButton,
	CompletionBanner,
	ErrorBanner,
	KnowledgeGraphSection,
	StatusOverview,
	ThoroughnessSelector,
	buildActionButtons,
} from "@/components/IndexTabSections.js";
import type { BatchStatus, GraphThoroughness, IndexStatus, Resource } from "@/lib/api";
import { useState } from "react";

interface IndexTabProps {
	sessionId: string;
	resources: Resource[];
	isIndexingAll: boolean;
	indexStatus: IndexStatus | null;
	lastCompletedBatch: BatchStatus | null;
	onDismissLastBatch: () => void;
	actionError: string | null;
	onClearActionError: () => void;
	defaultThoroughness: GraphThoroughness;
	onIndexAll: (thoroughness?: GraphThoroughness) => void;
	onReindexAll: (thoroughness?: GraphThoroughness) => void;
	onCancel: () => void;
	onClearGraph: () => Promise<void>;
	onRetryFailed: () => void;
}

export function IndexTab({
	sessionId,
	resources,
	isIndexingAll,
	indexStatus,
	lastCompletedBatch,
	onDismissLastBatch,
	actionError,
	onClearActionError,
	defaultThoroughness,
	onIndexAll,
	onReindexAll,
	onCancel,
	onClearGraph,
	onRetryFailed,
}: IndexTabProps) {
	const [thoroughness, setThoroughness] = useState<GraphThoroughness>(defaultThoroughness);
	const indexedCount = resources.filter((r) => r.isIndexed).length;
	const graphIndexedCount = resources.filter((r) => r.isGraphIndexed).length;
	const hasUnindexed = resources.some((r) => r.isIndexed && !r.isGraphIndexed);
	const allGraphIndexed = indexedCount > 0 && !hasUnindexed;
	const hasIndexed = indexedCount > 0;
	const hasBatchFailures = (lastCompletedBatch?.batchFailed ?? 0) > 0;
	const showActions = !isIndexingAll && hasIndexed;

	const actionButtons = buildActionButtons({
		isIndexingAll,
		hasUnindexed,
		allGraphIndexed,
		hasIndexed,
		hasBatchFailures,
		thoroughness,
		lastCompletedBatch,
		onIndexAll,
		onReindexAll,
		onCancel,
		onRetryFailed,
	});

	return (
		<div className="space-y-6">
			{actionError && <ErrorBanner message={actionError} onDismiss={onClearActionError} />}

			<StatusOverview
				graphIndexedCount={graphIndexedCount}
				indexedCount={indexedCount}
				allGraphIndexed={allGraphIndexed}
			/>

			{showActions && <ThoroughnessSelector value={thoroughness} onChange={setThoroughness} />}

			{actionButtons.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{actionButtons.map((btn) => (
						<ActionButton key={btn.label} {...btn} />
					))}
				</div>
			)}

			{isIndexingAll && (
				<IndexProgressSection
					indexStatus={indexStatus}
					batchFailed={indexStatus?.batch?.batchFailed ?? 0}
				/>
			)}

			{!isIndexingAll && lastCompletedBatch && (
				<CompletionBanner batch={lastCompletedBatch} onDismiss={onDismissLastBatch} />
			)}

			{!isIndexingAll && lastCompletedBatch && (lastCompletedBatch.batchFailed ?? 0) > 0 && (
				<BatchFailuresSection
					resources={lastCompletedBatch.resources}
					failedCount={lastCompletedBatch.batchFailed}
				/>
			)}

			<KnowledgeGraphSection
				sessionId={sessionId}
				hasIndexed={hasIndexed}
				onClearGraph={onClearGraph}
			/>
		</div>
	);
}
