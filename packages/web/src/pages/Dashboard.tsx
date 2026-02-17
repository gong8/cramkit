import { deleteSession, fetchSessions, importSession, updateSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertTriangle,
	BookOpen,
	Loader2,
	MoreVertical,
	Pencil,
	Trash2,
	Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

const log = createLogger("web");

type EditField = "name" | "module";

export function Dashboard() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { data: sessions, isLoading } = useQuery({
		queryKey: ["sessions"],
		queryFn: () => {
			log.info("Dashboard — fetching sessions");
			return fetchSessions();
		},
	});

	// Dropdown menu state
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// Import state
	const [isImporting, setIsImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Inline edit state (shared for name and module)
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editField, setEditField] = useState<EditField>("name");
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	// Delete confirmation modal state
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Close dropdown on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpenId(null);
			}
		};
		if (menuOpenId) document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [menuOpenId]);

	// Focus edit input when entering edit mode
	useEffect(() => {
		if (editingId) {
			setTimeout(() => editInputRef.current?.select(), 0);
		}
	}, [editingId]);

	const startEdit = (id: string, field: EditField, currentValue: string) => {
		setMenuOpenId(null);
		setEditingId(id);
		setEditField(field);
		setEditValue(currentValue);
	};

	const commitEdit = async (id: string) => {
		const trimmed = editValue.trim();
		const field = editField;
		setEditingId(null);

		const session = sessions?.find((s) => s.id === id);
		if (!session) return;

		if (field === "name") {
			if (!trimmed || session.name === trimmed) return;
			try {
				await updateSession(id, { name: trimmed });
				queryClient.invalidateQueries({ queryKey: ["sessions"] });
			} catch (err) {
				log.error("commitEdit name — failed", err);
			}
		} else {
			const newModule = trimmed || null;
			if (session.module === newModule) return;
			try {
				await updateSession(id, { module: newModule });
				queryClient.invalidateQueries({ queryKey: ["sessions"] });
			} catch (err) {
				log.error("commitEdit module — failed", err);
			}
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

	const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		setIsImporting(true);
		setImportError(null);
		log.info(`handleImport — file: ${file.name}`);
		try {
			const result = await importSession(file);
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			navigate(`/session/${result.sessionId}`);
		} catch (err) {
			log.error("handleImport — failed", err);
			setImportError(err instanceof Error ? err.message : "Import failed");
		} finally {
			setIsImporting(false);
			// Reset file input so the same file can be selected again
			if (fileInputRef.current) fileInputRef.current.value = "";
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
						onClick={() => fileInputRef.current?.click()}
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
					<button
						type="button"
						onClick={() => setImportError(null)}
						className="ml-auto text-xs hover:underline"
					>
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
					<div
						key={session.id}
						className="relative rounded-lg border border-border transition-colors hover:bg-accent"
					>
						<Link to={`/session/${session.id}`} className="block p-4">
							{editingId === session.id && editField === "name" ? (
								<input
									ref={editInputRef}
									type="text"
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onBlur={() => commitEdit(session.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter") commitEdit(session.id);
										if (e.key === "Escape") setEditingId(null);
									}}
									onClick={(e) => e.preventDefault()}
									className="w-full rounded border border-input bg-background px-1.5 py-0.5 font-semibold outline-none focus:ring-1 focus:ring-ring"
								/>
							) : (
								<h2 className="font-semibold">{session.name}</h2>
							)}
							{editingId === session.id && editField === "module" ? (
								<input
									ref={editInputRef}
									type="text"
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onBlur={() => commitEdit(session.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter") commitEdit(session.id);
										if (e.key === "Escape") setEditingId(null);
									}}
									onClick={(e) => e.preventDefault()}
									placeholder="Module code"
									className="mt-1 w-full rounded border border-input bg-background px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
								/>
							) : (
								session.module && (
									<p className="mt-1 text-sm text-muted-foreground">{session.module}</p>
								)
							)}
							<div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
								<span>
									{session.resourceCount} resource{session.resourceCount !== 1 ? "s" : ""}
								</span>
								{session.examDate && (
									<span>Exam: {new Date(session.examDate).toLocaleDateString()}</span>
								)}
							</div>
						</Link>

						{/* More menu button */}
						<div
							className="absolute right-2 top-2"
							ref={menuOpenId === session.id ? menuRef : undefined}
						>
							<button
								type="button"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									setMenuOpenId(menuOpenId === session.id ? null : session.id);
								}}
								className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<MoreVertical className="h-4 w-4" />
							</button>

							{menuOpenId === session.id && (
								<div className="absolute right-0 top-8 z-10 w-44 rounded-md border border-border bg-background py-1 shadow-lg">
									<button
										type="button"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											startEdit(session.id, "name", session.name);
										}}
										className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
									>
										<Pencil className="h-3.5 w-3.5" />
										Rename
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											startEdit(session.id, "module", session.module ?? "");
										}}
										className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
									>
										<BookOpen className="h-3.5 w-3.5" />
										Change Module
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMenuOpenId(null);
											setDeleteTarget({ id: session.id, name: session.name });
										}}
										className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
									>
										<Trash2 className="h-3.5 w-3.5" />
										Delete
									</button>
								</div>
							)}
						</div>
					</div>
				))}
			</div>

			{/* Delete confirmation modal */}
			{deleteTarget && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
						<div className="mb-4 flex items-center gap-3">
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
								<AlertTriangle className="h-5 w-5 text-destructive" />
							</div>
							<h3 className="text-lg font-semibold">Delete Session</h3>
						</div>
						<p className="mb-1 text-sm text-muted-foreground">
							This will permanently delete{" "}
							<strong className="text-foreground">{deleteTarget.name}</strong> and all its
							resources, files, and index data.
						</p>
						<p className="mb-6 text-sm text-muted-foreground">This action cannot be undone.</p>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setDeleteTarget(null)}
								disabled={isDeleting}
								className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleDelete}
								disabled={isDeleting}
								className="flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
							>
								{isDeleting && <Loader2 className="h-4 w-4 animate-spin" />}
								Delete Session
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
