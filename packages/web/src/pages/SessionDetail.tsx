import { FileList } from "@/components/FileList";
import { FileUpload } from "@/components/FileUpload";
import {
	cancelIndexing,
	fetchIndexStatus,
	fetchSession,
	fetchSessionFiles,
	indexAllFiles,
	reindexAllFiles,
	updateSession,
	type IndexStatus,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, MessageSquare, Network, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

const log = createLogger("web");

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
	const msPerFile = elapsed / batch.batchCompleted;
	const etaSeconds = (remaining * msPerFile) / 1000;
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

	const { data: files, refetch: refetchFiles } = useQuery({
		queryKey: ["session-files", sessionId],
		queryFn: () => {
			log.info(`SessionDetail — fetching files for session ${sessionId}`);
			return fetchSessionFiles(sessionId);
		},
		enabled: !!sessionId,
	});

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
					refetchFiles();
				}
			} catch (err) {
				log.error("polling index status failed", err);
			}
		}, 2000);
	}, [sessionId, refetchFiles]);

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
			await indexAllFiles(sessionId);
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
			await reindexAllFiles(sessionId);
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

	const hasUnindexedFiles = files?.some((f) => f.isIndexed && !f.isGraphIndexed) ?? false;
	const allGraphIndexed =
		files && files.length > 0 && files.every((f) => !f.isIndexed || f.isGraphIndexed);
	const hasIndexedFiles = files?.some((f) => f.isIndexed) ?? false;

	// Progress bar values
	const batch = indexStatus?.batch;
	const progressPercent = batch && batch.batchTotal > 0
		? Math.round((batch.batchCompleted / batch.batchTotal) * 100)
		: 0;
	const etaText = indexStatus ? computeEta(indexStatus) : null;

	if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
	if (!session) return <p className="text-muted-foreground">Session not found.</p>;

	return (
		<div>
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
			</div>

			<div className="mb-6">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-lg font-semibold">Files</h2>
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
						{!isIndexingAll && hasUnindexedFiles && (
							<button
								onClick={handleIndexAll}
								className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20"
							>
								<BrainCircuit className="h-4 w-4" />
								Index All
							</button>
						)}
						{!isIndexingAll && !hasUnindexedFiles && allGraphIndexed && hasIndexedFiles && (
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
					<div className="mb-3 space-y-1.5">
						<div className="h-2 w-full overflow-hidden rounded-full bg-primary/10">
							<div
								className="h-full rounded-full bg-primary transition-all duration-500"
								style={{ width: `${progressPercent}%` }}
							/>
						</div>
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span>
								{batch
									? `Indexing ${batch.batchCompleted}/${batch.batchTotal} files`
									: "Starting..."}
							</span>
							<span>{etaText ?? "Estimating..."}</span>
						</div>
					</div>
				)}

				<FileUpload sessionId={sessionId} />
				<FileList files={files || []} sessionId={sessionId} />
			</div>
		</div>
	);
}
