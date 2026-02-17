import type { Session } from "@/lib/api";
import { updateSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Loader2, MessageSquare, Pencil } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";

const log = createLogger("web");

interface SessionHeaderProps {
	session: Session;
	sessionId: string;
	examDateFormatted: string | null;
	isExporting: boolean;
	onExport: () => void;
}

export function SessionHeader({
	session,
	sessionId,
	examDateFormatted,
	isExporting,
	onExport,
}: SessionHeaderProps) {
	const queryClient = useQueryClient();
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const startRename = useCallback(() => {
		setRenameValue(session.name);
		setIsRenaming(true);
		setTimeout(() => inputRef.current?.select(), 0);
	}, [session]);

	const commitRename = useCallback(async () => {
		const trimmed = renameValue.trim();
		setIsRenaming(false);
		if (!trimmed || session.name === trimmed) return;
		try {
			await updateSession(sessionId, { name: trimmed });
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
		} catch (err) {
			log.error("commitSessionRename — failed", err);
		}
	}, [renameValue, session, sessionId, queryClient]);

	return (
		<div className="mb-4 flex items-center justify-between">
			<div className="flex min-w-0 items-center gap-3">
				<Link
					to="/"
					className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<ArrowLeft className="h-4 w-4" />
				</Link>
				{isRenaming ? (
					<input
						ref={inputRef}
						type="text"
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						onBlur={() => commitRename()}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") setIsRenaming(false);
						}}
						className="min-w-0 rounded border border-input bg-background px-1.5 py-0.5 text-lg font-semibold outline-none focus:ring-1 focus:ring-ring"
					/>
				) : (
					<button
						type="button"
						onClick={startRename}
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
					onClick={onExport}
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
	);
}
