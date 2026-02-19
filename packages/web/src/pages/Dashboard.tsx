import { DeleteConfirmModal } from "@/components/dashboard/DeleteConfirmModal";
import { SessionCard } from "@/components/dashboard/SessionCard";
import { useSessionImport } from "@/hooks/useSessionImport";
import { deleteSession, fetchSessions, updateSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

const log = createLogger("web");

export function Dashboard() {
	const queryClient = useQueryClient();
	const { data: sessions, isLoading } = useQuery({
		queryKey: ["sessions"],
		queryFn: () => {
			log.info("Dashboard — fetching sessions");
			return fetchSessions();
		},
	});

	const { fileInputRef, isImporting, importError, handleImport, dismissError, triggerFileInput } =
		useSessionImport();

	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	const handleCommitEdit = async (id: string, field: "name" | "module", value: string) => {
		const session = sessions?.find((s) => s.id === id);
		if (!session) return;

		const update =
			field === "name"
				? !value || session.name === value
					? null
					: { name: value }
				: session.module === (value || null)
					? null
					: { module: value || null };

		if (!update) return;
		try {
			await updateSession(id, update);
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
		} catch (err) {
			log.error(`commitEdit ${field} — failed`, err);
		}
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		setIsDeleting(true);
		try {
			await deleteSession(deleteTarget.id);
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			setDeleteTarget(null);
		} catch (err) {
			log.error("handleDelete — failed", err);
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div>
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-2xl font-bold">Sessions</h1>
				<div className="flex items-center gap-2">
					<input
						ref={fileInputRef}
						type="file"
						accept=".zip,.cramkit.zip"
						onChange={handleImport}
						className="hidden"
					/>
					<button
						type="button"
						onClick={triggerFileInput}
						disabled={isImporting}
						className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
					>
						{isImporting ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Upload className="h-4 w-4" />
						)}
						{isImporting ? "Importing..." : "Import"}
					</button>
					<Link
						to="/new"
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
					>
						New Session
					</Link>
				</div>
			</div>

			{importError && (
				<div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					<AlertTriangle className="h-4 w-4 shrink-0" />
					<span>{importError}</span>
					<button type="button" onClick={dismissError} className="ml-auto text-xs hover:underline">
						Dismiss
					</button>
				</div>
			)}

			{isLoading && <p className="text-muted-foreground">Loading...</p>}

			{sessions && sessions.length === 0 && (
				<div className="rounded-lg border border-border p-8 text-center">
					<p className="text-muted-foreground">No sessions yet. Create one to get started.</p>
				</div>
			)}

			<div className="grid gap-4 sm:grid-cols-2">
				{sessions?.map((session) => (
					<SessionCard
						key={session.id}
						session={session}
						onCommitEdit={handleCommitEdit}
						onRequestDelete={(id, name) => setDeleteTarget({ id, name })}
					/>
				))}
			</div>

			{deleteTarget && (
				<DeleteConfirmModal
					targetName={deleteTarget.name}
					isDeleting={isDeleting}
					onConfirm={handleDelete}
					onCancel={() => setDeleteTarget(null)}
				/>
			)}
		</div>
	);
}
