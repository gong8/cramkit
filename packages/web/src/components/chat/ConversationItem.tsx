import type { ConversationSummary } from "@/lib/api";
import { renameConversation } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ConversationItem({
	conv,
	isActive,
	onSelect,
	onDelete,
	sessionId,
}: {
	conv: ConversationSummary;
	isActive: boolean;
	onSelect: () => void;
	onDelete: () => void;
	sessionId: string;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(conv.title);
	const inputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	const renameMutation = useMutation({
		mutationFn: (title: string) => renameConversation(conv.id, title),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			setIsEditing(false);
		},
	});

	useEffect(() => {
		if (isEditing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isEditing]);

	const handleSubmit = () => {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== conv.title) {
			renameMutation.mutate(trimmed);
		} else {
			setIsEditing(false);
			setEditValue(conv.title);
		}
	};

	if (isEditing) {
		return (
			<div className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1">
				<input
					ref={inputRef}
					value={editValue}
					onChange={(e) => setEditValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSubmit();
						if (e.key === "Escape") {
							setIsEditing(false);
							setEditValue(conv.title);
						}
					}}
					onBlur={handleSubmit}
					className="flex-1 bg-transparent text-sm outline-none min-w-0"
				/>
				<button
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
				>
					<Check className="h-3 w-3" />
				</button>
				<button
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						setIsEditing(false);
						setEditValue(conv.title);
					}}
					className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
				>
					<X className="h-3 w-3" />
				</button>
			</div>
		);
	}

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
				isActive ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50"
			}`}
		>
			<MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span className="flex-1 truncate">{conv.title}</span>
			<span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						setEditValue(conv.title);
						setIsEditing(true);
					}}
					className="rounded p-0.5 text-muted-foreground hover:text-foreground"
				>
					<Pencil className="h-3 w-3" />
				</button>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onDelete();
					}}
					className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
				>
					<Trash2 className="h-3 w-3" />
				</button>
			</span>
		</div>
	);
}
