import { fetchConversations, fetchSession } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "katex/dist/katex.min.css";
import { ChatThread } from "@/components/chat/ChatThread.js";
import { ConversationSidebar } from "@/components/chat/ConversationSidebar.js";
import { EmptyState } from "@/components/chat/EmptyState.js";
import { useConversationCleanup } from "@/hooks/useConversationCleanup.js";
import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

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

	useConversationCleanup(
		conversations,
		conversationsFetching,
		activeConversationId,
		sessionId,
		queryClient,
	);

	const [sidebarOpen, setSidebarOpen] = useState(true);
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
				<div className="flex-1">
					<h1 className="text-sm font-semibold">{session?.name || "Chat"}</h1>
					{session?.module && <p className="text-xs text-muted-foreground">{session.module}</p>}
				</div>
				<button
					type="button"
					onClick={() => setSidebarOpen((o) => !o)}
					className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					title={sidebarOpen ? "Hide chat history" : "Show chat history"}
				>
					{sidebarOpen ? (
						<PanelLeftClose className="h-5 w-5" />
					) : (
						<PanelLeftOpen className="h-5 w-5" />
					)}
				</button>
			</div>

			<div className="flex min-h-0 flex-1 overflow-hidden">
				<div
					className={`shrink-0 overflow-hidden transition-[width] duration-200 ${sidebarOpen ? "w-64" : "w-0"}`}
				>
					<ConversationSidebar
						sessionId={sessionId}
						activeId={activeConversationId}
						onSelect={handleSelectConversation}
					/>
				</div>

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
