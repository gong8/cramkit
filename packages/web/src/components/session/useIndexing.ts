import {
	type BatchStatus,
	type GraphThoroughness,
	type IndexStatus,
	cancelIndexing,
	clearSessionGraph,
	fetchIndexStatus,
	indexAllResources,
	reindexAllResources,
	retryFailedIndexing,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

const log = createLogger("web");

export function useIndexing(sessionId: string) {
	const queryClient = useQueryClient();
	const [isIndexingAll, setIsIndexingAll] = useState(false);
	const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
	const [lastCompletedBatch, setLastCompletedBatch] = useState<BatchStatus | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
				const jobsDone = batch
					? batch.batchCompleted + (batch.batchFailed ?? 0) >= batch.batchTotal
					: true;
				const phase3Done = batch?.phase
					? batch.phase.phase3.status !== "pending" && batch.phase.phase3.status !== "running"
					: true;
				const phase4Done = batch?.phase
					? batch.phase.phase4.status !== "pending" && batch.phase.phase4.status !== "running"
					: true;
				const phase5Done = batch?.phase
					? batch.phase.phase5.status !== "pending" && batch.phase.phase5.status !== "running"
					: true;
				const isDone = batch
					? (jobsDone && phase3Done && phase4Done && phase5Done) || batch.cancelled
					: status.inProgress === 0 && status.indexed === status.total;

				if (isDone) {
					if (pollRef.current) clearInterval(pollRef.current);
					pollRef.current = null;
					setIsIndexingAll(false);
					if (batch) setLastCompletedBatch(batch);
					setIndexStatus(null);
					queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
				}
			} catch (err) {
				log.error("polling index status failed", err);
			}
		}, 2000);
	}, [sessionId, queryClient]);

	useEffect(() => {
		let cancelled = false;
		fetchIndexStatus(sessionId)
			.then((status) => {
				if (cancelled) return;
				const batch = status.batch;
				const allJobsDone =
					batch && batch.batchCompleted + (batch.batchFailed ?? 0) >= batch.batchTotal;
				const crossLinkActive =
					batch?.phase?.phase3.status === "running" || batch?.phase?.phase3.status === "pending";
				const cleanupActive =
					batch?.phase?.phase4.status === "running" || batch?.phase?.phase4.status === "pending";
				const metadataActive =
					batch?.phase?.phase5.status === "running" || batch?.phase?.phase5.status === "pending";
				if (
					batch &&
					!batch.cancelled &&
					(!allJobsDone || crossLinkActive || cleanupActive || metadataActive)
				) {
					setIndexStatus(status);
					setIsIndexingAll(true);
					startPolling();
				} else if (batch && (batch.batchFailed ?? 0) > 0) {
					// Completed batch with failures — show it so failures are visible on refresh
					setLastCompletedBatch(batch);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId, startPolling]);

	const withPolling = useCallback(
		async (action: () => Promise<unknown>) => {
			setIsIndexingAll(true);
			setIndexStatus(null);
			setLastCompletedBatch(null);
			setActionError(null);
			try {
				await action();
				startPolling();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log.error("indexing action failed", err);
				setActionError(msg);
				setIsIndexingAll(false);
			}
		},
		[startPolling],
	);

	const handleIndexAll = useCallback(
		(thoroughness?: GraphThoroughness) =>
			withPolling(() => indexAllResources(sessionId, thoroughness)),
		[sessionId, withPolling],
	);

	const handleReindexAll = useCallback(
		(thoroughness?: GraphThoroughness) =>
			withPolling(() => reindexAllResources(sessionId, thoroughness)),
		[sessionId, withPolling],
	);

	const handleRetryFailed = useCallback(
		() => withPolling(() => retryFailedIndexing(sessionId)),
		[sessionId, withPolling],
	);

	const handleCancel = useCallback(async () => {
		try {
			await cancelIndexing(sessionId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error("handleCancel — failed", err);
			setActionError(msg);
		}
	}, [sessionId]);

	const handleClearGraph = useCallback(async () => {
		await clearSessionGraph(sessionId);
		queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
	}, [sessionId, queryClient]);

	return {
		isIndexingAll,
		indexStatus,
		lastCompletedBatch,
		dismissLastBatch: useCallback(() => setLastCompletedBatch(null), []),
		actionError,
		clearActionError: useCallback(() => setActionError(null), []),
		handleIndexAll,
		handleReindexAll,
		handleRetryFailed,
		handleCancel,
		handleClearGraph,
	};
}
