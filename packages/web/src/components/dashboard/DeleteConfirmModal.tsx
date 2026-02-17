import { AlertTriangle, Loader2 } from "lucide-react";

interface DeleteConfirmModalProps {
	targetName: string;
	isDeleting: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function DeleteConfirmModal({
	targetName,
	isDeleting,
	onConfirm,
	onCancel,
}: DeleteConfirmModalProps) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg">
				<div className="mb-4 flex items-center gap-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
						<AlertTriangle className="h-5 w-5 text-destructive" />
					</div>
					<h3 className="text-lg font-semibold">Delete Session</h3>
				</div>
				<p className="mb-1 text-sm text-muted-foreground">
					This will permanently delete <strong className="text-foreground">{targetName}</strong> and
					all its resources, files, and index data.
				</p>
				<p className="mb-6 text-sm text-muted-foreground">This action cannot be undone.</p>
				<div className="flex justify-end gap-3">
					<button
						type="button"
						onClick={onCancel}
						disabled={isDeleting}
						className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={isDeleting}
						className="flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
					>
						{isDeleting && <Loader2 className="h-4 w-4 animate-spin" />}
						Delete Session
					</button>
				</div>
			</div>
		</div>
	);
}
