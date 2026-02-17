import { ResourceList } from "@/components/ResourceList";
import { ResourceUpload } from "@/components/ResourceUpload";
import { FileViewer } from "@/components/FileViewer";
import {
	cancelIndexing,
	clearSessionGraph,
	fetchIndexStatus,
	fetchSession,
	indexAllResources,
	indexResource,
	reindexAllResources,
	updateSession,
	type BatchResource,
	type IndexStatus,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BrainCircuit, Check, Circle, Loader2, MessageSquare, Network, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

const log = createLogger("web");

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

	const remaining = batch.batchTotal - batch.batchCompleted;
	if (remaining <= 0) return null;

	// Prefer historical avg if available
	if (status.avgDurationMs) {
		const etaSeconds = (remaining * status.avgDurationMs) / 1000;
		return formatEta(etaSeconds);
	}

	// Fallback: elapsed / completed ratio
	const elapsed = Date.now() - batch.startedAt;
	const msPerResource = elapsed / batch.batchCompleted;
	const etaSeconds = (remaining * msPerResource) / 1000;
	return formatEta(etaSeconds);
}

export function SessionDetail() {
	const { id } = useParams<{ id: string }>();

	const sessionId = id as string;

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => {
			log.info(`SessionDetail — fetching session ${sessionId}`);
			return fetchSession(sessionId);
		},
		enabled: !!sessionId,
	});

	const resources = session?.resources ?? [];

	const [scope, setScope] = useState("");
	const [notes, setNotes] = useState("");
	const initialized = useRef(false);

	// Index All state
	const [isIndexingAll, setIsIndexingAll] = useState(false);
	const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		if (session && !initialized.current) {
			setScope(session.scope ?? "");
			setNotes(session.notes ?? "");
			initialized.current = true;
		}
	}, [session]);

	useEffect(() => {
		if (!initialized.current) return;
		const timer = setTimeout(() => {
			updateSession(sessionId, { scope: scope || null, notes: notes || null });
		}, 800);
		return () => clearTimeout(timer);
	}, [scope, notes, sessionId]);

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	const queryClient = useQuery({ queryKey: ["session", sessionId], enabled: false }).refetch;

	const startPolling = useCallback(() => {
		pollRef.current = setInterval(async () => {
			try {
				const status = await fetchIndexStatus(sessionId);
				setIndexStatus(status);

				const batch = status.batch;
				const isDone =
					batch
						? batch.batchCompleted >= batch.batchTotal || batch.cancelled
						: status.inProgress === 0 && status.indexed === status.total;

				if (isDone) {
					if (pollRef.current) clearInterval(pollRef.current);
					pollRef.current = null;
					setIsIndexingAll(false);
					setIndexStatus(null);
					queryClient();
				}
			} catch (err) {
				log.error("polling index status failed", err);
			}
		}, 2000);
	}, [sessionId, queryClient]);

	// Restore indexing state on mount (e.g. after page navigation)
	useEffect(() => {
		let cancelled = false;
		fetchIndexStatus(sessionId).then((status) => {
			if (cancelled) return;
			const batch = status.batch;
			if (batch && !batch.cancelled && batch.batchCompleted < batch.batchTotal) {
				setIndexStatus(status);
				setIsIndexingAll(true);
				startPolling();
			}
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [sessionId, startPolling]);

	const handleIndexAll = useCallback(async () => {
		log.info(`handleIndexAll — session ${sessionId}`);
		setIsIndexingAll(true);
		setIndexStatus(null);
		try {
			await indexAllResources(sessionId);
			startPolling();
		} catch (err) {
			log.error("handleIndexAll — failed", err);
			setIsIndexingAll(false);
		}
	}, [sessionId, startPolling]);

	const handleReindexAll = useCallback(async () => {
		log.info(`handleReindexAll — session ${sessionId}`);
		setIsIndexingAll(true);
		setIndexStatus(null);
		try {
			await reindexAllResources(sessionId);
			startPolling();
		} catch (err) {
			log.error("handleReindexAll — failed", err);
			setIsIndexingAll(false);
		}
	}, [sessionId, startPolling]);

	const handleCancel = useCallback(async () => {
		log.info(`handleCancel — session ${sessionId}`);
		try {
			await cancelIndexing(sessionId);
		} catch (err) {
			log.error("handleCancel — failed", err);
		}
	}, [sessionId]);

	const handleIndexResource = useCallback(async (resourceId: string) => {
		log.info(`handleIndexResource — session ${sessionId}, resource ${resourceId}`);
		setIsIndexingAll(true);
		try {
			await indexResource(sessionId, resourceId);
			startPolling();
		} catch (err) {
			log.error("handleIndexResource — failed", err);
			setIsIndexingAll(false);
		}
	}, [sessionId, startPolling]);

	const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
	const [showClearGraphModal, setShowClearGraphModal] = useState(false);
	const [isClearingGraph, setIsClearingGraph] = useState(false);

	const handleClearGraph = useCallback(async () => {
		setIsClearingGraph(true);
		try {
			await clearSessionGraph(sessionId);
			setShowClearGraphModal(false);
			queryClient();
		} catch (err) {
			log.error("handleClearGraph — failed", err);
		} finally {
			setIsClearingGraph(false);
		}
	}, [sessionId, queryClient]);

	const hasUnindexedResources = resources.some((r) => r.isIndexed && !r.isGraphIndexed);
	const allGraphIndexed =
		resources.length > 0 && resources.every((r) => !r.isIndexed || r.isGraphIndexed);
	const hasIndexedResources = resources.some((r) => r.isIndexed);

	// Progress bar values
	const batch = indexStatus?.batch;
	const progressPercent = batch && batch.batchTotal > 0
		? Math.round((batch.batchCompleted / batch.batchTotal) * 100)
		: 0;
	const etaText = indexStatus ? computeEta(indexStatus) : null;

	if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
	if (!session) return <p className="text-muted-foreground">Session not found.</p>;

	return (
		<div className="flex gap-6">
			{/* Resource viewer — first column */}
			<div className="hidden w-80 shrink-0 lg:block">
				<div className="sticky top-0 h-[calc(100vh-7rem)] overflow-hidden rounded-lg border border-border">
					<FileViewer
						resources={resources}
						selectedResourceId={selectedResourceId}
						onSelectResource={setSelectedResourceId}
					/>
				</div>
			</div>

			{/* Session detail — main column */}
			<div className="min-w-0 flex-1">
				<div className="mb-6">
					<h1 className="text-2xl font-bold">{session.name}</h1>
					{session.module && <p className="mt-1 text-muted-foreground">{session.module}</p>}
					{session.examDate && (
						<p className="mt-1 text-sm text-muted-foreground">
							Exam: {new Date(session.examDate).toLocaleDateString()}
						</p>
					)}
				</div>

				<div className="mb-6 space-y-4">
					<div>
						<label htmlFor="scope" className="mb-1 block text-sm font-semibold uppercase text-muted-foreground">
							Exam Scope
						</label>
						<textarea
							id="scope"
							value={scope}
							onChange={(e) => setScope(e.target.value)}
							placeholder="Describe what's covered in the exam..."
							rows={3}
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</div>
					<div>
						<label htmlFor="notes" className="mb-1 block text-sm font-semibold uppercase text-muted-foreground">
							Notes
						</label>
						<textarea
							id="notes"
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							placeholder="Any additional notes..."
							rows={3}
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</div>
				</div>

				<div className="mb-6 flex gap-3">
					<Link
						to={`/session/${sessionId}/graph`}
						className="flex flex-1 items-center gap-2 rounded-md border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent"
					>
						<Network className="h-4 w-4" />
						Knowledge Graph
					</Link>
					<Link
						to={`/session/${sessionId}/chat`}
						className="flex flex-1 items-center gap-2 rounded-md border border-border px-4 py-3 text-sm font-medium text-foreground hover:bg-accent"
					>
						<MessageSquare className="h-4 w-4" />
						Chat
					</Link>
					{hasIndexedResources && (
						<button
							onClick={() => setShowClearGraphModal(true)}
							className="flex items-center gap-2 rounded-md border border-destructive/30 px-4 py-3 text-sm font-medium text-destructive hover:bg-destructive/10"
						>
							<Trash2 className="h-4 w-4" />
							Clear Graph
						</button>
					)}
				</div>

				<div className="mb-6">
					<div className="mb-3 flex items-center justify-between">
						<h2 className="text-lg font-semibold">Resources</h2>
						<div className="flex items-center gap-2">
							{isIndexingAll && (
								<button
									onClick={handleCancel}
									className="flex items-center gap-1 rounded-md bg-destructive/10 px-2.5 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/20"
									title="Cancel indexing"
								>
									<X className="h-4 w-4" />
									Cancel
								</button>
							)}
							{!isIndexingAll && hasUnindexedResources && (
								<button
									onClick={handleIndexAll}
									className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20"
								>
									<BrainCircuit className="h-4 w-4" />
									Index All
								</button>
							)}
							{!isIndexingAll && !hasUnindexedResources && allGraphIndexed && hasIndexedResources && (
								<button
									onClick={handleReindexAll}
									className="flex items-center gap-1.5 rounded-md bg-violet-500/10 px-3 py-1.5 text-sm font-medium text-violet-600 hover:bg-violet-500/20"
								>
									<RefreshCw className="h-4 w-4" />
									Reindex All
								</button>
							)}
						</div>
					</div>

					{isIndexingAll && (
						<div className="mb-3 space-y-2">
							{/* Progress bar */}
							<div className="h-2 w-full overflow-hidden rounded-full bg-primary/10">
								<div
									className="h-full rounded-full bg-primary transition-all duration-500"
									style={{ width: `${progressPercent}%` }}
								/>
							</div>
							<div className="flex items-center justify-between text-xs text-muted-foreground">
								<span>
									{batch
										? `${batch.batchCompleted}/${batch.batchTotal} resources`
										: "Starting..."}
								</span>
								<span>{etaText ?? "Estimating..."}</span>
							</div>

							{/* Per-resource queue list */}
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

											<span className="min-w-0 flex-1 truncate">{r.name}</span>

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

					<ResourceUpload sessionId={sessionId} existingResources={resources} />
					<ResourceList
						resources={resources}
						sessionId={sessionId}
						batchResources={batch?.resources ?? null}
						onIndexResource={handleIndexResource}
					/>
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
								onClick={() => setShowClearGraphModal(false)}
								disabled={isClearingGraph}
								className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
							>
								Cancel
							</button>
							<button
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
