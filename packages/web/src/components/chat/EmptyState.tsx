import { createConversation } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus } from "lucide-react";

export function EmptyState({
	sessionId,
	onCreated,
}: {
	sessionId: string;
	onCreated: (id: string) => void;
}) {
	const queryClient = useQueryClient();

	const createMutation = useMutation({
		mutationFn: () => createConversation(sessionId),
		onSuccess: (conv) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			onCreated(conv.id);
		},
	});

	return (
		<div className="flex h-full flex-col items-center justify-center gap-4">
			<MessageSquare className="h-12 w-12 text-muted-foreground/40" />
			<div className="text-center">
				<p className="text-sm text-muted-foreground">Select a conversation or start a new one</p>
			</div>
			<button
				type="button"
				onClick={() => createMutation.mutate()}
				disabled={createMutation.isPending}
				className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
			>
				<Plus className="h-4 w-4" />
				New chat
			</button>
		</div>
	);
}
