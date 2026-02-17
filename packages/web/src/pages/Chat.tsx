import {
	createConversation,
	deleteConversation,
	fetchConversations,
	fetchSession,
} from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "katex/dist/katex.min.css";
import { ChatThread } from "@/components/chat/ChatThread.js";
import { ConversationSidebar } from "@/components/chat/ConversationSidebar.js";
import { ArrowLeft, MessageSquare, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

// ─── Empty State ───

function EmptyState({
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

// ─── Main Chat Page ───

export function Chat() {
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);

	const { id, conversationId: paramConvId } = useParams<{
		id: string;
		conversationId?: string;
	}>();
	const sessionId = id as string;
	const [searchParams, setSearchParams] = useSearchParams();
	const queryClient = useQueryClient();
	const activeConversationId = paramConvId || searchParams.get("c");

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
		refetchOnWindowFocus: false,
	});

	const { data: conversations = [], isFetching: conversationsFetching } = useQuery({
		queryKey: ["conversations", sessionId],
		queryFn: () => fetchConversations(sessionId),
		enabled: !!sessionId,
		refetchOnWindowFocus: false,
	});

	const navigate = useNavigate();

	useEffect(() => {
		if (!activeConversationId || conversationsFetching) return;
		const exists = conversations.some((c) => c.id === activeConversationId);
		if (!exists) {
			if (conversations.length > 0) {
				setSearchParams({ c: conversations[0].id }, { replace: true });
			} else {
				navigate(`/session/${sessionId}/chat`, { replace: true });
			}
		}
	}, [
		activeConversationId,
		conversations,
		conversationsFetching,
		sessionId,
		setSearchParams,
		navigate,
	]);

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

	const [threadReloadKey, setThreadReloadKey] = useState(0);
	const handleStreamReconnected = useCallback(() => {
		setThreadReloadKey((k) => k + 1);
	}, []);

	const handleSelectConversation = useCallback(
		(convId: string) => {
			setSearchParams({ c: convId });
		},
		[setSearchParams],
	);

	if (isLoading) {
		return (
			<div className="flex h-screen items-center justify-center">
				<p className="text-muted-foreground">Loading...</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
				<Link
					to={`/session/${sessionId}`}
					className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<ArrowLeft className="h-5 w-5" />
				</Link>
				<div>
					<h1 className="text-sm font-semibold">{session?.name || "Chat"}</h1>
					{session?.module && <p className="text-xs text-muted-foreground">{session.module}</p>}
				</div>
			</div>

			<div className="flex min-h-0 flex-1 overflow-hidden">
				<ConversationSidebar
					sessionId={sessionId}
					activeId={activeConversationId}
					onSelect={handleSelectConversation}
				/>

				<div className="min-h-0 flex-1 overflow-hidden">
					{activeConversationId ? (
						<ChatThread
							key={`${activeConversationId}-${threadReloadKey}`}
							sessionId={sessionId}
							conversationId={activeConversationId}
							sessionName={session?.name || "Chat"}
							onStreamReconnected={handleStreamReconnected}
						/>
					) : (
						<EmptyState sessionId={sessionId} onCreated={handleSelectConversation} />
					)}
				</div>
			</div>
		</div>
	);
}
