import type { ConversationSummary } from "@/lib/api";
import { deleteConversation } from "@/lib/api";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function useConversationCleanup(
	conversations: ConversationSummary[],
	conversationsFetching: boolean,
	activeConversationId: string | undefined | null,
	sessionId: string,
	queryClient: QueryClient,
) {
	useEffect(() => {
		if (conversations.length === 0 || conversationsFetching) return;
		const toDelete = conversations.filter((c) => {
			if (c.messageCount !== 0) return false;
			if (c.id === activeConversationId) return false;
			const ageMs = Date.now() - new Date(c.createdAt).getTime();
			if (ageMs < 10_000) return false;
			const saved = sessionStorage.getItem(`chat-draft::${c.id}`);
			if (saved) {
				try {
					const draft = JSON.parse(saved);
					if (draft.text?.trim() || draft.attachments?.length > 0) return false;
				} catch {
					// ignore
				}
			}
			return true;
		});
		if (toDelete.length === 0) return;
		Promise.all(toDelete.map((c) => deleteConversation(c.id).catch(() => {}))).then(() => {
			queryClient.invalidateQueries({ queryKey: ["conversations", sessionId] });
		});
	}, [conversations, conversationsFetching, activeConversationId, sessionId, queryClient]);
}
