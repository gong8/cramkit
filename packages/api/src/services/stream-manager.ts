import type { PrismaClient } from "@cramkit/shared";
import { createLogger } from "@cramkit/shared";
import type { ToolCallData } from "./cli-chat.js";
import { LineBuffer } from "./line-buffer.js";

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

/** Persist the assistant message and update the conversation timestamp */
async function persistMessage(
	db: PrismaClient,
	conversationId: string,
	content: string,
	toolCallsData: ToolCallData[],
): Promise<void> {
	await db.message.create({
		data: {
			conversationId,
			role: "assistant",
			content: stripToolCallXml(content),
			toolCalls: toolCallsData.length > 0 ? JSON.stringify(toolCallsData) : null,
		},
	});
	await db.conversation.update({
		where: { id: conversationId },
		data: { updatedAt: new Date() },
	});
}

/** Safely persist, swallowing errors (e.g. if the conversation was deleted) */
async function safePersist(
	db: PrismaClient,
	conversationId: string,
	stream: ActiveStream,
): Promise<void> {
	if (!stream.fullContent && stream.toolCallsData.length === 0) return;
	try {
		await persistMessage(db, conversationId, stream.fullContent, stream.toolCallsData);
	} catch (e) {
		log.warn(
			`Failed to persist assistant message — conversation ${conversationId} may have been deleted`,
			e,
		);
	}
}

/** Update stream state from a parsed event and re-emit to subscribers */
function dispatchEvent(
	stream: ActiveStream,
	toolCallIndex: Map<string, number>,
	emit: (event: string, data: string) => void,
	eventType: string,
	parsed: Record<string, unknown>,
): void {
	switch (eventType) {
		case "content":
			if (parsed.content) stream.fullContent += parsed.content;
			break;

		case "tool_call_start": {
			const idx = stream.toolCallsData.length;
			stream.toolCallsData.push({
				toolCallId: parsed.toolCallId as string,
				toolName: parsed.toolName as string,
				args: {},
			});
			toolCallIndex.set(parsed.toolCallId as string, idx);
			break;
		}

		case "tool_call_args": {
			const idx = toolCallIndex.get(parsed.toolCallId as string);
			if (idx !== undefined) {
				stream.toolCallsData[idx].args = parsed.args as Record<string, unknown>;
			}
			break;
		}

		case "tool_result": {
			const idx = toolCallIndex.get(parsed.toolCallId as string);
			if (idx !== undefined) {
				stream.toolCallsData[idx].result = parsed.result as string;
				stream.toolCallsData[idx].isError = parsed.isError as boolean;
			}
			break;
		}
	}

	// All event types (including thinking_start, thinking_delta, error) are
	// forwarded as-is. State updates above only apply to the relevant types.
	emit(eventType, JSON.stringify(parsed));
}

/** Parse a single SSE line pair, returning the event type and data, or null */
function parseSSELine(
	line: string,
	currentEventType: { value: string },
): { type: string; data: string } | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("event: ")) {
		currentEventType.value = trimmed.slice(7);
		return null;
	}

	if (!trimmed.startsWith("data: ")) return null;
	const data = trimmed.slice(6);
	const type = currentEventType.value;
	currentEventType.value = "content";
	return { type, data };
}

/** Read the CLI stream, dispatch events, and persist on completion */
async function consumeStream(
	stream: ActiveStream,
	cliStream: ReadableStream<Uint8Array>,
	db: PrismaClient,
	emit: (event: string, data: string) => void,
): Promise<void> {
	const reader = cliStream.getReader();
	const decoder = new TextDecoder();
	const toolCallIndex = new Map<string, number>();
	const lineBuffer = new LineBuffer();
	const currentEventType = { value: "content" };

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			for (const line of lineBuffer.push(decoder.decode(value, { stream: true }))) {
				const parsed = parseSSELine(line, currentEventType);
				if (!parsed) continue;

				if (parsed.data === "[DONE]") {
					await safePersist(db, stream.conversationId, stream);
					stream.status = "complete";
					emit("done", "[DONE]");
					return;
				}

				try {
					const obj = JSON.parse(parsed.data);
					dispatchEvent(stream, toolCallIndex, emit, parsed.type, obj);
				} catch {
					// Skip unparseable
				}
			}
		}

		// Stream ended without [DONE]
		await safePersist(db, stream.conversationId, stream);
		stream.status = "complete";
		emit("done", "[DONE]");
	} catch (error) {
		log.error("stream-manager — streaming error", error);
		await safePersist(db, stream.conversationId, stream);
		stream.status = "error";
		emit("error", JSON.stringify({ error: "Stream failed" }));
		emit("done", "[DONE]");
	} finally {
		reader.releaseLock();
		setTimeout(() => {
			activeStreams.delete(stream.conversationId);
			log.info(`stream-manager — cleaned up stream for ${stream.conversationId}`);
		}, CLEANUP_DELAY_MS);
	}
}

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
		done: Promise.resolve(),
	};

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

	stream.done = consumeStream(stream, cliStream, db, emit);

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
 * Ordered async event delivery queue.
 * Ensures events are delivered sequentially even when the callback is async.
 */
function createEventQueue(cb: Subscriber, onDrained: () => void) {
	const queue: BufferedEvent[] = [];
	let draining = false;
	let active = true;

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
		onDrained();
	}

	return {
		enqueue(event: string, data: string) {
			queue.push({ event, data });
			drain();
		},
		stop() {
			active = false;
		},
		get isEmpty() {
			return queue.length === 0;
		},
	};
}

/**
 * Subscribe to a stream. Sends all buffered events first, then live events.
 * Uses an internal queue to ensure ordered delivery even when the callback is async.
 * Returns a handle with unsubscribe + delivered promise, or null if no stream exists.
 */
export function subscribe(conversationId: string, cb: Subscriber): SubscribeHandle | null {
	const stream = activeStreams.get(conversationId);
	if (!stream) return null;

	let resolveDelivered: () => void;
	const delivered = new Promise<void>((resolve) => {
		resolveDelivered = resolve;
	});

	const eq = createEventQueue(cb, () => {
		if (stream.status !== "streaming" && eq.isEmpty) {
			resolveDelivered();
		}
	});

	// Replay buffered events
	for (const { event, data } of stream.events) {
		eq.enqueue(event, data);
	}

	// If already complete, just let the queue drain
	if (stream.status !== "streaming") {
		return {
			unsubscribe: () => {
				eq.stop();
				resolveDelivered();
			},
			delivered,
		};
	}

	// Live subscriber goes through the queue for ordered delivery
	stream.subscribers.add(eq.enqueue);
	return {
		unsubscribe: () => {
			eq.stop();
			stream.subscribers.delete(eq.enqueue);
			resolveDelivered();
		},
		delivered,
	};
}
