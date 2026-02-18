import { useChatHistory } from "@/hooks/useChatHistory.js";
import { useChatZoom } from "@/hooks/useChatZoom.js";
import { useStreamReconnect } from "@/hooks/useStreamReconnect.js";
import { chatAttachmentAdapter, createCramKitChatAdapter } from "@/lib/chat-adapter";
import { AssistantRuntimeProvider, ThreadPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { ChatComposer } from "./ChatComposer.js";
import { DraftPersistence, ExportButton } from "./ComposerComponents.js";
import { AssistantMessage, EditComposer, UserMessage } from "./MessageComponents.js";
import { ReconnectStreamView } from "./ReconnectStreamView.js";

export function ChatThread({
	sessionId,
	conversationId,
	sessionName,
	onStreamReconnected,
}: {
	sessionId: string;
	conversationId: string;
	sessionName: string;
	onStreamReconnected?: () => void;
}) {
	const queryClient = useQueryClient();

	const adapterStreamingRef = useRef(false);
	const adapter = useMemo(() => {
		const base = createCramKitChatAdapter(sessionId, conversationId);
		return {
			...base,
			async *run(options: Parameters<typeof base.run>[0]) {
				adapterStreamingRef.current = true;
				try {
					const result = base.run(options);
					if (Symbol.asyncIterator in result) {
						let first = true;
						for await (const chunk of result) {
							if (first) {
								first = false;
								// The backend persists the user message before streaming
								// starts. Refresh conversations now so messageCount is
								// up-to-date — prevents useConversationCleanup from
								// deleting this conversation if the user switches away
								// during a long-running stream.
								queryClient.invalidateQueries({
									queryKey: ["conversations", sessionId],
								});
							}
							yield chunk;
						}
					} else {
						yield await result;
					}
				} finally {
					adapterStreamingRef.current = false;
					// Refetch conversations to pick up LLM-generated title
					queryClient.invalidateQueries({
						queryKey: ["conversations", sessionId],
					});
				}
			},
		};
	}, [sessionId, conversationId, queryClient]);

	const history = useChatHistory(conversationId, sessionId, queryClient);

	const runtime = useLocalRuntime(adapter, {
		adapters: { attachments: chatAttachmentAdapter, history },
	});

	const { reconnectStream, reconnectViewportRef } = useStreamReconnect(
		conversationId,
		adapterStreamingRef,
		onStreamReconnected,
	);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				try {
					runtime.thread.cancelRun();
				} catch {
					// Not streaming, ignore
				}
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [runtime]);

	const { zoom, zoomIn, zoomOut, resetZoom, canZoomIn, canZoomOut, isDefault } = useChatZoom();

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<DraftPersistence conversationId={conversationId} />
			<div className="flex h-full min-h-0 flex-col">
				<div className="flex items-center justify-end gap-2 px-4 py-1">
					{!isDefault && (
						<button
							type="button"
							onClick={resetZoom}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							title="Reset to 100%"
						>
							<RotateCcw className="h-3 w-3" />
						</button>
					)}
					<div className="flex items-center gap-0.5 rounded-lg border border-border bg-background px-1">
						<button
							type="button"
							onClick={zoomOut}
							disabled={!canZoomOut}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none"
							title="Zoom out"
						>
							<Minus className="h-3.5 w-3.5" />
						</button>
						<button
							type="button"
							onClick={resetZoom}
							className="w-[3.25rem] px-1 py-0.5 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground transition-colors"
							title="Reset zoom"
						>
							{zoom}%
						</button>
						<button
							type="button"
							onClick={zoomIn}
							disabled={!canZoomIn}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none"
							title="Zoom in"
						>
							<Plus className="h-3.5 w-3.5" />
						</button>
					</div>
					<ExportButton sessionName={sessionName} conversationId={conversationId} />
				</div>

				<ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<ThreadPrimitive.Viewport
						ref={reconnectViewportRef}
						className="min-h-0 flex-1 overflow-y-auto scroll-smooth"
						style={{ zoom: zoom / 100 }}
					>
						<ThreadPrimitive.Empty>
							<div className="flex h-full items-center justify-center">
								<p className="text-muted-foreground">
									Ask me anything about your study materials...
								</p>
							</div>
						</ThreadPrimitive.Empty>
						<ThreadPrimitive.Messages
							components={{
								UserMessage,
								AssistantMessage,
								EditComposer,
							}}
						/>
						{reconnectStream && <ReconnectStreamView stream={reconnectStream} />}
					</ThreadPrimitive.Viewport>

					<ThreadPrimitive.ScrollToBottom className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background p-2 shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all z-10 disabled:pointer-events-none disabled:opacity-0">
						<ChevronDown className="h-4 w-4" />
					</ThreadPrimitive.ScrollToBottom>

					<ChatComposer />
				</ThreadPrimitive.Root>
			</div>
		</AssistantRuntimeProvider>
	);
}
