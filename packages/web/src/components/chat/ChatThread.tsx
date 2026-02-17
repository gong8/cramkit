import { useChatHistory } from "@/hooks/useChatHistory.js";
import { useStreamReconnect } from "@/hooks/useStreamReconnect.js";
import { chatAttachmentAdapter, createCramKitChatAdapter } from "@/lib/chat-adapter";
import { AssistantRuntimeProvider, ThreadPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
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
						yield* result;
					} else {
						yield await result;
					}
				} finally {
					adapterStreamingRef.current = false;
				}
			},
		};
	}, [sessionId, conversationId]);

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

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<DraftPersistence conversationId={conversationId} />
			<div className="flex h-full min-h-0 flex-col">
				<div className="flex justify-end px-4 py-1">
					<ExportButton sessionName={sessionName} conversationId={conversationId} />
				</div>

				<ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<ThreadPrimitive.Viewport
						ref={reconnectViewportRef}
						className="min-h-0 flex-1 overflow-y-auto scroll-smooth"
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
