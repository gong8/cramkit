import type { ReconnectStream } from "@/components/chat/ReconnectStreamView.js";
import { fetchStreamStatus } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";

export function useStreamReconnect(
	conversationId: string,
	adapterStreamingRef: React.RefObject<boolean>,
	onStreamReconnected?: () => void,
) {
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
	}, [conversationId, adapterStreamingRef, onStreamReconnected]);

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

	return { reconnectStream, reconnectViewportRef };
}
