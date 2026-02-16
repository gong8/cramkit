import { FileList } from "@/components/FileList";
import { FileUpload } from "@/components/FileUpload";
import { fetchIndexStatus, fetchSession, fetchSessionFiles, indexAllFiles, updateSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery } from "@tanstack/react-query";
import { BrainCircuit } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

const log = createLogger("web");

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
	const [indexProgress, setIndexProgress] = useState<{ total: number; indexed: number } | null>(null);
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

	const handleIndexAll = useCallback(async () => {
		log.info(`handleIndexAll — session ${sessionId}`);
		setIsIndexingAll(true);
		try {
			await indexAllFiles(sessionId);

			pollRef.current = setInterval(async () => {
				try {
					const status = await fetchIndexStatus(sessionId);
					setIndexProgress({ total: status.total, indexed: status.indexed });

					if (status.inProgress === 0 && status.indexed === status.total) {
						if (pollRef.current) clearInterval(pollRef.current);
						pollRef.current = null;
						setIsIndexingAll(false);
						setIndexProgress(null);
						refetchFiles();
					}
				} catch (err) {
					log.error("handleIndexAll — poll failed", err);
				}
			}, 2000);
		} catch (err) {
			log.error("handleIndexAll — failed", err);
			setIsIndexingAll(false);
		}
	}, [sessionId, refetchFiles]);

	const hasUnindexedFiles = files?.some((f) => f.isIndexed && !f.isGraphIndexed) ?? false;

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

			<div className="mb-6">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-lg font-semibold">Files</h2>
					{hasUnindexedFiles && (
						<button
							onClick={handleIndexAll}
							disabled={isIndexingAll}
							className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
						>
							<BrainCircuit className="h-4 w-4" />
							{isIndexingAll
								? indexProgress
									? `Indexing ${indexProgress.indexed}/${indexProgress.total} files...`
									: "Starting..."
								: "Index All"}
						</button>
					)}
				</div>
				<FileUpload sessionId={sessionId} />
				<FileList files={files || []} sessionId={sessionId} />
			</div>
		</div>
	);
}
