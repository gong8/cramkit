import { ConfirmModal } from "@/components/ConfirmModal.js";
import { formatDuration } from "@/components/IndexTabParts.js";
import type { BatchStatus, GraphThoroughness } from "@/lib/api";
import {
	AlertTriangle,
	BrainCircuit,
	Check,
	Network,
	RefreshCw,
	Trash2,
	X,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

export function ErrorBanner({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
			<XCircle className="h-4 w-4 shrink-0" />
			<span className="flex-1">{message}</span>
			<button type="button" onClick={onDismiss} className="rounded p-0.5 hover:bg-destructive/10">
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

export function StatusOverview({
	graphIndexedCount,
	indexedCount,
	allGraphIndexed,
}: {
	graphIndexedCount: number;
	indexedCount: number;
	allGraphIndexed: boolean;
}) {
	const progressPct = indexedCount > 0 ? Math.round((graphIndexedCount / indexedCount) * 100) : 0;

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
						className={`h-2.5 w-2.5 rounded-full ${allGraphIndexed ? "bg-green-500" : "bg-amber-400"}`}
					/>
				)}
			</div>
			{indexedCount > 0 && (
				<div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-primary transition-all duration-300"
						style={{ width: `${progressPct}%` }}
					/>
				</div>
			)}
		</div>
	);
}

const THOROUGHNESS_OPTIONS: Array<{
	value: GraphThoroughness;
	label: string;
	description: string;
}> = [
	{ value: "quick", label: "Quick", description: "Faster, key concepts only" },
	{ value: "standard", label: "Standard", description: "Balanced extraction" },
	{ value: "thorough", label: "Thorough", description: "Multi-pass, full detail" },
];

export function ThoroughnessSelector({
	value,
	onChange,
}: {
	value: GraphThoroughness;
	onChange: (v: GraphThoroughness) => void;
}) {
	return (
		<div className="space-y-2">
			<span className="text-sm font-medium text-muted-foreground">Thoroughness</span>
			<div className="flex gap-1 rounded-lg border border-border p-1">
				{THOROUGHNESS_OPTIONS.map((opt) => (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						className={`flex-1 rounded-md px-3 py-1.5 text-center text-sm transition-colors ${
							value === opt.value
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-accent hover:text-foreground"
						}`}
					>
						<div className="font-medium">{opt.label}</div>
						<div
							className={`text-[11px] ${value === opt.value ? "text-primary-foreground/70" : "text-muted-foreground"}`}
						>
							{opt.description}
						</div>
					</button>
				))}
			</div>
		</div>
	);
}

export interface ActionButtonProps {
	onClick: () => void;
	className: string;
	icon: React.ReactNode;
	label: string;
}

export function ActionButton({ onClick, className, icon, label }: ActionButtonProps) {
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

export function CompletionBanner({
	batch,
	onDismiss,
}: {
	batch: BatchStatus;
	onDismiss: () => void;
}) {
	const elapsed = batch.startedAt ? Date.now() - batch.startedAt : 0;
	const succeeded = batch.batchCompleted;
	const failed = batch.batchFailed ?? 0;
	const total = batch.batchTotal;

	let style: string;
	let icon: React.ReactNode;
	let message: string;

	if (batch.cancelled) {
		style = "border-border bg-muted/50 text-muted-foreground";
		icon = <X className="h-4 w-4 shrink-0" />;
		message = `Indexing cancelled \u2014 ${succeeded} of ${total} completed`;
	} else if (failed > 0 && succeeded === 0) {
		style = "border-destructive/30 bg-destructive/5 text-destructive";
		icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
		message = `Indexing failed \u2014 all ${total} resource${total !== 1 ? "s" : ""} failed`;
	} else if (failed > 0) {
		style = "border-amber-200 bg-amber-50 text-amber-700";
		icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
		message = `Indexing complete \u2014 ${succeeded} indexed, ${failed} failed`;
	} else {
		style = "border-green-200 bg-green-50 text-green-700";
		icon = <Check className="h-4 w-4 shrink-0" />;
		message = `Indexing complete \u2014 ${succeeded} resource${succeeded !== 1 ? "s" : ""} indexed`;
	}

	return (
		<div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${style}`}>
			{icon}
			<span className="flex-1">
				{message}
				{elapsed > 0 && ` (${formatDuration(elapsed)})`}
			</span>
			<button
				type="button"
				onClick={onDismiss}
				className="rounded p-0.5 opacity-60 hover:opacity-100"
			>
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

export function KnowledgeGraphSection({
	sessionId,
	hasIndexed,
	onClearGraph,
}: {
	sessionId: string;
	hasIndexed: boolean;
	onClearGraph: () => Promise<void>;
}) {
	const [showClearGraphModal, setShowClearGraphModal] = useState(false);
	const [isClearingGraph, setIsClearingGraph] = useState(false);

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
				{hasIndexed && (
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

export function buildActionButtons({
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
}: {
	isIndexingAll: boolean;
	hasUnindexed: boolean;
	allGraphIndexed: boolean;
	hasIndexed: boolean;
	hasBatchFailures: boolean;
	thoroughness: GraphThoroughness;
	lastCompletedBatch: BatchStatus | null;
	onIndexAll: (t?: GraphThoroughness) => void;
	onReindexAll: (t?: GraphThoroughness) => void;
	onCancel: () => void;
	onRetryFailed: () => void;
}): ActionButtonProps[] {
	return [
		isIndexingAll && {
			onClick: onCancel,
			className: "bg-destructive/10 text-destructive hover:bg-destructive/20",
			icon: <X className="h-4 w-4" />,
			label: "Cancel",
		},
		!isIndexingAll &&
			hasUnindexed && {
				onClick: () => onIndexAll(thoroughness),
				className: "bg-primary text-primary-foreground hover:bg-primary/90",
				icon: <BrainCircuit className="h-4 w-4" />,
				label: "Index All",
			},
		!isIndexingAll &&
			!hasUnindexed &&
			allGraphIndexed &&
			hasIndexed && {
				onClick: () => onReindexAll(thoroughness),
				className: "bg-violet-500/10 text-violet-600 hover:bg-violet-500/20",
				icon: <RefreshCw className="h-4 w-4" />,
				label: "Reindex All",
			},
		!isIndexingAll &&
			hasBatchFailures && {
				onClick: onRetryFailed,
				className: "bg-destructive/10 text-destructive hover:bg-destructive/20",
				icon: <RefreshCw className="h-4 w-4" />,
				label: `Retry Failed (${lastCompletedBatch?.batchFailed})`,
			},
	].filter(Boolean) as ActionButtonProps[];
}
