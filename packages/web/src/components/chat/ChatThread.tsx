import type { ToolCallData } from "@/lib/api";
import { fetchMessages, fetchStreamStatus } from "@/lib/api";
import { chatAttachmentAdapter, createCramKitChatAdapter } from "@/lib/chat-adapter";
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	ThreadPrimitive,
	useLocalRuntime,
} from "@assistant-ui/react";
import type { ThreadHistoryAdapter } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Paperclip, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ComposerImageAttachment,
	DraftPersistence,
	ExportButton,
	StopButton,
} from "./ComposerComponents.js";
import { AssistantMessage, EditComposer, UserMessage } from "./MessageComponents.js";
import { type ReconnectStream, ReconnectStreamView } from "./ReconnectStreamView.js";

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

	const history = useMemo(
		() =>
			({
				async load() {
					const messages = await fetchMessages(conversationId);

					const repoMessages = messages.map((m, i) => {
						const contentParts: Array<
							| { type: "text"; text: string }
							| { type: "image"; image: string }
							| {
									type: "tool-call";
									toolCallId: string;
									toolName: string;
									args: Record<string, unknown>;
									argsText: string;
									result?: string;
									isError?: boolean;
							  }
						> = [];

						if (m.attachments && m.attachments.length > 0) {
							for (const att of m.attachments) {
								contentParts.push({
									type: "image",
									image: `/api/chat/attachments/${att.id}`,
								});
							}
						}

						if (m.toolCalls) {
							try {
								const toolCalls: ToolCallData[] = JSON.parse(m.toolCalls);
								for (const tc of toolCalls) {
									contentParts.push({
										type: "tool-call",
										toolCallId: tc.toolCallId,
										toolName: tc.toolName,
										args: tc.args,
										argsText: JSON.stringify(tc.args),
										result: tc.result,
										isError: tc.isError,
									});
								}
							} catch {
								// Invalid tool calls JSON, skip
							}
						}

						const callRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
						const resultRe = /<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g;
						const xmlCalls: Array<{
							name: string;
							args: Record<string, unknown>;
						}> = [];
						const xmlResults: string[] = [];
						let rm: RegExpExecArray | null;
						rm = callRe.exec(m.content);
						while (rm !== null) {
							try {
								const parsed = JSON.parse(rm[1]);
								xmlCalls.push({
									name: parsed.name,
									args: parsed.arguments || {},
								});
							} catch {
								/* skip */
							}
							rm = callRe.exec(m.content);
						}
						rm = resultRe.exec(m.content);
						while (rm !== null) {
							xmlResults.push(rm[1].trim());
							rm = resultRe.exec(m.content);
						}
						for (let j = 0; j < xmlCalls.length; j++) {
							contentParts.push({
								type: "tool-call",
								toolCallId: `hist_tc_${i}_${j}`,
								toolName: xmlCalls[j].name,
								args: xmlCalls[j].args,
								argsText: JSON.stringify(xmlCalls[j].args),
								result: xmlResults[j],
								isError: false,
							});
						}

						const cleanContent = m.content
							.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
							.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
							.replace(/\n{3,}/g, "\n\n")
							.trim();
						contentParts.push({ type: "text", text: cleanContent });

						return {
							message: {
								id: m.id,
								role: m.role,
								content: contentParts,
								createdAt: new Date(m.createdAt),
								status: {
									type: "complete",
									reason: "stop",
								} as const,
								attachments: [],
								metadata: { steps: [], custom: {} },
							},
							parentId: i === 0 ? null : messages[i - 1].id,
						};
					});

					return {
						headId: messages.length > 0 ? messages[messages.length - 1].id : null,
						messages: repoMessages,
					};
				},
				async append() {
					queryClient.invalidateQueries({
						queryKey: ["conversations", sessionId],
					});
				},
			}) as unknown as ThreadHistoryAdapter,
		[conversationId, sessionId, queryClient],
	);

	const runtime = useLocalRuntime(adapter, {
		adapters: { attachments: chatAttachmentAdapter, history },
	});

	// Reconnect to an active background stream
	const [reconnectStream, setReconnectStream] = useState<ReconnectStream | null>(null);
	const reconnectViewportRef = useRef<HTMLDivElement>(null);
	const reconnectAbortRef = useRef<AbortController | null>(null);
	const wasStreamingRef = useRef(false);

	const doReconnect = useCallback(async () => {
		if (adapterStreamingRef.current) return;

		reconnectAbortRef.current?.abort();
		const abort = new AbortController();
		reconnectAbortRef.current = abort;

		try {
			const status = await fetchStreamStatus(conversationId);
			if (abort.signal.aborted || adapterStreamingRef.current) return;

			if (!status.active || status.status !== "streaming") {
				if (wasStreamingRef.current) {
					wasStreamingRef.current = false;
					setReconnectStream(null);
					onStreamReconnected?.();
				}
				return;
			}

			const response = await fetch(`/api/chat/conversations/${conversationId}/stream-reconnect`, {
				method: "POST",
				signal: abort.signal,
			});

			if (!response.ok || abort.signal.aborted) return;

			const reader = response.body?.getReader();
			if (!reader) return;

			const state: ReconnectStream = {
				content: "",
				toolCalls: new Map(),
				thinkingText: "",
				done: false,
			};
			wasStreamingRef.current = true;
			setReconnectStream({ ...state });

			const decoder = new TextDecoder();
			let buffer = "";
			let currentEventType = "content";

			while (!abort.signal.aborted) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				let updated = false;

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					if (trimmed.startsWith("event: ")) {
						currentEventType = trimmed.slice(7);
						continue;
					}

					if (trimmed.startsWith("data: ")) {
						const data = trimmed.slice(6);
						if (data === "[DONE]") {
							state.done = true;
							break;
						}

						try {
							const parsed = JSON.parse(data);
							switch (currentEventType) {
								case "content":
									if (parsed.content) {
										state.content += parsed.content;
										updated = true;
									}
									break;
								case "tool_call_start": {
									const { toolCallId, toolName } = parsed;
									state.toolCalls.set(toolCallId, {
										toolCallId,
										toolName,
									});
									updated = true;
									break;
								}
								case "tool_call_args": {
									const { toolCallId, args } = parsed;
									const tc = state.toolCalls.get(toolCallId);
									if (tc) tc.args = args;
									updated = true;
									break;
								}
								case "tool_result": {
									const { toolCallId, result, isError } = parsed;
									const tc = state.toolCalls.get(toolCallId);
									if (tc) {
										tc.result = result;
										tc.isError = isError;
									}
									updated = true;
									break;
								}
								case "thinking_delta":
									if (parsed.text) {
										state.thinkingText += parsed.text;
										updated = true;
									}
									break;
							}
						} catch {
							// skip unparseable
						}
						currentEventType = "content";
					}
				}

				if (updated && !abort.signal.aborted) {
					setReconnectStream({
						...state,
						toolCalls: new Map(state.toolCalls),
					});
					const vp = reconnectViewportRef.current;
					if (vp) {
						const nearBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80;
						if (nearBottom) {
							vp.scrollTo({ top: vp.scrollHeight });
						}
					}
				}

				if (state.done) break;
			}

			if (!abort.signal.aborted) {
				wasStreamingRef.current = false;
				setReconnectStream(null);
				onStreamReconnected?.();
			}
		} catch {
			if (!abort.signal.aborted) {
				wasStreamingRef.current = false;
				setReconnectStream(null);
			}
		}
	}, [conversationId, onStreamReconnected]);

	useEffect(() => {
		doReconnect();
		return () => {
			reconnectAbortRef.current?.abort();
		};
	}, [doReconnect]);

	useEffect(() => {
		function handleVisibilityChange() {
			if (document.visibilityState === "visible") {
				doReconnect();
			}
		}
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [doReconnect]);

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

					<div className="shrink-0 border-t border-border p-4">
						<ComposerPrimitive.Root className="rounded-xl border border-input bg-background">
							<ComposerPrimitive.Attachments
								components={{
									Image: ComposerImageAttachment,
									File: ComposerImageAttachment,
									Attachment: ComposerImageAttachment,
								}}
							/>
							<div className="flex items-center gap-2 px-3 py-2">
								<ComposerPrimitive.AddAttachment className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
									<Paperclip className="h-4 w-4" />
								</ComposerPrimitive.AddAttachment>
								<ComposerPrimitive.Input
									placeholder="Type a message..."
									className="flex-1 resize-none bg-transparent text-sm outline-none"
									autoFocus
								/>
								<ThreadPrimitive.If running>
									<StopButton />
								</ThreadPrimitive.If>
								<ThreadPrimitive.If running={false}>
									<ComposerPrimitive.Send className="rounded-lg bg-primary p-2 text-primary-foreground hover:opacity-90 disabled:opacity-50">
										<Send className="h-4 w-4" />
									</ComposerPrimitive.Send>
								</ThreadPrimitive.If>
							</div>
						</ComposerPrimitive.Root>
					</div>
				</ThreadPrimitive.Root>
			</div>
		</AssistantRuntimeProvider>
	);
}
