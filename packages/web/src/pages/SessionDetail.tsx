import { IndexTab } from "@/components/IndexTab.js";
import { MaterialsTab } from "@/components/MaterialsTab.js";
import { SegmentedControl } from "@/components/SegmentedControl.js";
import { SessionDetailsPanel } from "@/components/session/SessionDetailsPanel.js";
import { SessionHeader } from "@/components/session/SessionHeader.js";
import { useAutoSaveDetails } from "@/components/session/useAutoSaveDetails.js";
import { useIndexing } from "@/components/session/useIndexing.js";
import { exportSession, fetchSession } from "@/lib/api.js";
import { createLogger } from "@/lib/logger.js";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";

const log = createLogger("web");

const TABS = ["materials", "index"] as const;
type Tab = (typeof TABS)[number];

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
	} = useIndexing(sessionId);

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

	const batch = indexStatus?.batch;

	return (
		<div className="mx-auto max-w-3xl">
			<SessionHeader
				session={session}
				sessionId={sessionId}
				examDate={examDate}
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

			<SegmentedControl tabs={TABS} active={activeTab} onChange={setActiveTab} />

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
