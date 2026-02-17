import { IndexTab } from "@/components/IndexTab";
import { MaterialsTab } from "@/components/MaterialsTab";
import { SessionDetailsPanel } from "@/components/session/SessionDetailsPanel";
import { SessionHeader } from "@/components/session/SessionHeader";
import { useAutoSaveDetails } from "@/components/session/useAutoSaveDetails";
import { useIndexing } from "@/components/session/useIndexing";
import { exportSession, fetchSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";

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

	const refetchSession = useQuery({
		queryKey: ["session", sessionId],
		enabled: false,
	}).refetch;

	const resources = session?.resources ?? [];

	const [activeTab, setActiveTab] = useState<Tab>("materials");

	const { scope, setScope, notes, setNotes, examDate, setExamDate } = useAutoSaveDetails(
		sessionId,
		session,
	);

	const {
		isIndexingAll,
		indexStatus,
		handleIndexAll,
		handleReindexAll,
		handleRetryFailed,
		handleIndexResource,
		handleCancel,
		handleClearGraph,
	} = useIndexing(sessionId, refetchSession);

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

	if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
	if (!session) return <p className="text-muted-foreground">Session not found.</p>;

	const examDateFormatted = examDate
		? new Date(`${examDate}T00:00:00`).toLocaleDateString("en-GB", {
				day: "numeric",
				month: "short",
			})
		: null;

	const batch = indexStatus?.batch;

	return (
		<div className="mx-auto max-w-3xl">
			<SessionHeader
				session={session}
				sessionId={sessionId}
				examDateFormatted={examDateFormatted}
				isExporting={isExporting}
				onExport={handleExport}
			/>

			<SessionDetailsPanel
				scope={scope}
				onScopeChange={setScope}
				notes={notes}
				onNotesChange={setNotes}
				examDate={examDate}
				onExamDateChange={setExamDate}
			/>

			{/* Segmented control */}
			<div className="mb-6 flex justify-center">
				<div className="inline-flex rounded-lg border border-border bg-muted/50 p-1">
					{(["materials", "index"] as const).map((tab) => (
						<button
							key={tab}
							type="button"
							onClick={() => setActiveTab(tab)}
							className={`rounded-md px-5 py-1.5 text-sm font-medium capitalize transition-colors ${
								activeTab === tab
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{tab}
						</button>
					))}
				</div>
			</div>

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
					onRetryFailed={handleRetryFailed}
				/>
			)}
		</div>
	);
}
