import { IndexTab } from "@/components/IndexTab";
import { MaterialsTab } from "@/components/MaterialsTab";
import {
	type IndexStatus,
	cancelIndexing,
	clearSessionGraph,
	fetchIndexStatus,
	fetchSession,
	indexAllResources,
	indexResource,
	reindexAllResources,
	updateSession,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

const log = createLogger("web");

type Tab = "materials" | "index";

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

	// Tab state
	const [activeTab, setActiveTab] = useState<Tab>("materials");

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

	const queryClient = useQuery({ queryKey: ["session", sessionId], enabled: false }).refetch;

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
					queryClient();
				}
			} catch (err) {
				log.error("polling index status failed", err);
			}
		}, 2000);
	}, [sessionId, queryClient]);

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
		queryClient();
	}, [sessionId, queryClient]);

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
					<h1 className="truncate text-lg font-semibold">{session.name}</h1>
					{session.module && (
						<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
							{session.module}
						</span>
					)}
					{examDateFormatted && (
						<span className="shrink-0 text-sm text-muted-foreground">{examDateFormatted}</span>
					)}
				</div>
				<Link
					to={`/session/${sessionId}/chat`}
					className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
				>
					<MessageSquare className="h-4 w-4" />
					Chat
				</Link>
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
