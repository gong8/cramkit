import type { PrismaClient } from "@cramkit/shared";
import { createLogger } from "@cramkit/shared";
import type { ToolCallData } from "./cli-chat.js";

const log = createLogger("api");

/** A single SSE event to buffer for reconnection */
interface BufferedEvent {
	event: string;
	data: string;
}

type Subscriber = (event: string, data: string) => void;

export interface ActiveStream {
	conversationId: string;
	events: BufferedEvent[];
	status: "streaming" | "complete" | "error";
	fullContent: string;
	toolCallsData: ToolCallData[];
	subscribers: Set<Subscriber>;
	done: Promise<void>;
}

/** Strip leaked <tool_call>/<tool_result> XML from text content */
function stripToolCallXml(text: string): string {
	return text
		.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
		.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const CLEANUP_DELAY_MS = 60_000;

const activeStreams = new Map<string, ActiveStream>();

/**
 * Start a background stream consumer that reads from a CLI ReadableStream,
 * buffers SSE events, persists the result to DB on completion, and notifies
 * any subscribed SSE clients.
 */
export function startStream(
	conversationId: string,
	cliStream: ReadableStream<Uint8Array>,
	db: PrismaClient,
): ActiveStream {
	// Guard: return existing stream if one is already running for this conversation
	const existing = activeStreams.get(conversationId);
	if (existing && existing.status === "streaming") {
		log.warn(`stream-manager — stream already active for ${conversationId}, returning existing`);
		return existing;
	}

	const stream: ActiveStream = {
		conversationId,
		events: [],
		status: "streaming",
		fullContent: "",
		toolCallsData: [],
		subscribers: new Set(),
		done: Promise.resolve(), // replaced below
	};

	const toolCallIndex = new Map<string, number>();

	function emit(event: string, data: string): void {
		stream.events.push({ event, data });
		for (const cb of stream.subscribers) {
			try {
				cb(event, data);
			} catch {
				// subscriber errored, ignore
			}
		}
	}

	stream.done = (async () => {
		const reader = cliStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEventType = "content";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

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
							// Persist assistant message
							if (stream.fullContent || stream.toolCallsData.length > 0) {
								try {
									await db.message.create({
										data: {
											conversationId,
											role: "assistant",
											content: stripToolCallXml(stream.fullContent),
											toolCalls:
												stream.toolCallsData.length > 0
													? JSON.stringify(stream.toolCallsData)
													: null,
										},
									});
									await db.conversation.update({
										where: { id: conversationId },
										data: { updatedAt: new Date() },
									});
								} catch (e) {
									log.warn(
										`Failed to persist assistant message — conversation ${conversationId} may have been deleted`,
										e,
									);
								}
							}
							stream.status = "complete";
							emit("done", "[DONE]");
							return;
						}

						try {
							const parsed = JSON.parse(data);

							switch (currentEventType) {
								case "content": {
									if (parsed.content) {
										stream.fullContent += parsed.content;
										emit("content", JSON.stringify({ content: parsed.content }));
									}
									break;
								}

								case "tool_call_start": {
									const { toolCallId, toolName } = parsed;
									const idx = stream.toolCallsData.length;
									stream.toolCallsData.push({ toolCallId, toolName, args: {} });
									toolCallIndex.set(toolCallId, idx);
									emit("tool_call_start", JSON.stringify({ toolCallId, toolName }));
									break;
								}

								case "tool_call_args": {
									const { toolCallId, toolName, args } = parsed;
									const idx = toolCallIndex.get(toolCallId);
									if (idx !== undefined) {
										stream.toolCallsData[idx].args = args;
									}
									emit("tool_call_args", JSON.stringify({ toolCallId, toolName, args }));
									break;
								}

								case "tool_result": {
									const { toolCallId, result, isError } = parsed;
									const idx = toolCallIndex.get(toolCallId);
									if (idx !== undefined) {
										stream.toolCallsData[idx].result = result;
										stream.toolCallsData[idx].isError = isError;
									}
									emit("tool_result", JSON.stringify({ toolCallId, result, isError }));
									break;
								}

								case "thinking_start": {
									emit("thinking_start", JSON.stringify({}));
									break;
								}

								case "thinking_delta": {
									emit("thinking_delta", JSON.stringify({ text: parsed.text }));
									break;
								}

								case "error": {
									if (parsed.error) {
										emit("error", JSON.stringify({ error: parsed.error }));
									}
									break;
								}
							}
						} catch {
							// Skip unparseable
						}

						currentEventType = "content";
					}
				}
			}

			// Stream ended without [DONE] — persist partial content
			if (stream.fullContent || stream.toolCallsData.length > 0) {
				try {
					await db.message.create({
						data: {
							conversationId,
							role: "assistant",
							content: stripToolCallXml(stream.fullContent),
							toolCalls:
								stream.toolCallsData.length > 0 ? JSON.stringify(stream.toolCallsData) : null,
						},
					});
					await db.conversation.update({
						where: { id: conversationId },
						data: { updatedAt: new Date() },
					});
				} catch {
					// conversation deleted
				}
			}
			stream.status = "complete";
			emit("done", "[DONE]");
		} catch (error) {
			log.error("stream-manager — streaming error", error);
			// Persist partial content on error
			if (stream.fullContent || stream.toolCallsData.length > 0) {
				try {
					await db.message.create({
						data: {
							conversationId,
							role: "assistant",
							content: stripToolCallXml(stream.fullContent),
							toolCalls:
								stream.toolCallsData.length > 0 ? JSON.stringify(stream.toolCallsData) : null,
						},
					});
				} catch {
					// ignore
				}
			}
			stream.status = "error";
			emit("error", JSON.stringify({ error: "Stream failed" }));
			emit("done", "[DONE]");
		} finally {
			reader.releaseLock();
			// Clean up from map after a delay
			setTimeout(() => {
				activeStreams.delete(conversationId);
				log.info(`stream-manager — cleaned up stream for ${conversationId}`);
			}, CLEANUP_DELAY_MS);
		}
	})();

	activeStreams.set(conversationId, stream);
	log.info(`stream-manager — started stream for ${conversationId}`);
	return stream;
}

