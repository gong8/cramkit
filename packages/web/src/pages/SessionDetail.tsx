import { IndexTab } from "@/components/IndexTab";
import { MaterialsTab } from "@/components/MaterialsTab";
import {
	type IndexStatus,
	cancelIndexing,
	clearSessionGraph,
	exportSession,
	fetchIndexStatus,
	fetchSession,
	indexAllResources,
	indexResource,
	reindexAllResources,
	updateSession,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	Download,
	Loader2,
	MessageSquare,
	Pencil,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

const log = createLogger("web");

type Tab = "materials" | "index";

export function SessionDetail() {
	const { id } = useParams<{ id: string }>();
	const sessionId = id as string;

	const queryClient = useQueryClient();

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => {
			log.info(`SessionDetail — fetching session ${sessionId}`);
			return fetchSession(sessionId);
		},
		enabled: !!sessionId,
	});

	const resources = session?.resources ?? [];

	// Tab state
	const [activeTab, setActiveTab] = useState<Tab>("materials");

	// Session name rename state
	const [isRenamingSession, setIsRenamingSession] = useState(false);
	const [sessionRenameValue, setSessionRenameValue] = useState("");
	const sessionRenameRef = useRef<HTMLInputElement>(null);

	// Collapsible details
	const [detailsOpen, setDetailsOpen] = useState(false);

	// Scope / notes with auto-save
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

	const refetchSession = useQuery({ queryKey: ["session", sessionId], enabled: false }).refetch;

	const startPolling = useCallback(() => {
		pollRef.current = setInterval(async () => {
			try {
				const status = await fetchIndexStatus(sessionId);
				setIndexStatus(status);

				const batch = status.batch;
				const isDone = batch
					? batch.batchCompleted >= batch.batchTotal || batch.cancelled
					: status.inProgress === 0 && status.indexed === status.total;

				if (isDone) {
					if (pollRef.current) clearInterval(pollRef.current);
					pollRef.current = null;
					setIsIndexingAll(false);
					setIndexStatus(null);
					refetchSession();
				}
			} catch (err) {
				log.error("polling index status failed", err);
			}
		}, 2000);
	}, [sessionId, refetchSession]);

	// Restore indexing state on mount
	useEffect(() => {
		let cancelled = false;
		fetchIndexStatus(sessionId)
			.then((status) => {
				if (cancelled) return;
				const batch = status.batch;
				if (batch && !batch.cancelled && batch.batchCompleted < batch.batchTotal) {
					setIndexStatus(status);
					setIsIndexingAll(true);
					startPolling();
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId, startPolling]);

	const startSessionRename = useCallback(() => {
		if (!session) return;
		setSessionRenameValue(session.name);
		setIsRenamingSession(true);
		setTimeout(() => sessionRenameRef.current?.select(), 0);
	}, [session]);

	const commitSessionRename = useCallback(async () => {
		const trimmed = sessionRenameValue.trim();
		setIsRenamingSession(false);
		if (!trimmed || !session || session.name === trimmed) return;
		try {
			await updateSession(sessionId, { name: trimmed });
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error("commitSessionRename — failed", err);
		}
	}, [sessionRenameValue, session, sessionId, queryClient]);

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

	const handleIndexResource = useCallback(
		async (resourceId: string) => {
			log.info(`handleIndexResource — session ${sessionId}, resource ${resourceId}`);
			setIsIndexingAll(true);
			try {
				await indexResource(sessionId, resourceId);
				startPolling();
			} catch (err) {
				log.error("handleIndexResource — failed", err);
				setIsIndexingAll(false);
			}
		},
		[sessionId, startPolling],
	);

	const handleClearGraph = useCallback(async () => {
		await clearSessionGraph(sessionId);
		refetchSession();
	}, [sessionId, refetchSession]);

	const [isExporting, setIsExporting] = useState(false);

	const handleExport = useCallback(async () => {
		log.info(`handleExport — session ${sessionId}`);
		setIsExporting(true);
		try {
			await exportSession(sessionId);
		} catch (err) {
			log.error("handleExport — failed", err);
		} finally {
			setIsExporting(false);
		}
	}, [sessionId]);

	const batch = indexStatus?.batch;

	if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
	if (!session) return <p className="text-muted-foreground">Session not found.</p>;

	const examDateFormatted = session.examDate
		? new Date(session.examDate).toLocaleDateString("en-GB", {
				day: "numeric",
				month: "short",
			})
		: null;

	return (
		<div className="mx-auto max-w-3xl">
			{/* Session header */}
			<div className="mb-4 flex items-center justify-between">
				<div className="flex min-w-0 items-center gap-3">
					<Link
						to="/"
						className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ArrowLeft className="h-4 w-4" />
					</Link>
					{isRenamingSession ? (
						<input
							ref={sessionRenameRef}
							type="text"
							value={sessionRenameValue}
							onChange={(e) => setSessionRenameValue(e.target.value)}
							onBlur={() => commitSessionRename()}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitSessionRename();
								if (e.key === "Escape") setIsRenamingSession(false);
							}}
							className="min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-lg font-semibold outline-none focus:ring-1 focus:ring-ring"
						/>
					) : (
						<button
							type="button"
							onClick={startSessionRename}
							className="group flex min-w-0 items-center gap-1.5"
						>
							<h1 className="truncate text-lg font-semibold">{session.name}</h1>
							<Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
						</button>
					)}
					{session.module && (
						<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
							{session.module}
						</span>
					)}
					{examDateFormatted && (
						<span className="shrink-0 text-sm text-muted-foreground">{examDateFormatted}</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onClick={handleExport}
						disabled={isExporting}
						className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
					>
						{isExporting ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Download className="h-4 w-4" />
						)}
						Export
					</button>
					<Link
						to={`/session/${sessionId}/chat`}
						className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
					>
						<MessageSquare className="h-4 w-4" />
						Chat
					</Link>
				</div>
			</div>

			{/* Collapsible session details */}
			<div className="mb-6 rounded-lg border border-border">
				<button
					type="button"
					onClick={() => setDetailsOpen((v) => !v)}
					className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent/50"
				>
					{detailsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
					Session Details
				</button>
				{detailsOpen && (
					<div className="space-y-4 border-t border-border px-4 py-4">
						<div>
							<label
								htmlFor="scope"
								className="mb-1 block text-xs font-semibold uppercase text-muted-foreground"
							>
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
							<label
								htmlFor="notes"
								className="mb-1 block text-xs font-semibold uppercase text-muted-foreground"
							>
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
				)}
			</div>

			{/* Segmented control */}
			<div className="mb-6 flex justify-center">
				<div className="inline-flex rounded-lg border border-border bg-muted/50 p-1">
					<button
						type="button"
						onClick={() => setActiveTab("materials")}
						className={`rounded-md px-5 py-1.5 text-sm font-medium transition-colors ${
							activeTab === "materials"
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Materials
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("index")}
						className={`rounded-md px-5 py-1.5 text-sm font-medium transition-colors ${
							activeTab === "index"
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Index
					</button>
				</div>
			</div>

			{/* Tab content */}
			{activeTab === "materials" && (
				<MaterialsTab
					resources={resources}
					sessionId={sessionId}
					batchResources={batch?.resources ?? null}
					onIndexResource={handleIndexResource}
				/>
			)}
			{activeTab === "index" && (
				<IndexTab
					sessionId={sessionId}
					resources={resources}
					isIndexingAll={isIndexingAll}
					indexStatus={indexStatus}
					onIndexAll={handleIndexAll}
					onReindexAll={handleReindexAll}
					onCancel={handleCancel}
					onClearGraph={handleClearGraph}
				/>
			)}
		</div>
	);
}
