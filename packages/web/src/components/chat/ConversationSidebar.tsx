import {
	type ConversationSummary,
	createConversation,
	deleteConversation,
	renameConversation,
} from "@/lib/api";
import { fetchConversations } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// ─── Date grouping ───

function groupByDate(conversations: ConversationSummary[]) {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86400000);
	const weekAgo = new Date(today.getTime() - 7 * 86400000);

	const groups: { label: string; items: ConversationSummary[] }[] = [
		{ label: "Today", items: [] },
		{ label: "Yesterday", items: [] },
		{ label: "This week", items: [] },
		{ label: "Older", items: [] },
	];

	for (const c of conversations) {
		const d = new Date(c.updatedAt);
		if (d >= today) groups[0].items.push(c);
		else if (d >= yesterday) groups[1].items.push(c);
		else if (d >= weekAgo) groups[2].items.push(c);
		else groups[3].items.push(c);
	}

	return groups.filter((g) => g.items.length > 0);
}

// ─── Conversation Item ───

function ConversationItem({
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
		<button
			type="button"
			onClick={onSelect}
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
		</button>
	);
}

// ─── Conversation Sidebar ───

export function ConversationSidebar({
	sessionId,
	activeId,
	onSelect,
}: {
	sessionId: string;
	activeId: string | null;
	onSelect: (id: string) => void;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const { data: conversations = [] } = useQuery({
		queryKey: ["conversations", sessionId],
		queryFn: () => fetchConversations(sessionId),
	});

	const createMutation = useMutation({
		mutationFn: () => createConversation(sessionId),
		onSuccess: (conv) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			onSelect(conv.id);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteConversation,
		onSuccess: (_, deletedId) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			if (activeId === deletedId) {
				const remaining = conversations.filter((c) => c.id !== deletedId);
				if (remaining.length > 0) {
					onSelect(remaining[0].id);
				} else {
					navigate(`/session/${sessionId}/chat`);
				}
			}
		},
	});

	const groups = groupByDate(conversations);

	return (
		<div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/30">
			<div className="p-3">
				<button
					type="button"
					onClick={() => createMutation.mutate()}
					disabled={createMutation.isPending}
					className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
				>
					<Plus className="h-4 w-4" />
					New chat
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{conversations.length === 0 && (
					<p className="px-2 py-4 text-center text-xs text-muted-foreground">
						No conversations yet
					</p>
				)}

				{groups.map((group) => (
					<div key={group.label} className="mb-3">
						<p className="px-2 py-1 text-xs font-medium text-muted-foreground">{group.label}</p>
						{group.items.map((conv) => (
							<ConversationItem
								key={conv.id}
								conv={conv}
								isActive={activeId === conv.id}
								onSelect={() => onSelect(conv.id)}
								onDelete={() => deleteMutation.mutate(conv.id)}
								sessionId={sessionId}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