/** Get an active stream if one exists */
export function getStream(conversationId: string): ActiveStream | undefined {
	return activeStreams.get(conversationId);
}

export interface SubscribeHandle {
	/** Unsubscribe from the stream */
	unsubscribe: () => void;
	/** Resolves when all events (replay + live) have been delivered to the callback */
	delivered: Promise<void>;
}

/**
 * Subscribe to a stream. Sends all buffered events first, then live events.
 * Uses an internal queue to ensure ordered delivery even when the callback is async.
 * Returns a handle with unsubscribe + delivered promise, or null if no stream exists.
 */
export function subscribe(conversationId: string, cb: Subscriber): SubscribeHandle | null {
	const stream = activeStreams.get(conversationId);
	if (!stream) return null;

	// Queue-based delivery ensures events are sent in order, even for async callbacks
	const queue: BufferedEvent[] = [];
	let draining = false;
	let active = true;
	let resolveDelivered: () => void;
	const delivered = new Promise<void>((resolve) => {
		resolveDelivered = resolve;
	});

	async function drain() {
		if (draining) return;
		draining = true;
		while (queue.length > 0 && active) {
			const evt = queue.shift();
			if (!evt) break;
			try {
				await cb(evt.event, evt.data);
			} catch {
				// subscriber errored, ignore
			}
		}
		draining = false;
		// If the stream is done and we've delivered everything, resolve
		if (stream && stream.status !== "streaming" && queue.length === 0) {
			resolveDelivered();
		}
	}

	function enqueue(event: string, data: string) {
		queue.push({ event, data });
		drain();
	}

	// Replay buffered events through the queue
	for (const { event, data } of stream.events) {
		enqueue(event, data);
	}

	// If already complete, just let the queue drain — no live subscription needed
	if (stream.status !== "streaming") {
		return {
			unsubscribe: () => {
				active = false;
				resolveDelivered();
			},
			delivered,
		};
	}

	// Add live subscriber that goes through the queue for ordered delivery
	stream.subscribers.add(enqueue);
	return {
		unsubscribe: () => {
			active = false;
			stream.subscribers.delete(enqueue);
			resolveDelivered();
		},
		delivered,
	};
}
