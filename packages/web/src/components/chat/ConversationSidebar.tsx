import {
	type ConversationSummary,
	createConversation,
	deleteConversation,
	fetchConversations,
} from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ConversationItem } from "./ConversationItem.js";

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
		<div className="flex h-full w-64 min-w-64 flex-col border-r border-border bg-muted/30">
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
