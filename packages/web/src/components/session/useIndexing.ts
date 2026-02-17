import {
	type IndexStatus,
	cancelIndexing,
	clearSessionGraph,
	fetchIndexStatus,
	indexAllResources,
	indexResource,
	reindexAllResources,
	retryFailedIndexing,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useCallback, useEffect, useRef, useState } from "react";

const log = createLogger("web");

export function useIndexing(sessionId: string, refetchSession: () => void) {
	const [isIndexingAll, setIsIndexingAll] = useState(false);
	const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
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
				const isDone = batch
					? batch.batchCompleted + (batch.batchFailed ?? 0) >= batch.batchTotal || batch.cancelled
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

	useEffect(() => {
		let cancelled = false;
		fetchIndexStatus(sessionId)
			.then((status) => {
				if (cancelled) return;
				const batch = status.batch;
				if (
					batch &&
					!batch.cancelled &&
					batch.batchCompleted + (batch.batchFailed ?? 0) < batch.batchTotal
				) {
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

	const withPolling = useCallback(
		async (action: () => Promise<unknown>) => {
			setIsIndexingAll(true);
			setIndexStatus(null);
			try {
				await action();
				startPolling();
			} catch (err) {
				log.error("indexing action failed", err);
				setIsIndexingAll(false);
			}
		},
		[startPolling],
	);

	const handleIndexAll = useCallback(
		() => withPolling(() => indexAllResources(sessionId)),
		[sessionId, withPolling],
	);

	const handleReindexAll = useCallback(
		() => withPolling(() => reindexAllResources(sessionId)),
		[sessionId, withPolling],
	);

	const handleRetryFailed = useCallback(
		() => withPolling(() => retryFailedIndexing(sessionId)),
		[sessionId, withPolling],
	);

	const handleIndexResource = useCallback(
		(resourceId: string) => withPolling(() => indexResource(sessionId, resourceId)),
		[sessionId, withPolling],
	);

	const handleCancel = useCallback(async () => {
		try {
			await cancelIndexing(sessionId);
		} catch (err) {
			log.error("handleCancel — failed", err);
		}
	}, [sessionId]);

	const handleClearGraph = useCallback(async () => {
		await clearSessionGraph(sessionId);
		refetchSession();
	}, [sessionId, refetchSession]);

	return {
		isIndexingAll,
		indexStatus,
		handleIndexAll,
		handleReindexAll,
		handleRetryFailed,
		handleIndexResource,
		handleCancel,
		handleClearGraph,
	};
}
